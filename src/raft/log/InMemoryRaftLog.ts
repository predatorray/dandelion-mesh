import { LogEntry, RaftPersistentState } from '../types';

import { RaftLog } from './RaftLog';

/**
 * In-memory Raft log implementation.
 * All state is lost on page refresh — suitable for ephemeral sessions.
 */
export class InMemoryRaftLog<T = unknown> implements RaftLog<T> {
  private entries: LogEntry<T>[] = [];
  private state: RaftPersistentState = { currentTerm: 0, votedFor: null };

  loadState(): RaftPersistentState {
    return { ...this.state };
  }

  saveState(state: RaftPersistentState): void {
    this.state = { ...state };
  }

  length(): number {
    return this.entries.length;
  }

  getEntry(index: number): LogEntry<T> | undefined {
    if (index < 1 || index > this.entries.length) {
      return undefined;
    }
    return this.entries[index - 1];
  }

  getTerm(index: number): number {
    return this.getEntry(index)?.term ?? 0;
  }

  append(entries: LogEntry<T>[]): void {
    this.entries.push(...entries);
  }

  truncateFrom(index: number): void {
    if (index < 1) return;
    this.entries.length = index - 1;
  }

  getEntries(startIndex: number, endIndex: number): LogEntry<T>[] {
    if (startIndex > endIndex || startIndex > this.entries.length) return [];
    return this.entries.slice(startIndex - 1, endIndex);
  }

  lastIndex(): number {
    return this.entries.length;
  }

  lastTerm(): number {
    if (this.entries.length === 0) return 0;
    return this.entries[this.entries.length - 1].term;
  }
}
