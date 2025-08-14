import { LogEntry, RaftPersistentState } from '../types';

/**
 * Abstract log persistence interface for the Raft consensus algorithm.
 * Raft log indices are 1-based.
 */
export interface RaftLog<T = unknown> {
  // --- Persistent state ---

  /** Load persistent state (currentTerm, votedFor). Returns defaults if not yet stored. */
  loadState(): RaftPersistentState;

  /** Persist the current term and votedFor */
  saveState(state: RaftPersistentState): void;

  // --- Log operations ---

  /** Number of entries in the log */
  length(): number;

  /** Get the entry at the given 1-based index, or undefined if out of range */
  getEntry(index: number): LogEntry<T> | undefined;

  /** Get the term of the entry at the given 1-based index, or 0 if out of range */
  getTerm(index: number): number;

  /** Append one or more entries to the end of the log */
  append(entries: LogEntry<T>[]): void;

  /**
   * Delete all entries from the given 1-based index onward (inclusive).
   * Used when resolving log conflicts.
   */
  truncateFrom(index: number): void;

  /** Get all entries from startIndex to endIndex (both inclusive, 1-based) */
  getEntries(startIndex: number, endIndex: number): LogEntry<T>[];

  /** Get the index of the last entry (0 if log is empty) */
  lastIndex(): number;

  /** Get the term of the last entry (0 if log is empty) */
  lastTerm(): number;
}
