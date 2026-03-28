import {
  CryptoKeyBundle,
  decrypt,
  encrypt,
  generateKeyBundle,
  importPublicKey,
} from '../crypto/CryptoService';
import { RaftNode, RaftNodeOptions } from '../raft/RaftNode';
import { InMemoryRaftLog } from '../raft/log/InMemoryRaftLog';
import { RaftLog } from '../raft/log/RaftLog';
import { LogEntry, RaftMessage } from '../raft/types';
import { Transport } from '../transport/Transport';

import {
  DandelionMeshEvents,
  EncryptedPrivateMessage,
  MeshControlMessage,
  MeshLogCommand,
  MeshMessage,
  ProposeMessage,
  PublicKeyAnnouncement,
  PublicMessageEntry,
  WireMessage,
} from './types';

type ListenerMap<T> = {
  [E in keyof DandelionMeshEvents<T>]: Set<DandelionMeshEvents<T>[E]>;
};

export interface DandelionMeshOptions {
  /** RSA modulus length in bits (default 4096) */
  modulusLength?: number;
  /** Raft configuration */
  raft?: RaftNodeOptions;
  /** Raft log implementation (default: InMemoryRaftLog) */
  raftLog?: RaftLog<MeshLogCommand>;
  /** Known peer IDs to connect to on startup */
  bootstrapPeers?: string[];
  /**
   * Pre-generated crypto key bundle. When provided, the mesh skips key
   * generation and uses these keys directly. Accepts either a resolved
   * bundle or a Promise (e.g. from a prior `generateKeyBundle()` call).
   * If omitted, a new key pair is generated automatically.
   */
  cryptoKeyBundle?: CryptoKeyBundle | Promise<CryptoKeyBundle>;
}

/**
 * DandelionMesh — a fault-tolerant P2P mesh network for browser applications.
 *
 * Combines three layers:
 * - **Transport** (default: PeerJS) — handles peer-to-peer WebRTC connections.
 * - **Crypto** — RSA-OAEP + AES-256-GCM hybrid encryption for private messages.
 * - **Raft consensus** — leader election and totally-ordered log replication.
 *
 * All application messages (public broadcasts and encrypted private messages)
 * flow through the Raft log, guaranteeing every peer sees the same events in
 * the same order. Non-leader peers forward proposals to the current leader.
 *
 * ## Events
 *
 * | Event            | Payload                              | When                                       |
 * |------------------|--------------------------------------|---------------------------------------------|
 * | `ready`          | `localPeerId: string`                | Transport is open and Raft has started       |
 * | `message`        | `MeshMessage<T>, replay: boolean`    | A committed log entry is delivered           |
 * | `peersChanged`   | `peers: string[]`                    | A peer connects or disconnects               |
 * | `leaderChanged`  | `leaderId: string \| null`           | Raft leader changes                          |
 * | `error`          | `Error`                              | Transport-level error                        |
 *
 * @typeParam T - The application-level payload type for messages.
 *
 * @example
 * ```ts
 * const transport = new PeerJSTransport({ peerId: 'alice' });
 * const mesh = new DandelionMesh<GameAction>(transport, {
 *   bootstrapPeers: ['bob', 'charlie'],
 * });
 *
 * mesh.on('ready', (id) => console.log('My ID:', id));
 * mesh.on('message', (msg) => {
 *   if (msg.type === 'public')  console.log(msg.sender, msg.data);
 *   if (msg.type === 'private') console.log('secret from', msg.sender);
 * });
 *
 * await mesh.sendPublic({ action: 'bet', amount: 100 });
 * await mesh.sendPrivate('bob', { cards: ['Ah', 'Kd'] });
 * ```
 *
 * @example Providing a pre-generated crypto key bundle
 * ```ts
 * const bundle = await generateKeyBundle(2048);
 * const mesh = new DandelionMesh(transport, { cryptoKeyBundle: bundle });
 * ```
 */
export class DandelionMesh<T = unknown> {
  private readonly transport: Transport;
  private readonly raftLog: RaftLog<MeshLogCommand<T>>;
  private raftNode: RaftNode<MeshLogCommand<T>> | null = null;

  private localPeerId: string | undefined;
  private readonly cryptoReady: Promise<CryptoKeyBundle>;
  private cryptoBundle: CryptoKeyBundle | null = null;
  private readonly peerPublicKeys = new Map<string, Promise<CryptoKey>>();
  private readonly pendingKeyWaiters = new Map<
    string,
    Array<(key: Promise<CryptoKey>) => void>
  >();

  private readonly modulusLength: number;
  private readonly raftOptions: RaftNodeOptions;
  private readonly bootstrapPeers: string[];
  private lastAppliedIndex = 0;

  private readonly listeners: ListenerMap<T> = {
    ready: new Set(),
    message: new Set(),
    peersChanged: new Set(),
    leaderChanged: new Set(),
    error: new Set(),
  };

  constructor(transport: Transport, options?: DandelionMeshOptions) {
    this.transport = transport;
    this.modulusLength = options?.modulusLength ?? 4096;
    this.raftOptions = options?.raft ?? {};
    this.raftLog =
      (options?.raftLog as RaftLog<MeshLogCommand<T>>) ??
      new InMemoryRaftLog<MeshLogCommand<T>>();
    this.bootstrapPeers = options?.bootstrapPeers ?? [];
    this.lastAppliedIndex = this.raftLog.length();

    // Use provided key bundle or generate a new one
    this.cryptoReady = (
      options?.cryptoKeyBundle
        ? Promise.resolve(options.cryptoKeyBundle)
        : generateKeyBundle(this.modulusLength)
    ).then((bundle) => {
      this.cryptoBundle = bundle;
      return bundle;
    });

    // Wire up transport events
    this.transport.on('open', this.onTransportOpen);
    this.transport.on('peerConnected', this.onPeerConnected);
    this.transport.on('peerDisconnected', this.onPeerDisconnected);
    this.transport.on('message', this.onTransportMessage);
    this.transport.on('error', this.onTransportError);
  }

  // --- Public API ---

  /** Send a public (broadcast) message through the Raft cluster */
  async sendPublic(data: T): Promise<boolean> {
    if (!this.raftNode || !this.localPeerId) return false;

    const entry: PublicMessageEntry<T> = {
      _meshType: 'public',
      sender: this.localPeerId,
      data,
    };

    if (this.raftNode.isLeader()) {
      return this.raftNode.propose(entry);
    }

    // Forward to leader
    const leaderId = this.raftNode.getLeaderId();
    if (!leaderId) return false;

    const propose: ProposeMessage<T> = { _meshType: 'propose', command: entry };
    await this.transport.send(leaderId, this.wireMessage('control', propose));
    return true;
  }

  /** Send an encrypted private message through the Raft cluster */
  async sendPrivate(recipientPeerId: string, data: T): Promise<boolean> {
    if (!this.raftNode || !this.localPeerId) return false;

    const recipientKey = await this.getOrAwaitPublicKey(recipientPeerId);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const payload = await encrypt(plaintext, recipientKey);

    const entry: EncryptedPrivateMessage = {
      _meshType: 'encrypted',
      sender: this.localPeerId,
      recipient: recipientPeerId,
      payload,
    };

    if (this.raftNode.isLeader()) {
      return this.raftNode.propose(entry);
    }

    // Forward to leader
    const leaderId = this.raftNode.getLeaderId();
    if (!leaderId) return false;

    const propose: ProposeMessage<T> = { _meshType: 'propose', command: entry };
    await this.transport.send(leaderId, this.wireMessage('control', propose));
    return true;
  }

  /** Get all connected peer IDs (including self) */
  get peers(): string[] {
    const connected = [...this.transport.connectedPeers];
    if (this.localPeerId) connected.unshift(this.localPeerId);
    return connected;
  }

  /** Get the current Raft leader ID */
  get leaderId(): string | null {
    return this.raftNode?.getLeaderId() ?? null;
  }

  /** Whether this node is the Raft leader */
  get isLeader(): boolean {
    return this.raftNode?.isLeader() ?? false;
  }

  /** The local peer ID (available after 'ready') */
  get peerId(): string | undefined {
    return this.localPeerId;
  }

  /** Register an event listener */
  on<E extends keyof DandelionMeshEvents<T>>(
    event: E,
    listener: DandelionMeshEvents<T>[E]
  ): void {
    (this.listeners[event] as Set<DandelionMeshEvents<T>[E]>).add(listener);
  }

  /** Remove an event listener */
  off<E extends keyof DandelionMeshEvents<T>>(
    event: E,
    listener: DandelionMeshEvents<T>[E]
  ): void {
    (this.listeners[event] as Set<DandelionMeshEvents<T>[E]>).delete(listener);
  }

  /** Shut down the mesh: stop Raft, close transport */
  close(): void {
    this.raftNode?.destroy();
    this.transport.off('open', this.onTransportOpen);
    this.transport.off('peerConnected', this.onPeerConnected);
    this.transport.off('peerDisconnected', this.onPeerDisconnected);
    this.transport.off('message', this.onTransportMessage);
    this.transport.off('error', this.onTransportError);
    this.transport.close();
  }

  // --- Transport event handlers ---

  private onTransportOpen = (peerId: string): void => {
    this.localPeerId = peerId;

    // Connect to bootstrap peers
    for (const bp of this.bootstrapPeers) {
      if (bp !== peerId) {
        this.transport.connect(bp);
      }
    }

    // Initialize Raft node
    this.raftNode = new RaftNode<MeshLogCommand<T>>(
      peerId,
      this.raftLog,
      this.raftOptions
    );
    this.raftNode.sendMessage = (toPeerId, message) => {
      this.transport
        .send(toPeerId, this.wireMessage('raft', message))
        .catch(() => {
          // Peer may have disconnected; non-fatal
        });
    };
    this.raftNode.on('committed', this.onRaftCommitted);
    this.raftNode.on('leaderChanged', (leaderId) => {
      this.emit('leaderChanged', leaderId);
    });

    // Start Raft with currently connected peers
    this.raftNode.start(this.transport.connectedPeers as string[]);

    this.emit('ready', peerId);

    // Propose our public key through Raft so all peers (including
    // those joining later) receive it via log replay.
    this.proposePublicKey();
  };

  private onPeerConnected = (_remotePeerId: string): void => {
    // Update Raft cluster membership
    this.raftNode?.updatePeers(this.transport.connectedPeers as string[]);
    this.emit('peersChanged', this.peers);
  };

  private onPeerDisconnected = (_remotePeerId: string): void => {
    this.raftNode?.updatePeers(this.transport.connectedPeers as string[]);
    this.emit('peersChanged', this.peers);
  };

  private onTransportMessage = (fromPeerId: string, data: unknown): void => {
    const wire = data as WireMessage;
    if (!wire || !wire.channel) return;

    if (wire.channel === 'raft') {
      this.raftNode?.handleMessage(
        fromPeerId,
        wire.payload as RaftMessage<MeshLogCommand<T>>
      );
    } else if (wire.channel === 'control') {
      this.handleControlMessage(wire.payload as MeshControlMessage<T>);
    }
  };

  private onTransportError = (error: Error): void => {
    this.emit('error', error);
  };

  // --- Control message handling ---

  private handleControlMessage(msg: MeshControlMessage<T>): void {
    switch (msg._meshType) {
      case 'propose': {
        // A non-leader peer is forwarding a command to us (the leader)
        if (this.raftNode?.isLeader()) {
          this.raftNode.propose(msg.command);
        }
        break;
      }
    }
  }

  // --- Raft commit handler ---

  private onRaftCommitted = (
    entry: LogEntry<MeshLogCommand<T>>,
    index: number
  ): void => {
    const isReplay = index <= this.lastAppliedIndex;
    const cmd = entry.command;
    switch (cmd._meshType) {
      case 'public':
        this.emit(
          'message',
          {
            type: 'public',
            sender: cmd.sender,
            data: cmd.data,
          } as MeshMessage<T>,
          isReplay
        );
        break;

      case 'encrypted':
        this.handleEncryptedCommit(cmd, isReplay);
        break;

      case 'publicKey': {
        if (!this.peerPublicKeys.has(cmd.peerId)) {
          const keyPromise = importPublicKey(cmd.jwk);
          this.peerPublicKeys.set(cmd.peerId, keyPromise);

          // Notify any pending sendPrivate calls waiting for this key
          const waiters = this.pendingKeyWaiters.get(cmd.peerId);
          if (waiters) {
            for (const resolve of waiters) {
              resolve(keyPromise);
            }
            this.pendingKeyWaiters.delete(cmd.peerId);
          }
        }
        break;
      }
    }

    if (!isReplay) {
      this.lastAppliedIndex = index;
    }
  };

  private async handleEncryptedCommit(
    cmd: EncryptedPrivateMessage,
    isReplay: boolean
  ): Promise<void> {
    if (!this.localPeerId) return;

    // Only the intended recipient decrypts
    if (cmd.recipient !== this.localPeerId) return;

    if (!this.cryptoBundle) {
      await this.cryptoReady;
    }
    try {
      const plaintext = await decrypt(
        cmd.payload,
        this.cryptoBundle!.privateKey
      );
      const data = JSON.parse(new TextDecoder().decode(plaintext)) as T;
      this.emit(
        'message',
        {
          type: 'private',
          sender: cmd.sender,
          recipient: cmd.recipient,
          data,
        } as MeshMessage<T>,
        isReplay
      );
    } catch (err) {
      // Not for us or decryption failed — this is expected for other recipients
    }
  }

  // --- Key management ---

  private async proposePublicKey(): Promise<void> {
    if (!this.cryptoBundle) {
      await this.cryptoReady;
    }
    if (!this.localPeerId || !this.cryptoBundle || !this.raftNode) return;

    // Wait until a leader is available
    if (!this.raftNode.isLeader() && !this.raftNode.getLeaderId()) {
      await new Promise<void>((resolve) => {
        const onLeader = (leaderId: string | null) => {
          if (leaderId) {
            this.off('leaderChanged', onLeader);
            resolve();
          }
        };
        this.on('leaderChanged', onLeader);
      });
    }

    if (!this.raftNode) return;

    const announcement: PublicKeyAnnouncement = {
      _meshType: 'publicKey',
      peerId: this.localPeerId,
      jwk: this.cryptoBundle.publicKeyJwk,
    };

    if (this.raftNode.isLeader()) {
      this.raftNode.propose(announcement);
    } else {
      const leaderId = this.raftNode.getLeaderId();
      if (!leaderId) return;
      const propose: ProposeMessage<T> = {
        _meshType: 'propose',
        command: announcement,
      };
      this.transport
        .send(leaderId, this.wireMessage('control', propose))
        .catch(() => {});
    }
  }

  private async getOrAwaitPublicKey(peerId: string): Promise<CryptoKey> {
    const existing = this.peerPublicKeys.get(peerId);
    if (existing) return existing;

    // Wait for the key to arrive via Raft commit
    return new Promise<CryptoKey>((resolve) => {
      let waiters = this.pendingKeyWaiters.get(peerId);
      if (!waiters) {
        waiters = [];
        this.pendingKeyWaiters.set(peerId, waiters);
      }
      waiters.push((keyPromise) => resolve(keyPromise));
    });
  }

  // --- Helpers ---

  private wireMessage(
    channel: 'raft' | 'control',
    payload: unknown
  ): WireMessage {
    return { channel, payload };
  }

  private emit<E extends keyof DandelionMeshEvents<T>>(
    event: E,
    ...args: Parameters<DandelionMeshEvents<T>[E]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<DandelionMeshEvents<T>[E]>) => void)(
        ...args
      );
    }
  }
}
