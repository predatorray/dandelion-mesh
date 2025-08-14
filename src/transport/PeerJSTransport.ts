import Peer, { DataConnection, PeerConnectOption } from 'peerjs';

import { Transport, TransportEventName, TransportEvents } from './Transport';

type ListenerMap = {
  [E in TransportEventName]: Set<TransportEvents[E]>;
};

const CONNECT_OPTIONS: PeerConnectOption = {
  reliable: true,
  serialization: 'json',
};

export interface PeerJSTransportOptions {
  /** PeerJS Peer constructor options (host, port, path, etc.) */
  peerOptions?: ConstructorParameters<typeof Peer>[1];
  /** Optional fixed peer ID; if omitted PeerJS assigns one */
  peerId?: string;
}

export class PeerJSTransport implements Transport {
  private readonly peer: Peer;
  private readonly connections = new Map<string, DataConnection>();
  private readonly pendingConnections = new Map<string, DataConnection>();
  private _localPeerId: string | undefined;
  private readonly listeners: ListenerMap = {
    open: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(options?: PeerJSTransportOptions) {
    this.peer = options?.peerId
      ? new Peer(options.peerId, options?.peerOptions)
      : new Peer(options?.peerOptions);

    this.peer.on('open', (id: string) => {
      this._localPeerId = id;
      this.emit('open', id);
    });

    this.peer.on('connection', (conn: DataConnection) => {
      this.setupConnection(conn);
    });

    this.peer.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.peer.on('close', () => {
      this.emit('close');
    });
  }

  get localPeerId(): string | undefined {
    return this._localPeerId;
  }

  get connectedPeers(): ReadonlyArray<string> {
    return Array.from(this.connections.keys());
  }

  connect(remotePeerId: string): void {
    if (this.connections.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      return;
    }
    const conn = this.peer.connect(remotePeerId, CONNECT_OPTIONS);
    this.setupConnection(conn);
  }

  async send(remotePeerId: string, data: unknown): Promise<void> {
    const conn = this.connections.get(remotePeerId);
    if (!conn) {
      throw new Error(`No connection to peer: ${remotePeerId}`);
    }
    await conn.send(data);
  }

  async broadcast(data: unknown): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      promises.push(Promise.resolve(conn.send(data)));
    }
    await Promise.all(promises);
  }

  on<E extends TransportEventName>(event: E, listener: TransportEvents[E]): void {
    (this.listeners[event] as Set<TransportEvents[E]>).add(listener);
  }

  off<E extends TransportEventName>(event: E, listener: TransportEvents[E]): void {
    (this.listeners[event] as Set<TransportEvents[E]>).delete(listener);
  }

  close(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    this.pendingConnections.clear();
    this.peer.destroy();
  }

  private setupConnection(conn: DataConnection): void {
    const remotePeerId = conn.peer;
    this.pendingConnections.set(remotePeerId, conn);

    conn.on('open', () => {
      this.pendingConnections.delete(remotePeerId);
      // If we already have a connection to this peer (e.g. simultaneous connect),
      // keep the one where local < remote to break the tie deterministically.
      const existing = this.connections.get(remotePeerId);
      if (existing) {
        if (this._localPeerId && this._localPeerId < remotePeerId) {
          // keep existing, close the new one
          conn.close();
          return;
        } else {
          // replace existing with new
          existing.close();
        }
      }
      this.connections.set(remotePeerId, conn);
      this.emit('peerConnected', remotePeerId);
    });

    conn.on('data', (data: unknown) => {
      this.emit('message', conn.peer, data);
    });

    conn.on('close', () => {
      this.pendingConnections.delete(remotePeerId);
      if (this.connections.get(remotePeerId) === conn) {
        this.connections.delete(remotePeerId);
        this.emit('peerDisconnected', remotePeerId);
      }
    });

    conn.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private emit<E extends TransportEventName>(event: E, ...args: Parameters<TransportEvents[E]>): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<TransportEvents[E]>) => void)(...args);
    }
  }
}
