import { RaftLog } from './log/RaftLog';
import {
  AppendEntriesArgs,
  AppendEntriesResult,
  LogEntry,
  RaftMessage,
  RaftNodeEvents,
  RaftRole,
  RequestVoteArgs,
  RequestVoteResult,
} from './types';

type EventListenerMap<T> = {
  [E in keyof RaftNodeEvents<T>]: Set<RaftNodeEvents<T>[E]>;
};

export interface RaftNodeOptions {
  /** Minimum election timeout in ms (default 150) */
  electionTimeoutMin?: number;
  /** Maximum election timeout in ms (default 300) */
  electionTimeoutMax?: number;
  /** Heartbeat interval in ms (default 50) */
  heartbeatInterval?: number;
}

/**
 * Core Raft consensus node.
 *
 * This class implements the Raft algorithm for leader election and log
 * replication. It is transport-agnostic — the caller must wire up
 * `sendMessage` to deliver RPCs, and call `handleMessage` when RPCs arrive.
 *
 * Log indices are 1-based per the Raft paper.
 */
export class RaftNode<T = unknown> {
  readonly id: string;

  private role: RaftRole = 'follower';
  private currentTerm = 0;
  private votedFor: string | null = null;
  private leaderId: string | null = null;

  // Volatile state (all servers)
  private commitIndex = 0;
  private lastApplied = 0;

  // Volatile state (leader only)
  private nextIndex = new Map<string, number>();
  private matchIndex = new Map<string, number>();

  // Election / heartbeat timers
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly electionTimeoutMin: number;
  private readonly electionTimeoutMax: number;
  private readonly heartbeatInterval: number;

  // Cluster membership (peer IDs excluding self)
  private peers: string[] = [];

  // Votes received in current election
  private votesReceived = new Set<string>();

  private readonly log: RaftLog<T>;

  /** Called by the node to send an RPC to a peer — must be wired up externally */
  public sendMessage: (toPeerId: string, message: RaftMessage<T>) => void =
    () => {};

  private readonly eventListeners: EventListenerMap<T> = {
    leaderChanged: new Set(),
    committed: new Set(),
    roleChanged: new Set(),
  };

  private destroyed = false;

  constructor(id: string, log: RaftLog<T>, options?: RaftNodeOptions) {
    this.id = id;
    this.log = log;

    this.electionTimeoutMin = options?.electionTimeoutMin ?? 150;
    this.electionTimeoutMax = options?.electionTimeoutMax ?? 300;
    this.heartbeatInterval = options?.heartbeatInterval ?? 50;

    // Restore persistent state
    const state = this.log.loadState();
    this.currentTerm = state.currentTerm;
    this.votedFor = state.votedFor;
  }

  // --- Public API ---

  /** Start the node (begin election timer as follower) */
  start(peerIds: string[]): void {
    this.peers = peerIds.filter((p) => p !== this.id);
    this.resetElectionTimer();
  }

  /** Update the cluster membership dynamically (e.g. when peers join/leave) */
  updatePeers(peerIds: string[]): void {
    this.peers = peerIds.filter((p) => p !== this.id);
    // Reinitialize leader volatile state for new peers
    if (this.role === 'leader') {
      for (const peer of this.peers) {
        if (!this.nextIndex.has(peer)) {
          this.nextIndex.set(peer, this.log.lastIndex() + 1);
          this.matchIndex.set(peer, 0);
        }
      }
    }
  }

  /** Submit a command to be replicated. Only succeeds on the leader. */
  propose(command: T): boolean {
    if (this.role !== 'leader') {
      return false;
    }
    const entry: LogEntry<T> = { term: this.currentTerm, command };
    this.log.append([entry]);
    this.persistState();

    // Immediately replicate to followers
    this.sendAppendEntriesToAll();

    // Check if we can commit (single-node cluster)
    this.advanceCommitIndex();
    return true;
  }

  /** Handle an incoming Raft RPC message from a peer */
  handleMessage(fromPeerId: string, message: RaftMessage<T>): void {
    if (this.destroyed) return;

    // If we see a higher term, step down
    const msgTerm = 'term' in message ? message.term : 0;
    if (msgTerm > this.currentTerm) {
      this.currentTerm = msgTerm;
      this.votedFor = null;
      this.persistState();
      this.becomeFollower();
    }

    switch (message.type) {
      case 'RequestVote':
        this.handleRequestVote(fromPeerId, message);
        break;
      case 'RequestVoteResult':
        this.handleRequestVoteResult(fromPeerId, message);
        break;
      case 'AppendEntries':
        this.handleAppendEntries(fromPeerId, message);
        break;
      case 'AppendEntriesResult':
        this.handleAppendEntriesResult(message);
        break;
    }
  }

  /** Get current role */
  getRole(): RaftRole {
    return this.role;
  }

  /** Get current term */
  getCurrentTerm(): number {
    return this.currentTerm;
  }

  /** Get the current leader ID (null if unknown) */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /** Get the commit index */
  getCommitIndex(): number {
    return this.commitIndex;
  }

  /** Check if this node is the leader */
  isLeader(): boolean {
    return this.role === 'leader';
  }

  /** Register an event listener */
  on<E extends keyof RaftNodeEvents<T>>(
    event: E,
    listener: RaftNodeEvents<T>[E]
  ): void {
    (this.eventListeners[event] as Set<RaftNodeEvents<T>[E]>).add(listener);
  }

  /** Remove an event listener */
  off<E extends keyof RaftNodeEvents<T>>(
    event: E,
    listener: RaftNodeEvents<T>[E]
  ): void {
    (this.eventListeners[event] as Set<RaftNodeEvents<T>[E]>).delete(listener);
  }

  /** Stop all timers and clean up */
  destroy(): void {
    this.destroyed = true;
    this.clearElectionTimer();
    this.clearHeartbeatTimer();
  }

  // --- Election ---

  private becomeFollower(): void {
    const wasLeader = this.role === 'leader';
    this.role = 'follower';
    this.clearHeartbeatTimer();
    this.resetElectionTimer();
    this.emit('roleChanged', 'follower');
    if (wasLeader) {
      // Leader identity is unknown until we hear from the new leader
    }
  }

  private becomeCandidate(): void {
    this.role = 'candidate';
    this.currentTerm++;
    this.votedFor = this.id;
    this.persistState();
    this.votesReceived.clear();
    this.votesReceived.add(this.id); // vote for self
    this.leaderId = null;
    this.emit('roleChanged', 'candidate');
    this.emit('leaderChanged', null);
    this.resetElectionTimer();

    // Single-node cluster: become leader immediately
    if (this.peers.length === 0) {
      this.becomeLeader();
      return;
    }

    // Send RequestVote to all peers
    const request: RequestVoteArgs = {
      type: 'RequestVote',
      term: this.currentTerm,
      candidateId: this.id,
      lastLogIndex: this.log.lastIndex(),
      lastLogTerm: this.log.lastTerm(),
    };
    for (const peer of this.peers) {
      this.sendMessage(peer, request);
    }
  }

  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.id;
    this.clearElectionTimer();
    this.emit('roleChanged', 'leader');
    this.emit('leaderChanged', this.id);

    // Initialize nextIndex and matchIndex for all peers
    const lastLogIndex = this.log.lastIndex();
    this.nextIndex.clear();
    this.matchIndex.clear();
    for (const peer of this.peers) {
      this.nextIndex.set(peer, lastLogIndex + 1);
      this.matchIndex.set(peer, 0);
    }

    // Send initial heartbeats
    this.sendAppendEntriesToAll();

    // Start heartbeat timer
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.role === 'leader' && !this.destroyed) {
        this.sendAppendEntriesToAll();
      }
    }, this.heartbeatInterval);
  }

  // --- RequestVote handling ---

  private handleRequestVote(_fromPeerId: string, args: RequestVoteArgs): void {
    const reply: RequestVoteResult = {
      type: 'RequestVoteResult',
      term: this.currentTerm,
      voteGranted: false,
    };

    // Reject if candidate's term is behind
    if (args.term < this.currentTerm) {
      this.sendMessage(args.candidateId, reply);
      return;
    }

    // Grant vote if we haven't voted for someone else, and candidate's log is up-to-date
    const canVote =
      this.votedFor === null || this.votedFor === args.candidateId;
    const candidateLogUpToDate = this.isLogUpToDate(
      args.lastLogTerm,
      args.lastLogIndex
    );

    if (canVote && candidateLogUpToDate) {
      this.votedFor = args.candidateId;
      this.persistState();
      reply.voteGranted = true;
      this.resetElectionTimer(); // reset timer on granting vote
    }

    this.sendMessage(args.candidateId, reply);
  }

  private handleRequestVoteResult(
    fromPeerId: string,
    result: RequestVoteResult
  ): void {
    if (this.role !== 'candidate') return;
    if (result.term !== this.currentTerm) return;

    if (result.voteGranted) {
      this.votesReceived.add(fromPeerId);

      // Check majority (votesReceived includes self)
      const totalCluster = this.peers.length + 1;
      if (this.votesReceived.size >= Math.floor(totalCluster / 2) + 1) {
        this.becomeLeader();
      }
    }
  }

  /** Check if a candidate's log is at least as up-to-date as ours */
  private isLogUpToDate(
    candidateLastTerm: number,
    candidateLastIndex: number
  ): boolean {
    const myLastTerm = this.log.lastTerm();
    if (candidateLastTerm !== myLastTerm) {
      return candidateLastTerm > myLastTerm;
    }
    return candidateLastIndex >= this.log.lastIndex();
  }

  // --- AppendEntries handling ---

  private handleAppendEntries(
    _fromPeerId: string,
    args: AppendEntriesArgs<T>
  ): void {
    const reply: AppendEntriesResult = {
      type: 'AppendEntriesResult',
      term: this.currentTerm,
      success: false,
      responderId: this.id,
      matchIndex: 0,
    };

    // Reject if leader's term is behind
    if (args.term < this.currentTerm) {
      this.sendMessage(args.leaderId, reply);
      return;
    }

    // Valid leader — reset election timer and update leader
    this.resetElectionTimer();
    if (this.role === 'candidate') {
      this.becomeFollower();
    }
    if (this.leaderId !== args.leaderId) {
      this.leaderId = args.leaderId;
      this.emit('leaderChanged', args.leaderId);
    }

    // Check log consistency
    if (args.prevLogIndex > 0) {
      const prevTerm = this.log.getTerm(args.prevLogIndex);
      if (prevTerm === 0 && args.prevLogIndex > this.log.lastIndex()) {
        // We don't have an entry at prevLogIndex
        this.sendMessage(args.leaderId, reply);
        return;
      }
      if (prevTerm !== args.prevLogTerm) {
        // Conflict: delete this entry and everything after
        this.log.truncateFrom(args.prevLogIndex);
        this.sendMessage(args.leaderId, reply);
        return;
      }
    }

    // Append new entries (handle conflicts and skip duplicates)
    if (args.entries.length > 0) {
      for (let i = 0; i < args.entries.length; i++) {
        const entryIndex = args.prevLogIndex + 1 + i;
        const existing = this.log.getEntry(entryIndex);
        if (existing) {
          if (existing.term !== args.entries[i].term) {
            // Conflict: truncate from here and append the rest
            this.log.truncateFrom(entryIndex);
            this.log.append(args.entries.slice(i));
            break;
          }
          // Same term — entry already present, skip
        } else {
          // No existing entry — append remaining
          this.log.append(args.entries.slice(i));
          break;
        }
      }
    }

    // Update commit index
    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.log.lastIndex());
      this.applyCommitted();
    }

    reply.success = true;
    reply.matchIndex = args.prevLogIndex + args.entries.length;
    this.sendMessage(args.leaderId, reply);
  }

  private handleAppendEntriesResult(result: AppendEntriesResult): void {
    if (this.role !== 'leader') return;
    if (result.term !== this.currentTerm) return;

    const peer = result.responderId;

    if (result.success) {
      // Update nextIndex and matchIndex
      if (result.matchIndex > 0) {
        this.nextIndex.set(peer, result.matchIndex + 1);
        this.matchIndex.set(peer, result.matchIndex);
      }
      this.advanceCommitIndex();
    } else {
      // Decrement nextIndex and retry
      const ni = this.nextIndex.get(peer) ?? 1;
      this.nextIndex.set(peer, Math.max(1, ni - 1));
      this.sendAppendEntriesTo(peer);
    }
  }

  // --- Log replication ---

  private sendAppendEntriesToAll(): void {
    for (const peer of this.peers) {
      this.sendAppendEntriesTo(peer);
    }
  }

  private sendAppendEntriesTo(peer: string): void {
    const ni = this.nextIndex.get(peer) ?? this.log.lastIndex() + 1;
    const prevLogIndex = ni - 1;
    const prevLogTerm = this.log.getTerm(prevLogIndex);
    const lastIndex = this.log.lastIndex();

    const entries = ni <= lastIndex ? this.log.getEntries(ni, lastIndex) : [];

    const args: AppendEntriesArgs<T> = {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };
    this.sendMessage(peer, args);
  }

  /** Advance commitIndex if a majority of matchIndex values allow it */
  private advanceCommitIndex(): void {
    const lastIndex = this.log.lastIndex();
    for (let n = lastIndex; n > this.commitIndex; n--) {
      // Only commit entries from the current term
      if (this.log.getTerm(n) !== this.currentTerm) continue;

      // Count replicas (including self)
      let replicaCount = 1; // self
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= n) {
          replicaCount++;
        }
      }

      const majority = Math.floor((this.peers.length + 1) / 2) + 1;
      if (replicaCount >= majority) {
        this.commitIndex = n;
        this.applyCommitted();
        break;
      }
    }
  }

  /** Apply all committed but not-yet-applied entries */
  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log.getEntry(this.lastApplied);
      if (entry) {
        this.emit('committed', entry, this.lastApplied);
      }
    }
  }

  // --- Timer management ---

  private resetElectionTimer(): void {
    this.clearElectionTimer();
    const timeout =
      this.electionTimeoutMin +
      Math.random() * (this.electionTimeoutMax - this.electionTimeoutMin);
    this.electionTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.becomeCandidate();
      }
    }, timeout);
  }

  private clearElectionTimer(): void {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Persistence ---

  private persistState(): void {
    this.log.saveState({
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
    });
  }

  // --- Event emission ---

  private emit<E extends keyof RaftNodeEvents<T>>(
    event: E,
    ...args: Parameters<RaftNodeEvents<T>[E]>
  ): void {
    for (const listener of this.eventListeners[event]) {
      (listener as (...a: Parameters<RaftNodeEvents<T>[E]>) => void)(...args);
    }
  }
}
