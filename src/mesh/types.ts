import { EncryptedPayload } from '../crypto/CryptoService';

// --- Application-level message types ---

export interface PublicMessage<T = unknown> {
  type: 'public';
  sender: string;
  data: T;
}

export interface PrivateMessage<T = unknown> {
  type: 'private';
  sender: string;
  recipient: string;
  data: T;
}

export type MeshMessage<T = unknown> = PublicMessage<T> | PrivateMessage<T>;

// --- Internal wire protocol messages (carried as Raft log entries or side-channel) ---

/** Broadcast of a peer's RSA public key */
export interface PublicKeyAnnouncement {
  _meshType: 'publicKey';
  peerId: string;
  jwk: JsonWebKey;
}

/** An encrypted private message (the Raft log entry payload for private messages) */
export interface EncryptedPrivateMessage {
  _meshType: 'encrypted';
  sender: string;
  recipient: string;
  payload: EncryptedPayload;
}

/** A public message log entry */
export interface PublicMessageEntry<T = unknown> {
  _meshType: 'public';
  sender: string;
  data: T;
}

/** Union of all Raft log command types */
export type MeshLogCommand<T = unknown> =
  | PublicMessageEntry<T>
  | EncryptedPrivateMessage;

/** A proposal forwarded from a non-leader to the leader */
export interface ProposeMessage<T = unknown> {
  _meshType: 'propose';
  command: MeshLogCommand<T>;
}

/** Internal transport-level messages (not replicated via Raft) */
export type MeshControlMessage<T = unknown> =
  | PublicKeyAnnouncement
  | ProposeMessage<T>;

/** Wrapper to distinguish Raft messages from mesh control messages on the wire */
export interface WireMessage {
  channel: 'raft' | 'control';
  payload: unknown;
}

// --- Events exposed to consumers ---

export interface DandelionMeshEvents<T = unknown> {
  /** Local peer is ready */
  ready: (localPeerId: string) => void;
  /** A message was committed and delivered */
  message: (message: MeshMessage<T>, replay: boolean) => void;
  /** The set of connected peer IDs changed */
  peersChanged: (peers: string[]) => void;
  /** The cluster leader changed */
  leaderChanged: (leaderId: string | null) => void;
  /** An error occurred */
  error: (error: Error) => void;
}
