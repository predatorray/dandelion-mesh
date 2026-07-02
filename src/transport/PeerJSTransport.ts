import Peer, { PeerConnectOption } from 'peerjs';

import { unrefTimer } from '../utils/timers';

import { Transport, TransportEventName, TransportEvents } from './Transport';

/** Minimal subset of PeerJS DataConnection used by PeerJSTransport. */
export interface DataConnectionLike {
  readonly peer: string;
  send(data: unknown): void | Promise<void>;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'data', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Minimal subset of PeerJS Peer used by PeerJSTransport. */
export interface PeerLike {
  on(event: 'open', cb: (id: string) => void): void;
  on(event: 'connection', cb: (conn: DataConnectionLike) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  connect(peerId: string, options?: unknown): DataConnectionLike;
  destroy(): void;
}

type ListenerMap = {
  [E in TransportEventName]: Set<TransportEvents[E]>;
};

const CONNECT_OPTIONS: PeerConnectOption = {
  reliable: true,
  serialization: 'json',
};

export interface ConnectionRetryOptions {
  /**
   * Maximum number of automatic retry attempts per peer after a failed
   * connection attempt (default 5). 0 disables automatic retries.
   */
  maxRetries?: number;
  /**
   * Initial retry backoff delay in milliseconds (default 1000).
   * The delay doubles after each failed attempt.
   */
  initialDelayMs?: number;
  /** Upper bound for the retry backoff delay in milliseconds (default 15000). */
  maxDelayMs?: number;
  /**
   * How long (ms) a connection attempt may stay pending before it is
   * considered failed (default 30000). 0 disables the timeout.
   */
  openTimeoutMs?: number;
  /**
   * Automatically try to re-establish a connection when an established
   * connection drops unexpectedly (default true).
   */
  reconnectOnDrop?: boolean;
}

export interface PeerJSTransportOptions {
  /** PeerJS Peer constructor options (host, port, path, etc.) */
  peerOptions?: ConstructorParameters<typeof Peer>[1];
  /** Optional fixed peer ID; if omitted PeerJS assigns one */
  peerId?: string;
  /** Automatic connection retry / reconnect behaviour */
  connectionRetry?: ConnectionRetryOptions;
}

const DEFAULT_RETRY_OPTIONS: Required<ConnectionRetryOptions> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 15000,
  openTimeoutMs: 30000,
  reconnectOnDrop: true,
};

interface ConnectionMeta {
  /** true if this side initiated the connection via connect() */
  outgoing: boolean;
  /** true once the connection's 'open' event fired */
  opened: boolean;
  /** true once a pre-open failure has been processed (dedupes error+close) */
  failureHandled: boolean;
  /** timer that fails the attempt if 'open' never fires */
  openTimer: ReturnType<typeof setTimeout> | null;
}

function isPeerLike(obj: unknown): obj is PeerLike {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'on' in obj &&
    'connect' in obj &&
    'destroy' in obj
  );
}

export class PeerJSTransport implements Transport {
  private readonly peer: PeerLike;
  private readonly connections = new Map<string, DataConnectionLike>();
  private readonly pendingConnections = new Map<
    string,
    Set<DataConnectionLike>
  >();
  private readonly connectionMeta = new Map<
    DataConnectionLike,
    ConnectionMeta
  >();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryOptions: Required<ConnectionRetryOptions>;
  private closed = false;
  private _localPeerId: string | undefined;
  private readonly listeners: ListenerMap = {
    open: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(peer: PeerLike, options?: PeerJSTransportOptions);
  constructor(options?: PeerJSTransportOptions);
  constructor(
    peerOrOptions?: PeerLike | PeerJSTransportOptions,
    peerLikeOptions?: PeerJSTransportOptions
  ) {
    let options: PeerJSTransportOptions | undefined;
    if (peerOrOptions && isPeerLike(peerOrOptions)) {
      this.peer = peerOrOptions;
      options = peerLikeOptions;
    } else {
      options = peerOrOptions as PeerJSTransportOptions | undefined;
      this.peer = options?.peerId
        ? new Peer(options.peerId, options?.peerOptions)
        : new Peer(options?.peerOptions);
    }
    this.retryOptions = {
      ...DEFAULT_RETRY_OPTIONS,
      ...options?.connectionRetry,
    };

    this.peer.on('open', (id: string) => {
      this._localPeerId = id;
      this.emit('open', id);
    });

    this.peer.on('connection', (conn: DataConnectionLike) => {
      this.setupConnection(conn, false);
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
    if (this.closed) return;
    // A manual connect() resets any in-flight retry state for this peer.
    this.cancelRetryTimer(remotePeerId);
    this.retryAttempts.delete(remotePeerId);
    this.dial(remotePeerId);
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

  on<E extends TransportEventName>(
    event: E,
    listener: TransportEvents[E]
  ): void {
    (this.listeners[event] as Set<TransportEvents[E]>).add(listener);
  }

  off<E extends TransportEventName>(
    event: E,
    listener: TransportEvents[E]
  ): void {
    (this.listeners[event] as Set<TransportEvents[E]>).delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
    for (const meta of this.connectionMeta.values()) {
      this.clearOpenTimer(meta);
    }
    const toClose: DataConnectionLike[] = [];
    for (const pending of this.pendingConnections.values()) {
      toClose.push(...pending);
    }
    toClose.push(...this.connections.values());
    this.pendingConnections.clear();
    this.connections.clear();
    this.connectionMeta.clear();
    for (const conn of toClose) {
      conn.close();
    }
    this.peer.destroy();
  }

  private dial(remotePeerId: string): void {
    if (
      this.closed ||
      this.connections.has(remotePeerId) ||
      this.hasPendingOutgoing(remotePeerId)
    ) {
      return;
    }
    const conn = this.peer.connect(remotePeerId, CONNECT_OPTIONS);
    this.setupConnection(conn, true);
  }

  private hasPendingOutgoing(remotePeerId: string): boolean {
    const pending = this.pendingConnections.get(remotePeerId);
    if (!pending) return false;
    for (const conn of pending) {
      if (this.connectionMeta.get(conn)?.outgoing) {
        return true;
      }
    }
    return false;
  }

  private setupConnection(conn: DataConnectionLike, outgoing: boolean): void {
    const remotePeerId = conn.peer;
    const meta: ConnectionMeta = {
      outgoing,
      opened: false,
      failureHandled: false,
      openTimer: null,
    };
    this.connectionMeta.set(conn, meta);

    let pending = this.pendingConnections.get(remotePeerId);
    if (!pending) {
      pending = new Set();
      this.pendingConnections.set(remotePeerId, pending);
    }
    pending.add(conn);

    if (this.retryOptions.openTimeoutMs > 0) {
      meta.openTimer = setTimeout(() => {
        meta.openTimer = null;
        if (!meta.opened && !this.closed) {
          this.removeFromPending(remotePeerId, conn);
          conn.close();
          this.handleAttemptFailure(remotePeerId, meta);
        }
      }, this.retryOptions.openTimeoutMs);
      unrefTimer(meta.openTimer);
    }

    conn.on('open', () => {
      if (this.closed || meta.opened) {
        return;
      }
      meta.opened = true;
      this.clearOpenTimer(meta);
      this.removeFromPending(remotePeerId, conn);
      this.cancelRetryTimer(remotePeerId);
      this.retryAttempts.delete(remotePeerId);

      const existing = this.connections.get(remotePeerId);
      if (existing && existing !== conn) {
        if (!this.prefersNewConnection(existing, conn)) {
          // Duplicate from a simultaneous connect: both sides deterministically
          // keep the same connection; this one loses.
          conn.close();
          return;
        }
        // Replace the existing connection. Install the new one first so the
        // close of the old one is not mistaken for a peer disconnect.
        this.connections.set(remotePeerId, conn);
        existing.close();
        // The peer set did not change — no peerConnected event.
        return;
      }
      this.connections.set(remotePeerId, conn);
      this.emit('peerConnected', remotePeerId);
    });

    conn.on('data', (data: unknown) => {
      this.emit('message', conn.peer, data);
    });

    conn.on('close', () => {
      this.clearOpenTimer(meta);
      if (this.closed) {
        this.connectionMeta.delete(conn);
        return;
      }
      this.removeFromPending(remotePeerId, conn);
      const wasActive = this.connections.get(remotePeerId) === conn;
      this.connectionMeta.delete(conn);
      if (wasActive) {
        this.connections.delete(remotePeerId);
        this.emit('peerDisconnected', remotePeerId);
        if (this.retryOptions.reconnectOnDrop) {
          // Unexpected drop — try to re-establish with a fresh backoff cycle,
          // so transient network failures do not partition the mesh.
          this.retryAttempts.delete(remotePeerId);
          this.scheduleRetry(remotePeerId);
        }
      } else if (!meta.opened) {
        this.handleAttemptFailure(remotePeerId, meta);
      }
    });

    conn.on('error', (err: Error) => {
      this.emit('error', err);
      if (!meta.opened && !this.closed) {
        // The attempt failed before it opened; PeerJS does not always follow
        // up with a 'close' event, so clean up and retry from here.
        this.clearOpenTimer(meta);
        this.removeFromPending(remotePeerId, conn);
        conn.close();
        this.handleAttemptFailure(remotePeerId, meta);
      }
    });
  }

  /**
   * Decide which of two open connections to the same peer survives.
   *
   * Both endpoints must reach the same decision independently. Deciding based
   * on the local arrival order of 'open' events is not safe: the order can
   * differ between the two peers, in which case each side keeps a different
   * connection and then closes the one the other side kept — disconnecting
   * the two peers entirely. Instead, on a simultaneous connect both sides
   * keep the connection that was initiated by the peer with the smaller ID.
   */
  private prefersNewConnection(
    existing: DataConnectionLike,
    candidate: DataConnectionLike
  ): boolean {
    const existingOutgoing = this.connectionMeta.get(existing)?.outgoing;
    const candidateOutgoing = this.connectionMeta.get(candidate)?.outgoing;
    if (
      existingOutgoing === undefined ||
      candidateOutgoing === undefined ||
      existingOutgoing === candidateOutgoing
    ) {
      // Same initiator (e.g. a reconnect racing a stale connection): the
      // newer connection supersedes the old one.
      return true;
    }
    const localId = this._localPeerId ?? '';
    const outgoingPreferred = localId < candidate.peer;
    return candidateOutgoing === outgoingPreferred;
  }

  private handleAttemptFailure(
    remotePeerId: string,
    meta: ConnectionMeta
  ): void {
    if (meta.failureHandled || this.closed) return;
    meta.failureHandled = true;
    if (!meta.outgoing) {
      // The remote initiator is responsible for retrying its own attempts.
      return;
    }
    if (this.connections.has(remotePeerId)) return;
    this.scheduleRetry(remotePeerId);
  }

  private scheduleRetry(remotePeerId: string): void {
    if (this.closed || this.retryTimers.has(remotePeerId)) return;
    const attempts = this.retryAttempts.get(remotePeerId) ?? 0;
    if (attempts >= this.retryOptions.maxRetries) {
      this.emit(
        'error',
        new Error(
          `Connection to peer ${remotePeerId} failed after ${attempts} ` +
            `${attempts === 1 ? 'retry' : 'retries'}`
        )
      );
      return;
    }
    this.retryAttempts.set(remotePeerId, attempts + 1);
    const delay = Math.min(
      this.retryOptions.initialDelayMs * Math.pow(2, attempts),
      this.retryOptions.maxDelayMs
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(remotePeerId);
      this.dial(remotePeerId);
    }, delay);
    unrefTimer(timer);
    this.retryTimers.set(remotePeerId, timer);
  }

  private removeFromPending(
    remotePeerId: string,
    conn: DataConnectionLike
  ): void {
    const pending = this.pendingConnections.get(remotePeerId);
    if (!pending) return;
    pending.delete(conn);
    if (pending.size === 0) {
      this.pendingConnections.delete(remotePeerId);
    }
  }

  private cancelRetryTimer(remotePeerId: string): void {
    const timer = this.retryTimers.get(remotePeerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(remotePeerId);
    }
  }

  private clearOpenTimer(meta: ConnectionMeta): void {
    if (meta.openTimer !== null) {
      clearTimeout(meta.openTimer);
      meta.openTimer = null;
    }
  }

  private emit<E extends TransportEventName>(
    event: E,
    ...args: Parameters<TransportEvents[E]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<TransportEvents[E]>) => void)(...args);
    }
  }
}
