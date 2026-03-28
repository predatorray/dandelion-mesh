import test from 'ava';

import {
  DataConnectionLike,
  PeerJSTransport,
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

function create() {
  const mockPeer = new MockPeer();
  const transport = new PeerJSTransport(mockPeer);
  return { mockPeer, transport };
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
