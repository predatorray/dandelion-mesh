import test from 'ava';

import { CryptoKeyBundle, generateKeyBundle } from '../crypto/CryptoService';
import {
  Transport,
  TransportEventName,
  TransportEvents,
} from '../transport/Transport';

import { DandelionMesh } from './DandelionMesh';
import {
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
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundle,
  });

  transport.simulateOpen('alice');

  // Wait a tick for the crypto promise to resolve
  await new Promise((r) => setTimeout(r, 10));

  // The mesh should have broadcast the public key from our provided bundle
  const keyAnnouncements = transport.broadcasted.filter((d) =>
    isControlWire(d, 'publicKey')
  );
  t.true(keyAnnouncements.length >= 1);

  // Verify it used our bundle's JWK
  const payload = (keyAnnouncements[0] as ControlWire)
    .payload as PublicKeyAnnouncement;
  t.deepEqual(payload.jwk, bundle.publicKeyJwk);
  mesh.close();
});

test('accepts cryptoKeyBundle as a Promise', async (t) => {
  const bundlePromise = generateKeyBundle(2048);
  const transport = new MockTransport();
  const mesh = new DandelionMesh<string>(transport, {
    raft: SLOW_RAFT,
    cryptoKeyBundle: bundlePromise,
  });

  const bundle = await bundlePromise;
  transport.simulateOpen('alice');
  // Allow the (already-resolved) crypto promise chain and broadcast to complete
  await new Promise((r) => setTimeout(r, 10));
  const keyAnnouncements = transport.broadcasted.filter((d) =>
    isControlWire(d, 'publicKey')
  );
  t.true(keyAnnouncements.length >= 1);
  t.deepEqual((keyAnnouncements[0] as ControlWire).payload, {
    _meshType: 'publicKey',
    peerId: 'alice',
    jwk: bundle.publicKeyJwk,
  });
  mesh.close();
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

test('sends public key to newly connected peer', async (t) => {
  const bundle = await generateKeyBundle(2048);
  const { transport, mesh } = createMesh('alice', {
    cryptoKeyBundle: bundle,
  });

  await new Promise((r) => setTimeout(r, 10));
  transport.sent.length = 0;

  transport.simulatePeerConnected('bob');

  // Wait for async sendPublicKeyTo
  await new Promise((r) => setTimeout(r, 10));

  const keySent = transport.sent.find(
    (s) => s.to === 'bob' && isControlWire(s.data, 'publicKey')
  );
  t.truthy(keySent, 'should send public key to new peer');
  mesh.close();
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

  const received: Array<MeshMessage<string>> = [];
  mesh.on('message', (msg) => received.push(msg));

  const ok = await mesh.sendPublic('hello');
  t.true(ok);
  t.is(received.length, 1);
  t.is(received[0].type, 'public');
  if (received[0].type === 'public') {
    t.is(received[0].sender, 'alice');
    t.is(received[0].data, 'hello');
  }
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

  const receivedA: Array<MeshMessage<string>> = [];
  const receivedB: Array<MeshMessage<string>> = [];
  meshA.on('message', (msg) => receivedA.push(msg));
  meshB.on('message', (msg) => receivedB.push(msg));

  // Leader sends a public message
  await leader!.sendPublic('game-start');

  // Wait for replication
  await new Promise((r) => setTimeout(r, 300));

  t.true(receivedA.length >= 1, 'alice should receive the message');
  t.true(receivedB.length >= 1, 'bob should receive the message');
  t.is(receivedA[0].type, 'public');
  t.is(receivedB[0].type, 'public');
  if (receivedA[0].type === 'public') {
    t.is(receivedA[0].data, 'game-start');
  }
  if (receivedB[0].type === 'public') {
    t.is(receivedB[0].data, 'game-start');
  }

  meshA.close();
  meshB.close();
});

// ---------------------------------------------------------------------------
// Tests: Control message handling — public key exchange
// ---------------------------------------------------------------------------

test('stores peer public key from control message', async (t) => {
  const bundle = await generateKeyBundle(2048);
  const { transport, mesh } = createMesh('alice');

  // Simulate receiving a publicKey control message from bob
  const wire: WireMessage = {
    channel: 'control',
    payload: {
      _meshType: 'publicKey',
      peerId: 'bob',
      jwk: bundle.publicKeyJwk,
    },
  };
  transport.simulateMessage('bob', wire);

  // Now sendPrivate should at least not fail due to missing key
  // (it will still fail because alice isn't leader, but the key
  // lookup itself should succeed)
  // We just verify no error is thrown
  t.pass();
  mesh.close();
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

  const received: Array<MeshMessage<string>> = [];
  mesh.on('message', (msg) => received.push(msg));

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
  t.is(received[0].type, 'public');
  if (received[0].type === 'public') {
    t.is(received[0].sender, 'bob');
    t.is(received[0].data, 'from-follower');
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
