/**
 * Abstract transport layer for peer-to-peer communication.
 * Implementations handle connection establishment, message sending/receiving,
 * and peer lifecycle management.
 */

export interface TransportEvents {
  /** Fired when this peer is ready and has an assigned ID */
  open: (localPeerId: string) => void;
  /** Fired when a new remote peer connects */
  peerConnected: (remotePeerId: string) => void;
  /** Fired when a remote peer disconnects */
  peerDisconnected: (remotePeerId: string) => void;
  /** Fired when a message is received from a remote peer */
  message: (fromPeerId: string, data: unknown) => void;
  /** Fired on transport-level errors */
  error: (error: Error) => void;
  /** Fired when the transport is closed */
  close: () => void;
}

export type TransportEventName = keyof TransportEvents;

export interface Transport {
  /** The local peer ID, available after 'open' fires */
  readonly localPeerId: string | undefined;

  /** IDs of all currently connected remote peers */
  readonly connectedPeers: ReadonlyArray<string>;

  /** Connect to a remote peer by ID */
  connect(remotePeerId: string): void;

  /** Send a message to a specific remote peer */
  send(remotePeerId: string, data: unknown): Promise<void>;

  /** Broadcast a message to all connected peers */
  broadcast(data: unknown): Promise<void>;

  /** Register an event listener */
  on<E extends TransportEventName>(event: E, listener: TransportEvents[E]): void;

  /** Remove an event listener */
  off<E extends TransportEventName>(event: E, listener: TransportEvents[E]): void;

  /** Shut down the transport and close all connections */
  close(): void;
}
