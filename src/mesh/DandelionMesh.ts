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
}

/**
 * DandelionMesh — a fault-tolerant P2P mesh network for browser applications.
 *
 * Combines a Transport layer (default: PeerJS), RSA hybrid encryption for
 * private messages, and Raft consensus for leader election and ordered log
 * replication.
 *
 * Usage:
 * ```ts
 * const transport = new PeerJSTransport({ peerId: 'alice' });
 * const mesh = new DandelionMesh(transport);
 *
 * mesh.on('ready', (id) => console.log('My ID:', id));
 * mesh.on('message', (msg) => console.log('Got:', msg));
 *
 * // After peers connect:
 * mesh.sendPublic({ action: 'bet', amount: 100 });
 * mesh.sendPrivate('bob', { cards: ['Ah', 'Kd'] });
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

  private readonly modulusLength: number;
  private readonly raftOptions: RaftNodeOptions;
  private readonly bootstrapPeers: string[];

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

    // Start key generation immediately
    this.cryptoReady = generateKeyBundle(this.modulusLength).then((bundle) => {
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
    if (!recipientKey) return false;

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

    // Broadcast our public key to any already-connected peers
    this.broadcastPublicKey();
  };

  private onPeerConnected = (remotePeerId: string): void => {
    // Update Raft cluster membership
    this.raftNode?.updatePeers(this.transport.connectedPeers as string[]);
    this.emit('peersChanged', this.peers);

    // Send our public key to the new peer
    this.sendPublicKeyTo(remotePeerId);
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
      case 'publicKey': {
        const keyPromise = importPublicKey(msg.jwk);
        this.peerPublicKeys.set(msg.peerId, keyPromise);
        break;
      }
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
    _index: number
  ): void => {
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
          false
        );
        break;

      case 'encrypted':
        this.handleEncryptedCommit(cmd);
        break;
    }
  };

  private async handleEncryptedCommit(
    cmd: EncryptedPrivateMessage
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
        false
      );
    } catch (err) {
      // Not for us or decryption failed — this is expected for other recipients
    }
  }

  // --- Key management ---

  private async broadcastPublicKey(): Promise<void> {
    if (!this.cryptoBundle) {
      await this.cryptoReady;
    }
    if (!this.localPeerId || !this.cryptoBundle) return;

    const announcement: PublicKeyAnnouncement = {
      _meshType: 'publicKey',
      peerId: this.localPeerId,
      jwk: this.cryptoBundle.publicKeyJwk,
    };
    this.transport
      .broadcast(this.wireMessage('control', announcement))
      .catch(() => {});
  }

  private async sendPublicKeyTo(remotePeerId: string): Promise<void> {
    if (!this.cryptoBundle) {
      await this.cryptoReady;
    }
    if (!this.localPeerId || !this.cryptoBundle) return;

    const announcement: PublicKeyAnnouncement = {
      _meshType: 'publicKey',
      peerId: this.localPeerId,
      jwk: this.cryptoBundle.publicKeyJwk,
    };
    this.transport
      .send(remotePeerId, this.wireMessage('control', announcement))
      .catch(() => {});
  }

  private getOrAwaitPublicKey(peerId: string): Promise<CryptoKey> | undefined {
    return this.peerPublicKeys.get(peerId);
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
