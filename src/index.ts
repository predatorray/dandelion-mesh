// Transport layer
export {
  Transport,
  TransportEvents,
  TransportEventName,
} from './transport/Transport';
export {
  PeerJSTransport,
  PeerJSTransportOptions,
} from './transport/PeerJSTransport';

// Crypto
export {
  generateKeyBundle,
  importPublicKey,
  encrypt,
  decrypt,
  CryptoKeyBundle,
  EncryptedPayload,
} from './crypto/CryptoService';

// Raft consensus
export { RaftNode, RaftNodeOptions } from './raft/RaftNode';
export {
  RaftRole,
  LogEntry,
  RequestVoteArgs,
  RequestVoteResult,
  AppendEntriesArgs,
  AppendEntriesResult,
  RaftMessage,
  RaftPersistentState,
  RaftNodeEvents,
} from './raft/types';
export { RaftLog } from './raft/log/RaftLog';
export { InMemoryRaftLog } from './raft/log/InMemoryRaftLog';
export { LocalStorageRaftLog } from './raft/log/LocalStorageRaftLog';

// Mesh (main API)
export { DandelionMesh, DandelionMeshOptions } from './mesh/DandelionMesh';
export {
  PublicMessage,
  PrivateMessage,
  MeshMessage,
  DandelionMeshEvents,
} from './mesh/types';
