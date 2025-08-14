/** Raft server role */
export type RaftRole = 'follower' | 'candidate' | 'leader';

/** A single entry in the Raft log */
export interface LogEntry<T = unknown> {
  /** The term in which this entry was created */
  term: number;
  /** The command/data stored in this entry */
  command: T;
}

// --- RPC types ---

export interface RequestVoteArgs {
  type: 'RequestVote';
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResult {
  type: 'RequestVoteResult';
  term: number;
  voteGranted: boolean;
}

export interface AppendEntriesArgs<T = unknown> {
  type: 'AppendEntries';
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry<T>[];
  leaderCommit: number;
}

export interface AppendEntriesResult {
  type: 'AppendEntriesResult';
  term: number;
  success: boolean;
  /** The peer ID of the responder (so the leader knows who replied) */
  responderId: string;
  /** The index of the last entry the follower accepted (for updating matchIndex) */
  matchIndex: number;
}

export type RaftMessage<T = unknown> =
  | RequestVoteArgs
  | RequestVoteResult
  | AppendEntriesArgs<T>
  | AppendEntriesResult;

/** Persistent Raft state that must survive restarts */
export interface RaftPersistentState {
  currentTerm: number;
  votedFor: string | null;
}

export interface RaftNodeEvents<T = unknown> {
  /** Fired when a new leader is elected (may be self) */
  leaderChanged: (leaderId: string | null) => void;
  /** Fired when a log entry is committed and should be applied */
  committed: (entry: LogEntry<T>, index: number) => void;
  /** Fired when this node's role changes */
  roleChanged: (role: RaftRole) => void;
}
