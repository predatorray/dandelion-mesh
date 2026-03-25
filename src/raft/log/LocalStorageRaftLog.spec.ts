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

import test from 'ava';

import { LocalStorageRaftLog } from './LocalStorageRaftLog';
import { runCommonRaftLogTests } from './RaftLog.test-util';

// Simple localStorage mock
class LocalStorageMock {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value.toString();
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

test.before(() => {
  (globalThis as any).localStorage = new LocalStorageMock();
});

test('LocalStorageRaftLog: satisfies common RaftLog interface', (t) => {
  const log = new LocalStorageRaftLog<string>('test-common');
  log.clear(); // Ensure clean state
  runCommonRaftLogTests(t, () => log);
});

test('LocalStorageRaftLog: persistence across instances', (t) => {
  const namespace = 'test-persistence';
  const log1 = new LocalStorageRaftLog<string>(namespace);
  log1.clear();

  log1.append([{ term: 1, command: 'persist-me' }]);
  log1.saveState({ currentTerm: 1, votedFor: 'peer1' });

  // Create a new instance with same namespace
  const log2 = new LocalStorageRaftLog<string>(namespace);
  t.is(log2.length(), 1);
  t.deepEqual(log2.getEntry(1), { term: 1, command: 'persist-me' });
  t.deepEqual(log2.loadState(), { currentTerm: 1, votedFor: 'peer1' });
});

test('LocalStorageRaftLog: clear removes all data in namespace', (t) => {
  const namespace = 'test-clear';
  const log = new LocalStorageRaftLog<string>(namespace);
  log.append([{ term: 1, command: 'a' }]);
  log.saveState({ currentTerm: 1, votedFor: 'b' });

  log.clear();

  t.is(log.length(), 0);
  t.deepEqual(log.loadState(), { currentTerm: 0, votedFor: null });
  t.is(log.getEntry(1), undefined);
});
