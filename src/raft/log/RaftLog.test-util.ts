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

import { ExecutionContext } from 'ava';

import { LogEntry, RaftPersistentState } from '../types';

import { RaftLog } from './RaftLog';

export function runCommonRaftLogTests<T>(
  t: ExecutionContext,
  createLog: () => RaftLog<T>
) {
  const log = createLog();

  // Initial state
  t.is(log.length(), 0);
  t.is(log.lastIndex(), 0);
  t.is(log.lastTerm(), 0);
  t.deepEqual(log.loadState(), { currentTerm: 0, votedFor: null });

  // Append and retrieve
  const entries: LogEntry<T>[] = [
    { term: 1, command: 'a' as any },
    { term: 1, command: 'b' as any },
    { term: 2, command: 'c' as any },
  ];
  log.append(entries);

  t.is(log.length(), 3);
  t.is(log.lastIndex(), 3);
  t.is(log.lastTerm(), 2);
  t.deepEqual(log.getEntry(1), entries[0]);
  t.deepEqual(log.getEntry(2), entries[1]);
  t.deepEqual(log.getEntry(3), entries[2]);
  t.is(log.getEntry(0), undefined);
  t.is(log.getEntry(4), undefined);

  // getTerm
  t.is(log.getTerm(1), 1);
  t.is(log.getTerm(3), 2);
  t.is(log.getTerm(0), 0);
  t.is(log.getTerm(4), 0);

  // getEntries
  t.deepEqual(log.getEntries(1, 2), [entries[0], entries[1]]);
  t.deepEqual(log.getEntries(2, 3), [entries[1], entries[2]]);
  t.deepEqual(log.getEntries(1, 3), entries);
  t.deepEqual(log.getEntries(2, 2), [entries[1]]);
  t.deepEqual(log.getEntries(3, 2), []);
  t.deepEqual(log.getEntries(4, 5), []);

  // Persistent state
  const newState: RaftPersistentState = { currentTerm: 5, votedFor: 'node1' };
  log.saveState(newState);
  t.deepEqual(log.loadState(), newState);

  // Truncate
  log.truncateFrom(2);
  t.is(log.length(), 1);
  t.is(log.lastIndex(), 1);
  t.is(log.lastTerm(), 1);
  t.deepEqual(log.getEntry(1), entries[0]);
  t.is(log.getEntry(2), undefined);

  // Truncate from 1
  log.truncateFrom(1);
  t.is(log.length(), 0);
  t.is(log.lastIndex(), 0);
  t.is(log.lastTerm(), 0);

  // Truncate with index <= 0 (should be safe, usually does nothing or clears all)
  log.append(entries);
  log.truncateFrom(0);
  t.is(log.length(), 3, 'truncateFrom(0) should be a no-op per implementation');
}
