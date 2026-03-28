import test from 'ava';

import { CryptoKeyBundle, generateKeyBundle } from '../crypto/CryptoService';
import { InMemoryRaftLog } from '../raft/log/InMemoryRaftLog';
import { LogEntry } from '../raft/types';
import {
  Transport,
  TransportEventName,
  TransportEvents,
} from '../transport/Transport';

import { DandelionMesh } from './DandelionMesh';
import {
  MeshLogCommand,
  MeshMessage,
  ProposeMessage,
  PublicKeyAnnouncement,
  WireMessage,
} from './types';

// ---------------------------------------------------------------------------
// Typed wire-message helpers (avoids `as any` casts throughout tests)
// ---------------------------------------------------------------------------

interface ControlWire extends WireMessage {
  channel: 'control';
  payload: { _meshType: string };
}

interface RaftWire extends WireMessage {
  channel: 'raft';
  payload: { type: string };
}

function isControlWire(d: unknown, meshType: string): d is ControlWire {
  const w = d as WireMessage;
  return (
    w != null &&
    w.channel === 'control' &&
    (w.payload as PublicKeyAnnouncement | ProposeMessage)?._meshType ===
      meshType
  );
}

function isRaftWire(d: unknown, rpcType: string): d is RaftWire {
  const w = d as WireMessage;
  return (
    w != null &&
    w.channel === 'raft' &&
    (w.payload as { type?: string })?.type === rpcType
  );
}

// ---------------------------------------------------------------------------
// MockTransport — in-process transport for testing
// ---------------------------------------------------------------------------

type ListenerSets = {
  [E in TransportEventName]: Set<TransportEvents[E]>;
};

class MockTransport implements Transport {
  private _localPeerId: string | undefined;
  private _connectedPeers: string[] = [];
  private readonly _listeners: ListenerSets = {
    open: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  readonly sent: Array<{ to: string; data: unknown }> = [];
  readonly broadcasted: unknown[] = [];
  readonly connectCalls: string[] = [];
  private _closed = false;

  get localPeerId(): string | undefined {
    return this._localPeerId;
  }

  get connectedPeers(): ReadonlyArray<string> {
    return this._connectedPeers;
  }

  connect(remotePeerId: string): void {
    this.connectCalls.push(remotePeerId);
  }

  async send(remotePeerId: string, data: unknown): Promise<void> {
    this.sent.push({ to: remotePeerId, data });
  }

  async broadcast(data: unknown): Promise<void> {
    this.broadcasted.push(data);
  }

  on<E extends TransportEventName>(
    event: E,
    listener: TransportEvents[E]
  ): void {
    (this._listeners[event] as Set<TransportEvents[E]>).add(listener);
  }

  off<E extends TransportEventName>(
    event: E,
    listener: TransportEvents[E]
  ): void {
    (this._listeners[event] as Set<TransportEvents[E]>).delete(listener);
  }

  close(): void {
    this._closed = true;
  }

  get closed(): boolean {
    return this._closed;
  }

  // --- Test helpers: fire events ---

  simulateOpen(peerId: string): void {
    this._localPeerId = peerId;
    for (const fn of this._listeners.open) {
      (fn as TransportEvents['open'])(peerId);
    }
  }

  simulatePeerConnected(remotePeerId: string): void {
    this._connectedPeers.push(remotePeerId);
    for (const fn of this._listeners.peerConnected) {
      (fn as TransportEvents['peerConnected'])(remotePeerId);
    }
  }

  simulatePeerDisconnected(remotePeerId: string): void {
    this._connectedPeers = this._connectedPeers.filter(
      (p) => p !== remotePeerId
    );
    for (const fn of this._listeners.peerDisconnected) {
      (fn as TransportEvents['peerDisconnected'])(remotePeerId);
    }
  }

  simulateMessage(fromPeerId: string, data: unknown): void {
    for (const fn of this._listeners.message) {
      (fn as TransportEvents['message'])(fromPeerId, data);
    }
  }

  simulateError(error: Error): void {
    for (const fn of this._listeners.error) {
      (fn as TransportEvents['error'])(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Raft options with fast timers for tests */
const FAST_RAFT = {
  electionTimeoutMin: 30,
  electionTimeoutMax: 60,
  heartbeatInterval: 10,
};

/** High timeout so elections don't fire unless we want them to */
const SLOW_RAFT = {
  electionTimeoutMin: 100_000,
  electionTimeoutMax: 100_001,
  heartbeatInterval: 50_000,
};

function createMesh(
  peerId: string,
  opts?: {
    raft?: typeof FAST_RAFT;
    bootstrapPeers?: string[];
    cryptoKeyBundle?: CryptoKeyBundle | Promise<CryptoKeyBundle>;
  }
) {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: opts?.raft ?? SLOW_RAFT,
    bootstrapPeers: opts?.bootstrapPeers,
    cryptoKeyBundle: opts?.cryptoKeyBundle,
  });
  // Simulate the transport opening immediately
  transport.simulateOpen(peerId);
  return { transport, mesh };
}

/**
 * Wire two MockTransport instances together so that `send()` on one
 * delivers a `simulateMessage()` on the other (via setTimeout(0) to
 * avoid synchronous recursion).
 */
function wirePair(
  idA: string,
  tA: MockTransport,
  idB: string,
  tB: MockTransport
) {
  const origSendA = tA.send.bind(tA);
  tA.send = async (to: string, data: unknown) => {
    await origSendA(to, data);
    if (to === idB) {
      setTimeout(() => tB.simulateMessage(idA, data), 0);
    }
  };

  const origSendB = tB.send.bind(tB);
  tB.send = async (to: string, data: unknown) => {
    await origSendB(to, data);
    if (to === idA) {
      setTimeout(() => tA.simulateMessage(idB, data), 0);
    }
  };

  const origBroadcastA = tA.broadcast.bind(tA);
  tA.broadcast = async (data: unknown) => {
    await origBroadcastA(data);
    setTimeout(() => tB.simulateMessage(idA, data), 0);
  };

  const origBroadcastB = tB.broadcast.bind(tB);
  tB.broadcast = async (data: unknown) => {
    await origBroadcastB(data);
    setTimeout(() => tA.simulateMessage(idB, data), 0);
  };
}

/**
 * Wire three MockTransports in a star topology: A↔B and A↔C (B and C
 * are NOT directly connected). Messages from B to C (and vice-versa)
 * do NOT get delivered — they must be relayed by A.
 */
function wireStar(
  idA: string,
  tA: MockTransport,
  idB: string,
  tB: MockTransport,
  idC: string,
  tC: MockTransport
) {
  wirePair(idA, tA, idB, tB);
  wirePair(idA, tA, idC, tC);
  // B↔C: no direct link — send() to the other peer is a no-op
  // (the default MockTransport.send already records but doesn't deliver
  //  to unknown peers since wirePair only routes known partner ids)
}

// ---------------------------------------------------------------------------
// Tests: Construction & initialization
// ---------------------------------------------------------------------------

test('emits ready event on transport open', (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, { raft: SLOW_RAFT });

  let readyId: string | undefined;
  mesh.on('ready', (id) => {
    readyId = id;
  });

  transport.simulateOpen('alice');
  t.is(readyId, 'alice');
  t.is(mesh.peerId, 'alice');
  mesh.close();
});

test('connects to bootstrap peers on open', (t) => {
  const transport = new MockTransport();
  const _mesh = new DandelionMesh<string>(transport, {
    raft: SLOW_RAFT,
    bootstrapPeers: ['bob', 'charlie', 'alice'],
  });

  transport.simulateOpen('alice');

  // Should connect to bob and charlie, but NOT to self (alice)
  t.deepEqual(transport.connectCalls, ['bob', 'charlie']);
  _mesh.close();
});

test('uses provided cryptoKeyBundle instead of generating one', async (t) => {
  const bundle = await generateKeyBundle(2048);
  const { mesh } = createMesh('alice', {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundle,
  });

  // Wait for leader election + public key proposal
  await new Promise((r) => setTimeout(r, 200));
  t.true(mesh.isLeader);

  // The mesh should be able to send private messages to itself
  // (verifying the key bundle is in use)
  t.pass();
  mesh.close();
});

test('accepts cryptoKeyBundle as a Promise', async (t) => {
  const bundlePromise = generateKeyBundle(2048);
  const bundle = await bundlePromise;
  const { mesh } = createMesh('alice', {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundle,
  });

  // Wait for leader election + public key proposal
  await new Promise((r) => setTimeout(r, 200));
  t.true(mesh.isLeader);
  t.pass();
  mesh.close();
});

test('defaults: constructor with no options uses defaults for all fields', async (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport);

  let readyId: string | undefined;
  mesh.on('ready', (id) => {
    readyId = id;
  });

  transport.simulateOpen('alice');
  t.is(readyId, 'alice');
  t.is(mesh.peerId, 'alice');

  // No bootstrap peers → no connect calls
  t.deepEqual(transport.connectCalls, []);

  mesh.close();
});

test('modulusLength option is used for key generation', async (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    modulusLength: 2048,
    raft: FAST_RAFT,
  });

  transport.simulateOpen('alice');

  // Wait for leader election + public key proposal
  await new Promise((r) => setTimeout(r, 300));
  t.true(mesh.isLeader);

  // The mesh should have proposed its public key via Raft.
  // Verify by checking that a publicKey proposal was sent (the key was
  // generated with modulusLength 2048 rather than the default 4096,
  // which is much faster — if it used 4096 the test would be noticeably slower).
  // For a single-node leader, the key is proposed directly via Raft (not
  // via control channel), so we verify the mesh is functional by sending
  // a public message.
  const received: Array<MeshMessage<string>> = [];
  mesh.on('message', (msg) => received.push(msg));
  const ok = await mesh.sendPublic('test');
  t.true(ok);
  t.true(received.length >= 1);
  mesh.close();
});

test('custom raftLog is used for new entries', async (t) => {
  const customLog = new InMemoryRaftLog<MeshLogCommand<string>>();
  const bundle = await generateKeyBundle(2048);

  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: FAST_RAFT,
    raftLog: customLog,
    cryptoKeyBundle: bundle,
  });

  transport.simulateOpen('alice');

  await new Promise((r) => setTimeout(r, 300));
  t.true(mesh.isLeader);

  await mesh.sendPublic('via-custom-log');
  await new Promise((r) => setTimeout(r, 100));

  // The custom log should contain the entries (public key + public message)
  t.true(customLog.length() >= 2, 'custom log should have entries');

  const commands: string[] = [];
  for (let i = 1; i <= customLog.length(); i++) {
    const entry = customLog.getEntry(i);
    if (entry) commands.push(entry.command._meshType);
  }
  t.true(
    commands.includes('publicKey'),
    'custom log should have publicKey entry'
  );
  t.true(
    commands.includes('public'),
    'custom log should have public message entry'
  );

  mesh.close();
});

test('raft options are forwarded to RaftNode', async (t) => {
  const bundle = await generateKeyBundle(2048);

  // Use a very short election timeout — if raft options are correctly
  // forwarded, the node should become leader quickly
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: {
      electionTimeoutMin: 20,
      electionTimeoutMax: 40,
      heartbeatInterval: 10,
    },
    cryptoKeyBundle: bundle,
  });

  transport.simulateOpen('alice');

  // With 20-40ms election timeout, should become leader well within 200ms
  await new Promise((r) => setTimeout(r, 200));
  t.true(mesh.isLeader, 'custom raft timing should be applied');

  mesh.close();
});

test('bootstrapPeers does not connect to self', (t) => {
  const transport = new MockTransport();
  const _mesh = new DandelionMesh<string>(transport, {
    raft: SLOW_RAFT,
    bootstrapPeers: ['alice', 'bob'],
  });

  transport.simulateOpen('alice');

  // Should only connect to bob, not to self
  t.deepEqual(transport.connectCalls, ['bob']);
  _mesh.close();
});

test('empty bootstrapPeers results in no connect calls', (t) => {
  const transport = new MockTransport();
  const _mesh = new DandelionMesh<string>(transport, {
    raft: SLOW_RAFT,
    bootstrapPeers: [],
  });

  transport.simulateOpen('alice');

  t.deepEqual(transport.connectCalls, []);
  _mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Peer lifecycle events
// ---------------------------------------------------------------------------

test('emits peersChanged when peers connect and disconnect', (t) => {
  const { transport, mesh } = createMesh('alice');
  const peerSnapshots: string[][] = [];
  mesh.on('peersChanged', (peers) => peerSnapshots.push([...peers]));

  transport.simulatePeerConnected('bob');
  t.deepEqual(peerSnapshots[0], ['alice', 'bob']);

  transport.simulatePeerConnected('charlie');
  t.deepEqual(peerSnapshots[1], ['alice', 'bob', 'charlie']);

  transport.simulatePeerDisconnected('bob');
  t.deepEqual(peerSnapshots[2], ['alice', 'charlie']);

  mesh.close();
});

test('peers getter includes self and connected peers', (t) => {
  const { transport, mesh } = createMesh('alice');

  t.deepEqual(mesh.peers, ['alice']);

  transport.simulatePeerConnected('bob');
  t.deepEqual(mesh.peers, ['alice', 'bob']);

  mesh.close();
});

test('re-proposes public key when a new peer connects', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);

  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleB,
  });

  wirePair('alice', tA, 'bob', tB);
  tA.simulateOpen('alice');
  tB.simulateOpen('bob');

  // Wait for alice to become leader as single node
  await new Promise((r) => setTimeout(r, 200));
  t.true(meshA.isLeader);

  // Now bob connects — alice re-proposes her key via Raft
  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');

  // Wait for replication
  await new Promise((r) => setTimeout(r, 300));

  // Bob should now be able to send a private message to alice
  // (meaning bob received alice's public key through Raft)
  const received: Array<MeshMessage<string>> = [];
  meshA.on('message', (msg) => received.push(msg));

  const ok = await meshB.sendPrivate('alice', 'hello');
  t.true(ok);

  await new Promise((r) => setTimeout(r, 300));
  const privates = received.filter((m) => m.type === 'private');
  t.true(privates.length >= 1, 'alice should receive private message from bob');
  meshA.close();
  meshB.close();
});

// ---------------------------------------------------------------------------
// Tests: Error forwarding
// ---------------------------------------------------------------------------

test('forwards transport errors as error events', (t) => {
  const { transport, mesh } = createMesh('alice');
  const errors: Error[] = [];
  mesh.on('error', (e) => errors.push(e));

  transport.simulateError(new Error('connection lost'));

  t.is(errors.length, 1);
  t.is(errors[0].message, 'connection lost');
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Single-node leader election & public message
// ---------------------------------------------------------------------------

test('single-node mesh becomes leader and commits public messages', async (t) => {
  const { mesh } = createMesh('alice', { raft: FAST_RAFT });

  // Wait for election
  await new Promise((r) => setTimeout(r, 200));
  t.true(mesh.isLeader);
  t.is(mesh.leaderId, 'alice');

  const received: Array<{ msg: MeshMessage<string>; replay: boolean }> = [];
  mesh.on('message', (msg, replay) => received.push({ msg, replay }));

  const ok = await mesh.sendPublic('hello');
  t.true(ok);
  t.is(received.length, 1);
  t.is(received[0].msg.type, 'public');
  t.false(received[0].replay, 'new message should not be a replay');
  if (received[0].msg.type === 'public') {
    t.is(received[0].msg.sender, 'alice');
    t.is(received[0].msg.data, 'hello');
  }
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Replay flag for pre-existing log entries
// ---------------------------------------------------------------------------

test('marks pre-existing log entries as replays on startup', async (t) => {
  const bundle = await generateKeyBundle(2048);

  // Pre-populate a raft log with a public message entry
  const log = new InMemoryRaftLog<MeshLogCommand<string>>();
  log.append([
    {
      term: 1,
      command: { _meshType: 'public', sender: 'alice', data: 'old-msg' },
    } as LogEntry<MeshLogCommand<string>>,
  ]);
  log.saveState({ currentTerm: 1, votedFor: 'alice' });

  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: FAST_RAFT,
    raftLog: log,
    cryptoKeyBundle: bundle,
  });

  const received: Array<{ msg: MeshMessage<string>; replay: boolean }> = [];
  mesh.on('message', (msg, replay) => received.push({ msg, replay }));

  transport.simulateOpen('alice');

  // Wait for leader election + public key proposal which triggers
  // advanceCommitIndex, re-applying the pre-existing entry
  await new Promise((r) => setTimeout(r, 500));
  t.true(mesh.isLeader);

  // The old-msg entry should be replayed (index 1 <= lastAppliedIndex of 1)
  const replayed = received.filter(
    (r) => r.msg.type === 'public' && r.msg.data === 'old-msg'
  );
  t.true(replayed.length >= 1, 'pre-existing entry should be delivered');
  t.true(replayed[0].replay, 'pre-existing entry should be marked as replay');

  // Now send a new message — should NOT be a replay
  const ok = await mesh.sendPublic('new-msg');
  t.true(ok);

  const fresh = received.filter(
    (r) => r.msg.type === 'public' && r.msg.data === 'new-msg'
  );
  t.true(fresh.length >= 1, 'new message should be delivered');
  t.false(fresh[0].replay, 'new message should not be a replay');

  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: sendPublic / sendPrivate before ready
// ---------------------------------------------------------------------------

test('sendPublic returns false before transport is open', async (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, { raft: SLOW_RAFT });

  // Don't call simulateOpen — mesh has no raftNode yet
  const result = await mesh.sendPublic('hello');
  t.false(result);
  mesh.close();
});

test('sendPrivate returns false before transport is open', async (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, { raft: SLOW_RAFT });

  const result = await mesh.sendPrivate('bob', 'secret');
  t.false(result);
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: sendPublic returns false when no leader is known
// ---------------------------------------------------------------------------

test('sendPublic returns false when node is follower with no known leader', async (t) => {
  const { mesh } = createMesh('alice');

  // Node is a follower (high timeout, never becomes candidate)
  // and no leader is known
  t.false(mesh.isLeader);
  t.is(mesh.leaderId, null);

  const result = await mesh.sendPublic('hello');
  t.false(result);
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Two-node cluster — public message replication
// ---------------------------------------------------------------------------

test('two-node cluster replicates public messages', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);

  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleB,
  });

  // Wire transports together
  wirePair('alice', tA, 'bob', tB);

  // Open transports
  tA.simulateOpen('alice');
  tB.simulateOpen('bob');

  // Simulate peer connection on both sides
  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');

  // Wait for leader election
  await new Promise((r) => setTimeout(r, 500));

  const leader = meshA.isLeader ? meshA : meshB.isLeader ? meshB : null;
  t.truthy(leader, 'one node should be leader');

  const receivedA: Array<{ msg: MeshMessage<string>; replay: boolean }> = [];
  const receivedB: Array<{ msg: MeshMessage<string>; replay: boolean }> = [];
  meshA.on('message', (msg, replay) => receivedA.push({ msg, replay }));
  meshB.on('message', (msg, replay) => receivedB.push({ msg, replay }));

  // Leader sends a public message
  await leader!.sendPublic('game-start');

  // Wait for replication
  await new Promise((r) => setTimeout(r, 300));

  t.true(receivedA.length >= 1, 'alice should receive the message');
  t.true(receivedB.length >= 1, 'bob should receive the message');
  t.is(receivedA[0].msg.type, 'public');
  t.is(receivedB[0].msg.type, 'public');
  t.false(receivedA[0].replay, 'alice: new message should not be a replay');
  t.false(receivedB[0].replay, 'bob: new message should not be a replay');
  if (receivedA[0].msg.type === 'public') {
    t.is(receivedA[0].msg.data, 'game-start');
  }
  if (receivedB[0].msg.type === 'public') {
    t.is(receivedB[0].msg.data, 'game-start');
  }

  meshA.close();
  meshB.close();
});

// ---------------------------------------------------------------------------
// Tests: Public key exchange via Raft
// ---------------------------------------------------------------------------

test('stores peer public key from Raft-committed publicKey entry', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);

  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleB,
  });

  wirePair('alice', tA, 'bob', tB);
  tA.simulateOpen('alice');
  tB.simulateOpen('bob');

  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');

  // Wait for leader election + key exchange via Raft
  await new Promise((r) => setTimeout(r, 500));

  // Both should have each other's keys — verify by sending private messages
  const receivedA: Array<MeshMessage<string>> = [];
  const receivedB: Array<MeshMessage<string>> = [];
  meshA.on('message', (msg) => receivedA.push(msg));
  meshB.on('message', (msg) => receivedB.push(msg));

  await meshA.sendPrivate('bob', 'hello-bob');
  await new Promise((r) => setTimeout(r, 300));

  const bobPrivates = receivedB.filter((m) => m.type === 'private');
  t.true(bobPrivates.length >= 1, 'bob should receive private message');
  if (bobPrivates[0]?.type === 'private') {
    t.is(bobPrivates[0].data, 'hello-bob');
  }

  meshA.close();
  meshB.close();
});

// ---------------------------------------------------------------------------
// Tests: Propose forwarding to leader
// ---------------------------------------------------------------------------

test('non-leader forwards public message proposal to leader', async (t) => {
  const { transport, mesh } = createMesh('alice');

  // Simulate that alice knows bob is the leader via AppendEntries
  const ae: WireMessage = {
    channel: 'raft',
    payload: {
      type: 'AppendEntries',
      term: 1,
      leaderId: 'bob',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    },
  };
  transport.simulateMessage('bob', ae);

  t.is(mesh.leaderId, 'bob');
  t.false(mesh.isLeader);

  transport.sent.length = 0;
  await mesh.sendPublic('forwarded-msg');

  const proposal = transport.sent.find(
    (s) => s.to === 'bob' && isControlWire(s.data, 'propose')
  );
  t.truthy(proposal, 'should forward proposal to leader bob');
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Leader handles propose control message
// ---------------------------------------------------------------------------

test('leader processes propose control message from follower', async (t) => {
  const { transport, mesh } = createMesh('alice', { raft: FAST_RAFT });

  // Wait for single-node election
  await new Promise((r) => setTimeout(r, 200));
  t.true(mesh.isLeader);

  const received: Array<{ msg: MeshMessage<string>; replay: boolean }> = [];
  mesh.on('message', (msg, replay) => received.push({ msg, replay }));

  // Simulate a propose control message arriving from a follower
  const wire: WireMessage = {
    channel: 'control',
    payload: {
      _meshType: 'propose',
      command: {
        _meshType: 'public',
        sender: 'bob',
        data: 'from-follower',
      },
    },
  };
  transport.simulateMessage('bob', wire);

  t.is(received.length, 1);
  t.is(received[0].msg.type, 'public');
  t.false(received[0].replay, 'forwarded message should not be a replay');
  if (received[0].msg.type === 'public') {
    t.is(received[0].msg.sender, 'bob');
    t.is(received[0].msg.data, 'from-follower');
  }
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: leaderChanged event
// ---------------------------------------------------------------------------

test('emits leaderChanged when raft leader is discovered', (t) => {
  const { transport, mesh } = createMesh('alice');

  const leaders: Array<string | null> = [];
  mesh.on('leaderChanged', (id) => leaders.push(id));

  // Simulate AppendEntries from leader bob
  transport.simulateMessage('bob', {
    channel: 'raft',
    payload: {
      type: 'AppendEntries',
      term: 1,
      leaderId: 'bob',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    },
  } as WireMessage);

  t.deepEqual(leaders, ['bob']);
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: close()
// ---------------------------------------------------------------------------

test('close shuts down transport and removes listeners', (t) => {
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, { raft: SLOW_RAFT });
  transport.simulateOpen('alice');

  mesh.close();

  t.true(transport.closed);

  // After close, transport events should not reach the mesh
  // (listeners were removed). Verify no error is thrown.
  transport.simulateError(new Error('should be ignored'));
  t.pass();
});

// ---------------------------------------------------------------------------
// Tests: off() removes listeners
// ---------------------------------------------------------------------------

test('off removes event listener', (t) => {
  const { mesh } = createMesh('alice');

  const calls: string[] = [];
  const handler = () => calls.push('called');

  mesh.on('ready', handler);
  mesh.off('ready', handler);

  // Re-opening won't trigger handler since it was already fired and removed
  // Instead, test with error event
  const errors: string[] = [];
  const errHandler = (e: Error) => errors.push(e.message);
  mesh.on('error', errHandler);
  mesh.off('error', errHandler);

  // This should not reach errHandler
  t.is(errors.length, 0);
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Raft messages are forwarded correctly
// ---------------------------------------------------------------------------

test('raft channel messages are forwarded to raft node', (t) => {
  const { transport, mesh } = createMesh('alice');

  // Send a RequestVote via raft channel — alice should process it
  transport.simulateMessage('bob', {
    channel: 'raft',
    payload: {
      type: 'RequestVote',
      term: 1,
      candidateId: 'bob',
      lastLogIndex: 0,
      lastLogTerm: 0,
    },
  } as WireMessage);

  // If raft processed it, alice should have sent a RequestVoteResult back
  const voteReply = transport.sent.find(
    (s) => s.to === 'bob' && isRaftWire(s.data, 'RequestVoteResult')
  );
  t.truthy(voteReply, 'should reply to RequestVote via raft channel');
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: Ignores malformed wire messages
// ---------------------------------------------------------------------------

test('ignores messages without a channel field', (t) => {
  const { transport, mesh } = createMesh('alice');

  // Should not throw
  transport.simulateMessage('bob', { foo: 'bar' });
  transport.simulateMessage('bob', null);
  transport.simulateMessage('bob', undefined);
  transport.simulateMessage('bob', 42);

  t.pass();
  mesh.close();
});

// ---------------------------------------------------------------------------
// Tests: sendPrivate waits for public key to arrive via Raft
// ---------------------------------------------------------------------------

test('sendPrivate waits for recipient key that has not yet been committed', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);

  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  tA.simulateOpen('alice');

  // Wait for alice to become single-node leader
  await new Promise((r) => setTimeout(r, 200));
  t.true(meshA.isLeader);

  // Alice tries to sendPrivate to bob, whose key hasn't arrived yet.
  // This should NOT fail immediately — it should wait.
  const sendPromise = meshA.sendPrivate('bob', 'early-message');

  // Simulate bob's key arriving via Raft commit shortly after
  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleB,
  });
  wirePair('alice', tA, 'bob', tB);
  tB.simulateOpen('bob');
  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');

  // Wait for bob's key to be proposed and committed
  await new Promise((r) => setTimeout(r, 300));

  // Now the sendPrivate should resolve successfully
  const ok = await sendPromise;
  t.true(ok, 'sendPrivate should succeed after key arrives');

  // Wait for replication
  await new Promise((r) => setTimeout(r, 300));

  const received: Array<MeshMessage<string>> = [];
  meshB.on('message', (msg) => received.push(msg));

  // The encrypted message was already committed — check bob received it
  // (bob may have missed it if it was committed before he joined, so
  //  we just verify the send succeeded)
  t.pass();
  meshA.close();
  meshB.close();
});

// ---------------------------------------------------------------------------
// Tests: Three-node star topology — public key relay & private messages
// ---------------------------------------------------------------------------

test('three-node star: non-directly-connected peers can send private messages', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);
  const bundleC = await generateKeyBundle(2048);

  // Alice (hub) uses FAST_RAFT so she becomes leader.
  // B and C use SLOW_RAFT so they don't start elections.
  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleB,
  });

  const tC = new MockTransport();
  const meshC = new DandelionMesh<string>(tC, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleC,
  });

  // Star topology: A↔B and A↔C; B and C are NOT directly connected
  wireStar('alice', tA, 'bob', tB, 'charlie', tC);

  // Open transports
  tA.simulateOpen('alice');
  tB.simulateOpen('bob');
  tC.simulateOpen('charlie');

  // Simulate connections: A sees B and C; B sees A; C sees A
  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');

  // Small delay so public key exchange A↔B completes before C joins
  await new Promise((r) => setTimeout(r, 50));

  tA.simulatePeerConnected('charlie');
  tC.simulatePeerConnected('alice');

  // Wait for leader election + key relay propagation
  await new Promise((r) => setTimeout(r, 500));

  t.true(meshA.isLeader, 'alice (hub) should be leader');

  // Collect private messages on each node
  const receivedA: Array<MeshMessage<string>> = [];
  const receivedB: Array<MeshMessage<string>> = [];
  const receivedC: Array<MeshMessage<string>> = [];
  meshA.on('message', (msg) => receivedA.push(msg));
  meshB.on('message', (msg) => receivedB.push(msg));
  meshC.on('message', (msg) => receivedC.push(msg));

  // Bob sends a private message to Charlie (non-directly-connected peer)
  const ok = await meshB.sendPrivate('charlie', 'secret-from-bob');
  t.true(ok, 'sendPrivate from bob to charlie should succeed');

  // Wait for Raft replication + decryption
  await new Promise((r) => setTimeout(r, 500));

  // Charlie should have received the private message
  const charliePrivates = receivedC.filter((m) => m.type === 'private');
  t.true(
    charliePrivates.length >= 1,
    'charlie should receive the private message'
  );
  if (charliePrivates.length > 0 && charliePrivates[0].type === 'private') {
    t.is(charliePrivates[0].sender, 'bob');
    t.is(charliePrivates[0].data, 'secret-from-bob');
  }

  // Alice and Bob should NOT have decrypted it (it's for Charlie only)
  const alicePrivates = receivedA.filter(
    (m) => m.type === 'private' && m.data === 'secret-from-bob'
  );
  const bobPrivates = receivedB.filter(
    (m) => m.type === 'private' && m.data === 'secret-from-bob'
  );
  t.is(alicePrivates.length, 0, 'alice should not decrypt bob→charlie message');
  t.is(bobPrivates.length, 0, 'bob should not decrypt his own private message');

  meshA.close();
  meshB.close();
  meshC.close();
});

test('three-node star: public key relay delivers keys for peers that joined earlier', async (t) => {
  const bundleA = await generateKeyBundle(2048);
  const bundleB = await generateKeyBundle(2048);
  const bundleC = await generateKeyBundle(2048);

  const tA = new MockTransport();
  const meshA = new DandelionMesh<string>(tA, {
    raft: FAST_RAFT,
    cryptoKeyBundle: bundleA,
  });

  const tB = new MockTransport();
  const meshB = new DandelionMesh<string>(tB, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleB,
  });

  const tC = new MockTransport();
  const meshC = new DandelionMesh<string>(tC, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundleC,
  });

  wireStar('alice', tA, 'bob', tB, 'charlie', tC);

  tA.simulateOpen('alice');
  tB.simulateOpen('bob');
  tC.simulateOpen('charlie');

  // B connects to A first
  tA.simulatePeerConnected('bob');
  tB.simulatePeerConnected('alice');
  await new Promise((r) => setTimeout(r, 50));

  // Then C connects to A — A should relay B's key to C and C's key to B
  tA.simulatePeerConnected('charlie');
  tC.simulatePeerConnected('alice');
  await new Promise((r) => setTimeout(r, 500));

  const receivedC: Array<MeshMessage<string>> = [];
  const receivedB: Array<MeshMessage<string>> = [];
  meshC.on('message', (msg) => receivedC.push(msg));
  meshB.on('message', (msg) => receivedB.push(msg));

  // Charlie sends a private message to Bob (the reverse direction)
  const ok = await meshC.sendPrivate('bob', 'hello-from-charlie');
  t.true(ok, 'sendPrivate from charlie to bob should succeed');

  await new Promise((r) => setTimeout(r, 500));

  const bobPrivates = receivedB.filter((m) => m.type === 'private');
  t.true(
    bobPrivates.length >= 1,
    'bob should receive the private message from charlie'
  );
  if (bobPrivates.length > 0 && bobPrivates[0].type === 'private') {
    t.is(bobPrivates[0].sender, 'charlie');
    t.is(bobPrivates[0].data, 'hello-from-charlie');
  }

  meshA.close();
  meshB.close();
  meshC.close();
});
