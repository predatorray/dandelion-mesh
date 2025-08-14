import { LogEntry, RaftPersistentState } from '../types';

import { RaftLog } from './RaftLog';

/**
 * localStorage-backed Raft log implementation.
 * Survives page refreshes — suitable for durable sessions where peers
 * may rejoin after a restart.
 *
 * Storage layout (all keys prefixed with `{prefix}`):
 *   `{prefix}:state`          → JSON of RaftPersistentState
 *   `{prefix}:log:length`     → number of log entries
 *   `{prefix}:log:{index}`    → JSON of LogEntry at 1-based index
 */
export class LocalStorageRaftLog<T = unknown> implements RaftLog<T> {
  private readonly prefix: string;

  constructor(namespace: string) {
    this.prefix = `dandelion-raft:${namespace}`;
  }

  // --- Persistent state ---

  loadState(): RaftPersistentState {
    const raw = localStorage.getItem(`${this.prefix}:state`);
    if (!raw) return { currentTerm: 0, votedFor: null };
    return JSON.parse(raw);
  }

  saveState(state: RaftPersistentState): void {
    localStorage.setItem(`${this.prefix}:state`, JSON.stringify(state));
  }

  // --- Log operations ---

  length(): number {
    const raw = localStorage.getItem(`${this.prefix}:log:length`);
    return raw ? parseInt(raw, 10) : 0;
  }

  private setLength(len: number): void {
    localStorage.setItem(`${this.prefix}:log:length`, String(len));
  }

  getEntry(index: number): LogEntry<T> | undefined {
    if (index < 1 || index > this.length()) return undefined;
    const raw = localStorage.getItem(`${this.prefix}:log:${index}`);
    return raw ? JSON.parse(raw) : undefined;
  }

  getTerm(index: number): number {
    return this.getEntry(index)?.term ?? 0;
  }

  append(entries: LogEntry<T>[]): void {
    let len = this.length();
    for (const entry of entries) {
      len++;
      localStorage.setItem(`${this.prefix}:log:${len}`, JSON.stringify(entry));
    }
    this.setLength(len);
  }

  truncateFrom(index: number): void {
    if (index < 1) return;
    const len = this.length();
    for (let i = index; i <= len; i++) {
      localStorage.removeItem(`${this.prefix}:log:${i}`);
    }
    this.setLength(index - 1);
  }

  getEntries(startIndex: number, endIndex: number): LogEntry<T>[] {
    const len = this.length();
    if (startIndex > endIndex || startIndex > len) return [];
    const result: LogEntry<T>[] = [];
    const end = Math.min(endIndex, len);
    for (let i = startIndex; i <= end; i++) {
      const entry = this.getEntry(i);
      if (entry) result.push(entry);
    }
    return result;
  }

  lastIndex(): number {
    return this.length();
  }

  lastTerm(): number {
    const len = this.length();
    if (len === 0) return 0;
    return this.getTerm(len);
  }

  /** Remove all stored data for this namespace */
  clear(): void {
    const len = this.length();
    for (let i = 1; i <= len; i++) {
      localStorage.removeItem(`${this.prefix}:log:${i}`);
    }
    localStorage.removeItem(`${this.prefix}:log:length`);
    localStorage.removeItem(`${this.prefix}:state`);
  }
}
