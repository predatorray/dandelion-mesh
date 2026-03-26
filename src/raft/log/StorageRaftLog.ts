/*
 * Copyright (c) 2026 Wenhao Ji <predator.ray@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

import { LogEntry, RaftPersistentState } from '../types';

import { RaftLog } from './RaftLog';

/**
 * Common base class for Storage-backed Raft log implementations (localStorage or sessionStorage).
 *
 * Storage layout (all keys prefixed with `{prefix}`):
 *   `{prefix}:state`          → JSON of RaftPersistentState
 *   `{prefix}:log:length`     → number of log entries
 *   `{prefix}:log:{index}`    → JSON of LogEntry at 1-based index
 */
export abstract class StorageRaftLog<T = unknown> implements RaftLog<T> {
  protected readonly prefix: string;

  constructor(protected readonly storage: Storage, namespace: string) {
    this.prefix = `dandelion-raft:${namespace}`;
  }

  // --- Persistent state ---

  loadState(): RaftPersistentState {
    const raw = this.storage.getItem(`${this.prefix}:state`);
    if (!raw) return { currentTerm: 0, votedFor: null };
    return JSON.parse(raw);
  }

  saveState(state: RaftPersistentState): void {
    this.storage.setItem(`${this.prefix}:state`, JSON.stringify(state));
  }

  // --- Log operations ---

  length(): number {
    const raw = this.storage.getItem(`${this.prefix}:log:length`);
    return raw ? parseInt(raw, 10) : 0;
  }

  protected setLength(len: number): void {
    this.storage.setItem(`${this.prefix}:log:length`, String(len));
  }

  getEntry(index: number): LogEntry<T> | undefined {
    if (index < 1 || index > this.length()) return undefined;
    const raw = this.storage.getItem(`${this.prefix}:log:${index}`);
    return raw ? JSON.parse(raw) : undefined;
  }

  getTerm(index: number): number {
    return this.getEntry(index)?.term ?? 0;
  }

  append(entries: LogEntry<T>[]): void {
    let len = this.length();
    for (const entry of entries) {
      len++;
      this.storage.setItem(`${this.prefix}:log:${len}`, JSON.stringify(entry));
    }
    this.setLength(len);
  }

  truncateFrom(index: number): void {
    if (index < 1) return;
    const len = this.length();
    for (let i = index; i <= len; i++) {
      this.storage.removeItem(`${this.prefix}:log:${i}`);
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

  /** Remove all stored data for this namespace from storage */
  clear(): void {
    const len = this.length();
    for (let i = 1; i <= len; i++) {
      this.storage.removeItem(`${this.prefix}:log:${i}`);
    }
    this.storage.removeItem(`${this.prefix}:log:length`);
    this.storage.removeItem(`${this.prefix}:state`);
  }
}
