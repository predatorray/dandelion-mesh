import test from 'ava';

import {
  DataConnectionLike,
  PeerJSTransport,
  PeerJSTransportOptions,
  PeerLike,
} from './PeerJSTransport';

// ---------------------------------------------------------------------------
// Mock DataConnection
// ---------------------------------------------------------------------------

type ConnEvent = 'open' | 'data' | 'close' | 'error';

class MockDataConnection implements DataConnectionLike {
  readonly peer: string;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<
    ConnEvent,
    Array<(...args: any[]) => void>
  >();
  closed = false;

  constructor(remotePeerId: string) {
    this.peer = remotePeerId;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: ConnEvent, cb: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(cb);
  }

  // Test helpers to simulate events
  simulateOpen(): void {
    for (const cb of this.listeners.get('open') ?? []) cb();
  }

  simulateData(data: unknown): void {
    for (const cb of this.listeners.get('data') ?? []) cb(data);
  }

  simulateClose(): void {
    for (const cb of this.listeners.get('close') ?? []) cb();
  }

  simulateError(err: Error): void {
    for (const cb of this.listeners.get('error') ?? []) cb(err);
  }
}

// ---------------------------------------------------------------------------
// Mock Peer
// ---------------------------------------------------------------------------

type PeerEvent = 'open' | 'connection' | 'error' | 'close';

class MockPeer implements PeerLike {
  private readonly listeners = new Map<
    PeerEvent,
    Array<(...args: any[]) => void>
  >();
  readonly outgoingConnections: MockDataConnection[] = [];
  destroyed = false;

  on(event: PeerEvent, cb: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(cb);
  }

  connect(peerId: string, _options?: unknown): DataConnectionLike {
    const conn = new MockDataConnection(peerId);
    this.outgoingConnections.push(conn);
    return conn;
  }

  destroy(): void {
    this.destroyed = true;
  }

  // Test helpers
  simulateOpen(id: string): void {
    for (const cb of this.listeners.get('open') ?? []) cb(id);
  }

  simulateIncomingConnection(conn: MockDataConnection): void {
    for (const cb of this.listeners.get('connection') ?? []) cb(conn);
  }

  simulateError(err: Error): void {
    for (const cb of this.listeners.get('error') ?? []) cb(err);
  }

  simulateClose(): void {
    for (const cb of this.listeners.get('close') ?? []) cb();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function create(options?: PeerJSTransportOptions) {
  const mockPeer = new MockPeer();
  const transport = new PeerJSTransport(mockPeer, options);
  return { mockPeer, transport };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('open event sets localPeerId', (t) => {
  const { mockPeer, transport } = create();
  t.is(transport.localPeerId, undefined);

  mockPeer.simulateOpen('peer-1');
  t.is(transport.localPeerId, 'peer-1');
});

test('open event fires listener', (t) => {
  const { mockPeer, transport } = create();
  const ids: string[] = [];
  transport.on('open', (id) => ids.push(id));

  mockPeer.simulateOpen('peer-1');
  t.deepEqual(ids, ['peer-1']);
});

test('connectedPeers starts empty', (t) => {
  const { transport } = create();
  t.deepEqual([...transport.connectedPeers], []);
});

test('connect adds peer after connection opens', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  // Not yet connected (pending)
  t.deepEqual([...transport.connectedPeers], []);

  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['remote']);
});

test('connect is idempotent for existing connection', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateOpen();

  transport.connect('remote'); // should be no-op
  t.is(mockPeer.outgoingConnections.length, 1);
});

test('connect is idempotent for pending connection', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  transport.connect('remote'); // still pending, should be no-op
  t.is(mockPeer.outgoingConnections.length, 1);
});

test('peerConnected event fires on connection open', (t) => {
  const { mockPeer, transport } = create();
  const connected: string[] = [];
  transport.on('peerConnected', (id) => connected.push(id));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateOpen();

  t.deepEqual(connected, ['remote']);
});

test('incoming connection fires peerConnected', (t) => {
  const { mockPeer, transport } = create();
  const connected: string[] = [];
  transport.on('peerConnected', (id) => connected.push(id));
  mockPeer.simulateOpen('local');

  const incomingConn = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(incomingConn);
  incomingConn.simulateOpen();

  t.deepEqual(connected, ['remote']);
  t.deepEqual([...transport.connectedPeers], ['remote']);
});

test('send delivers data to the correct connection', async (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();

  await transport.send('remote', { hello: 'world' });
  t.deepEqual(conn.sent, [{ hello: 'world' }]);
});

test('send throws for unknown peer', async (t) => {
  const { transport } = create();
  await t.throwsAsync(() => transport.send('unknown', 'data'), {
    message: /No connection to peer/,
  });
});

test('broadcast sends to all connected peers', async (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('A');
  transport.connect('B');
  mockPeer.outgoingConnections[0]!.simulateOpen();
  mockPeer.outgoingConnections[1]!.simulateOpen();

  await transport.broadcast('msg');
  t.deepEqual(mockPeer.outgoingConnections[0]!.sent, ['msg']);
  t.deepEqual(mockPeer.outgoingConnections[1]!.sent, ['msg']);
});

test('message event fires on incoming data', (t) => {
  const { mockPeer, transport } = create();
  const messages: Array<{ from: string; data: unknown }> = [];
  transport.on('message', (from, data) => messages.push({ from, data }));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();
  conn.simulateData({ type: 'ping' });

  t.deepEqual(messages, [{ from: 'remote', data: { type: 'ping' } }]);
});

test('peerDisconnected fires on connection close', (t) => {
  const { mockPeer, transport } = create();
  const disconnected: string[] = [];
  transport.on('peerDisconnected', (id) => disconnected.push(id));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();
  conn.simulateClose();

  t.deepEqual(disconnected, ['remote']);
  t.deepEqual([...transport.connectedPeers], []);
});

test('connection error event propagates', (t) => {
  const { mockPeer, transport } = create();
  const errors: Error[] = [];
  transport.on('error', (err) => errors.push(err));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateError(new Error('conn fail'));

  t.is(errors.length, 1);
  t.is(errors[0]!.message, 'conn fail');
});

test('peer-level error event propagates', (t) => {
  const { mockPeer, transport } = create();
  const errors: Error[] = [];
  transport.on('error', (err) => errors.push(err));

  mockPeer.simulateError(new Error('peer fail'));
  t.is(errors.length, 1);
  t.is(errors[0]!.message, 'peer fail');
});

test('close event fires and cleans up', (t) => {
  const { mockPeer, transport } = create();
  let closed = false;
  transport.on('close', () => {
    closed = true;
  });

  mockPeer.simulateClose();
  t.true(closed);
});

test('close() destroys peer and closes connections', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();

  transport.close();
  t.true(conn.closed);
  t.true(mockPeer.destroyed);
  t.deepEqual([...transport.connectedPeers], []);
});

test('off removes listener', (t) => {
  const { mockPeer, transport } = create();
  const ids: string[] = [];
  const listener = (id: string) => ids.push(id);
  transport.on('open', listener);
  transport.off('open', listener);

  mockPeer.simulateOpen('peer-1');
  t.deepEqual(ids, []);
});

test('simultaneous connect: local < remote keeps existing', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('A'); // 'A' < 'Z'

  // First connection (outgoing)
  transport.connect('Z');
  const outgoing = mockPeer.outgoingConnections[0]!;
  outgoing.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['Z']);

  // Second connection (incoming) for the same remote peer
  const incoming = new MockDataConnection('Z');
  mockPeer.simulateIncomingConnection(incoming);
  incoming.simulateOpen();

  // local 'A' < remote 'Z' → keep existing, close new
  t.true(incoming.closed);
  t.false(outgoing.closed);
  t.deepEqual([...transport.connectedPeers], ['Z']);
});

test('simultaneous connect: local > remote replaces existing', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('Z'); // 'Z' > 'A'

  // First connection (outgoing)
  transport.connect('A');
  const outgoing = mockPeer.outgoingConnections[0]!;
  outgoing.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['A']);

  // Second connection (incoming) for the same remote peer
  const incoming = new MockDataConnection('A');
  mockPeer.simulateIncomingConnection(incoming);
  incoming.simulateOpen();

  // local 'Z' > remote 'A' → replace existing with new
  t.true(outgoing.closed);
  t.false(incoming.closed);
  t.deepEqual([...transport.connectedPeers], ['A']);
});

// ---------------------------------------------------------------------------
// Linked mock connections — a two-ended DataConnection where closing one end
// asynchronously closes the other end, like a real WebRTC data channel.
// ---------------------------------------------------------------------------

class LinkedMockConnection implements DataConnectionLike {
  readonly peer: string;
  other: LinkedMockConnection | null = null;
  closed = false;
  private readonly listeners = new Map<
    ConnEvent,
    Array<(...args: any[]) => void>
  >();

  constructor(remotePeerId: string) {
    this.peer = remotePeerId;
  }

  /**
   * Create a linked pair for a connection between peers `idA` and `idB`.
   * Returns [endpoint held by A, endpoint held by B].
   */
  static pair(
    idA: string,
    idB: string
  ): [LinkedMockConnection, LinkedMockConnection] {
    const atA = new LinkedMockConnection(idB);
    const atB = new LinkedMockConnection(idA);
    atA.other = atB;
    atB.other = atA;
    return [atA, atB];
  }

  send(data: unknown): void {
    const other = this.other;
    if (other && !other.closed) {
      setTimeout(() => other.fire('data', data), 0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
    const other = this.other;
    if (other && !other.closed) {
      setTimeout(() => other.close(), 0);
    }
  }

  on(event: ConnEvent, cb: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(cb);
  }

  simulateOpen(): void {
    this.fire('open');
  }

  private fire(event: ConnEvent, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

class LinkedPeer implements PeerLike {
  private readonly listeners = new Map<
    PeerEvent,
    Array<(...args: any[]) => void>
  >();
  private readonly queued: LinkedMockConnection[] = [];
  readonly dialed: DataConnectionLike[] = [];
  destroyed = false;

  queueOutgoing(conn: LinkedMockConnection): void {
    this.queued.push(conn);
  }

  on(event: PeerEvent, cb: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(cb);
  }

  connect(peerId: string, _options?: unknown): DataConnectionLike {
    const conn = this.queued.shift() ?? new LinkedMockConnection(peerId);
    this.dialed.push(conn);
    return conn;
  }

  destroy(): void {
    this.destroyed = true;
  }

  simulateOpen(id: string): void {
    for (const cb of this.listeners.get('open') ?? []) cb(id);
  }

  simulateIncomingConnection(conn: LinkedMockConnection): void {
    for (const cb of this.listeners.get('connection') ?? []) cb(conn);
  }
}

// ---------------------------------------------------------------------------
// Split brain: simultaneous connect with divergent 'open' ordering
// ---------------------------------------------------------------------------

test('simultaneous connect with divergent open order keeps both peers connected (split-brain reproduction)', async (t) => {
  const peerA = new LinkedPeer();
  const peerZ = new LinkedPeer();
  const tA = new PeerJSTransport(peerA);
  const tZ = new PeerJSTransport(peerZ);
  peerA.simulateOpen('A');
  peerZ.simulateOpen('Z');

  const disconnectedA: string[] = [];
  const disconnectedZ: string[] = [];
  tA.on('peerDisconnected', (id) => disconnectedA.push(id));
  tZ.on('peerDisconnected', (id) => disconnectedZ.push(id));

  // Connection initiated by A (outgoing at A, incoming at Z)
  const [abAtA, abAtZ] = LinkedMockConnection.pair('A', 'Z');
  // Connection initiated by Z (incoming at A, outgoing at Z)
  const [zaAtA, zaAtZ] = LinkedMockConnection.pair('A', 'Z');

  // Both peers dial each other at the same time.
  peerA.queueOutgoing(abAtA);
  peerZ.queueOutgoing(zaAtZ);
  tA.connect('Z');
  tZ.connect('A');
  peerZ.simulateIncomingConnection(abAtZ);
  peerA.simulateIncomingConnection(zaAtA);

  // The 'open' events race differently on each side: on A the A→Z connection
  // opens first, while on Z the Z→A connection opens last. With an
  // arrival-order-dependent tie-break, A keeps A→Z while Z keeps Z→A; each
  // side then closes the connection the other side kept, disconnecting the
  // two peers entirely — the mesh partitions and each partition elects its
  // own Raft leader (split brain).
  abAtA.simulateOpen();
  abAtZ.simulateOpen();
  zaAtA.simulateOpen();
  zaAtZ.simulateOpen();

  // Let duplicate-close events propagate to the other end.
  await sleep(50);

  t.deepEqual([...tA.connectedPeers], ['Z'], 'A must remain connected to Z');
  t.deepEqual([...tZ.connectedPeers], ['A'], 'Z must remain connected to A');
  t.deepEqual(disconnectedA, [], 'A must not observe a disconnect');
  t.deepEqual(disconnectedZ, [], 'Z must not observe a disconnect');

  tA.close();
  tZ.close();
});

// ---------------------------------------------------------------------------
// Retry: failed connection attempts must be retried
// ---------------------------------------------------------------------------

test('connect() can dial again after a failed attempt (no stale pending entry)', (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 0 },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 1);

  // The connection attempt fails before it ever opens.
  mockPeer.outgoingConnections[0]!.simulateError(new Error('peer-unavailable'));

  // A manual reconnect must start a fresh attempt instead of being a no-op
  // because of a stale pendingConnections entry.
  transport.connect('remote');
  t.is(
    mockPeer.outgoingConnections.length,
    2,
    'connect() after a failed attempt should dial again'
  );
  transport.close();
});

test('failed connection attempt is retried automatically with backoff', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 20 },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 1);
  mockPeer.outgoingConnections[0]!.simulateError(new Error('ICE failed'));

  await sleep(50);
  t.true(
    mockPeer.outgoingConnections.length >= 2,
    'a retry attempt should have been made automatically'
  );

  // The retry succeeds.
  mockPeer.outgoingConnections[1]!.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['remote']);
  transport.close();
});

test('gives up after maxRetries and reports an error', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 1, initialDelayMs: 5, maxDelayMs: 10 },
  });
  const errors: Error[] = [];
  transport.on('error', (err) => errors.push(err));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateError(new Error('fail-1'));
  await sleep(30);
  t.is(mockPeer.outgoingConnections.length, 2, 'one retry should be made');
  mockPeer.outgoingConnections[1]!.simulateError(new Error('fail-2'));
  await sleep(30);

  t.is(mockPeer.outgoingConnections.length, 2, 'no attempts beyond maxRetries');
  t.true(
    errors.some((e) => /after 1 retr/.test(e.message)),
    'should report giving up'
  );
  transport.close();
});

test('re-establishes a dropped connection automatically (reconnect on drop)', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 10 },
  });
  const disconnected: string[] = [];
  const connected: string[] = [];
  transport.on('peerDisconnected', (id) => disconnected.push(id));
  transport.on('peerConnected', (id) => connected.push(id));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateOpen();
  t.deepEqual(connected, ['remote']);

  // The established connection drops unexpectedly (e.g. transient network).
  mockPeer.outgoingConnections[0]!.simulateClose();
  t.deepEqual(disconnected, ['remote']);

  await sleep(40);
  t.true(
    mockPeer.outgoingConnections.length >= 2,
    'a reconnect attempt should have been made automatically'
  );
  mockPeer.outgoingConnections[1]!.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['remote']);
  t.deepEqual(connected, ['remote', 'remote']);
  transport.close();
});

test('pending connection that never opens times out and is retried', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: {
      maxRetries: 1,
      initialDelayMs: 5,
      maxDelayMs: 10,
      openTimeoutMs: 20,
    },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 1);

  await sleep(60);
  t.true(
    mockPeer.outgoingConnections[0]!.closed,
    'the stuck pending connection should be closed'
  );
  t.true(
    mockPeer.outgoingConnections.length >= 2,
    'a new attempt should be made after the open timeout'
  );
  transport.close();
});

test('no retries are attempted after close()', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 3, initialDelayMs: 5, maxDelayMs: 10 },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateError(new Error('fail'));
  transport.close();

  await sleep(40);
  t.is(mockPeer.outgoingConnections.length, 1, 'no retry after close()');
});

test('failed incoming connection does not trigger outgoing retries', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 3, initialDelayMs: 5, maxDelayMs: 10 },
  });
  mockPeer.simulateOpen('local');

  const incoming = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(incoming);
  incoming.simulateError(new Error('fail'));

  await sleep(40);
  t.is(
    mockPeer.outgoingConnections.length,
    0,
    'the remote initiator is responsible for retrying'
  );
  transport.close();
});

test('connect() after close() is a no-op', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  transport.close();
  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 0);
});

test('a pending incoming connection does not block an outgoing dial', (t) => {
  const { mockPeer, transport } = create();
  mockPeer.simulateOpen('local');

  // An incoming connection is pending (not yet open)...
  const incoming = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(incoming);

  // ...which must not prevent us from dialing out.
  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 1);
  transport.close();
});

test('duplicate open events on the same connection are ignored', (t) => {
  const { mockPeer, transport } = create();
  const connected: string[] = [];
  transport.on('peerConnected', (id) => connected.push(id));
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateOpen();
  conn.simulateOpen();

  t.deepEqual(connected, ['remote']);
  t.deepEqual([...transport.connectedPeers], ['remote']);
  transport.close();
});

test('pending connection closed before opening is retried', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 1, initialDelayMs: 5, maxDelayMs: 10 },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  // The connection closes without ever opening (and without an error event).
  mockPeer.outgoingConnections[0]!.simulateClose();

  await sleep(30);
  t.true(
    mockPeer.outgoingConnections.length >= 2,
    'a retry attempt should have been made'
  );
  transport.close();
});

test('remote redial replaces the previous incoming connection', (t) => {
  const { mockPeer, transport } = create();
  const disconnected: string[] = [];
  transport.on('peerDisconnected', (id) => disconnected.push(id));
  mockPeer.simulateOpen('local');

  const first = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(first);
  first.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['remote']);

  // The remote reconnects (e.g. after a silent drop on its side): the new
  // incoming connection supersedes the stale one.
  const second = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(second);
  second.simulateOpen();

  t.true(first.closed, 'stale connection should be closed');
  t.false(second.closed);
  t.deepEqual([...transport.connectedPeers], ['remote']);
  t.deepEqual(disconnected, [], 'replacement should not emit peerDisconnected');
  transport.close();
});

test('error followed by close on the same attempt is handled once', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: {
      maxRetries: 1,
      initialDelayMs: 10000,
      openTimeoutMs: 0,
    },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  const conn = mockPeer.outgoingConnections[0]!;
  conn.simulateError(new Error('fail'));
  conn.simulateClose(); // PeerJS may fire both; must not double-schedule

  await sleep(30);
  // The single scheduled retry has a long delay, so no new dial yet, and the
  // duplicate failure must not have consumed a second retry attempt.
  t.is(mockPeer.outgoingConnections.length, 1);
  transport.close();
});

test('failed attempt is not retried when the peer is already connected', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 3, initialDelayMs: 5, maxDelayMs: 10 },
  });
  mockPeer.simulateOpen('local');

  // We dial out, but before our attempt opens, the remote's incoming
  // connection opens and becomes the active connection.
  transport.connect('remote');
  const incoming = new MockDataConnection('remote');
  mockPeer.simulateIncomingConnection(incoming);
  incoming.simulateOpen();
  t.deepEqual([...transport.connectedPeers], ['remote']);

  // Our own attempt then fails — no retry is needed.
  mockPeer.outgoingConnections[0]!.simulateError(new Error('fail'));
  await sleep(30);
  t.is(mockPeer.outgoingConnections.length, 1, 'no retry when connected');
  t.deepEqual([...transport.connectedPeers], ['remote']);
  transport.close();
});

test('connect() cancels a scheduled retry and dials immediately', async (t) => {
  const { mockPeer, transport } = create({
    connectionRetry: { maxRetries: 3, initialDelayMs: 10000 },
  });
  mockPeer.simulateOpen('local');

  transport.connect('remote');
  mockPeer.outgoingConnections[0]!.simulateError(new Error('fail'));
  // A retry is now scheduled far in the future; a manual connect() should
  // cancel it and dial right away.
  transport.connect('remote');
  t.is(mockPeer.outgoingConnections.length, 2);

  await sleep(30);
  t.is(mockPeer.outgoingConnections.length, 2, 'no duplicate dial from timer');
  transport.close();
});

test('scheduleRetry does not double-schedule and is a no-op after close', (t) => {
  const { transport } = create({
    connectionRetry: { maxRetries: 3, initialDelayMs: 10000 },
  });
  const internal = transport as unknown as {
    scheduleRetry(remotePeerId: string): void;
    retryTimers: Map<string, unknown>;
  };

  internal.scheduleRetry('remote');
  internal.scheduleRetry('remote'); // already scheduled — must be a no-op
  t.is(internal.retryTimers.size, 1);

  transport.close();
  t.is(internal.retryTimers.size, 0);
  internal.scheduleRetry('remote'); // closed — must be a no-op
  t.is(internal.retryTimers.size, 0);
});

test('close of a replaced connection does not emit peerDisconnected', (t) => {
  const { mockPeer, transport } = create();
  const disconnected: string[] = [];
  transport.on('peerDisconnected', (id) => disconnected.push(id));
  mockPeer.simulateOpen('Z');

  transport.connect('A');
  const outgoing = mockPeer.outgoingConnections[0]!;
  outgoing.simulateOpen();

  const incoming = new MockDataConnection('A');
  mockPeer.simulateIncomingConnection(incoming);
  incoming.simulateOpen(); // replaces outgoing

  // Now the old outgoing fires close — should NOT emit peerDisconnected
  outgoing.simulateClose();
  t.deepEqual(disconnected, []);
  t.deepEqual([...transport.connectedPeers], ['A']);
});
