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

import { runCommonRaftLogTests } from './RaftLog.test-util';
import { StorageRaftLog } from './StorageRaftLog';

export function runStorageRaftLogTests<T>(
  t: ExecutionContext,
  createLog: (namespace: string) => StorageRaftLog<T>
) {
  // 1. common RaftLog interface
  const logCommon = createLog('test-common');
  logCommon.clear();
  runCommonRaftLogTests(t, () => logCommon);

  // 2. persistence across instances
  const namespace = 'test-persistence';
  const log1 = createLog(namespace);
  log1.clear();

  log1.append([{ term: 1, command: 'persist-me' as any }]);
  log1.saveState({ currentTerm: 1, votedFor: 'peer1' });

  // Create a new instance with same namespace
  const log2 = createLog(namespace);
  t.is(log2.length(), 1);
  t.deepEqual(log2.getEntry(1), { term: 1, command: 'persist-me' as any });
  t.deepEqual(log2.loadState(), { currentTerm: 1, votedFor: 'peer1' });

  // 3. clear removes all data in namespace
  const namespaceClear = 'test-clear';
  const logClear = createLog(namespaceClear);
  logClear.append([{ term: 1, command: 'a' as any }]);
  logClear.saveState({ currentTerm: 1, votedFor: 'b' });

  logClear.clear();

  t.is(logClear.length(), 0);
  t.deepEqual(logClear.loadState(), { currentTerm: 0, votedFor: null });
  t.is(logClear.getEntry(1), undefined);
}
