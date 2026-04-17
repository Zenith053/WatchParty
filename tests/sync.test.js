/**
 * tests/sync.test.js
 * Integration tests for syncService WebSocket hub (FR-02, FR-03, FR-04, FR-05, FR-06, FR-07)
 * Spins up a real ws.Server on a random port; uses ws client.
 */
'use strict';

// Mock DB and stateStore so tests run without real Postgres/Redis
jest.mock('../server/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query:  jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../server/stateStore', () => {
  const store = new Map();
  return {
    setState:   jest.fn(async (id, snap) => store.set(id, { ...(store.get(id) ?? {}), ...snap })),
    getState:   jest.fn(async (id) => store.get(id) ?? null),
    deleteState:jest.fn(async (id) => store.delete(id)),
  };
});

jest.mock('../server/roomService', () => ({
  createRoom:     jest.fn(),
  joinRoom:       jest.fn(),
  promoteToHost:  jest.fn().mockResolvedValue(undefined),
  getMemberCount: jest.fn().mockResolvedValue(2),
}));

// Mock queueService for integration tests
const mockQueueStore = [];
let mockQueueId = 100;
const mockQueueVotes = new Map();
const mockSkipVotes  = new Map();

jest.mock('../server/queueService', () => ({
  addToQueue:     jest.fn(async (roomId, url, userId) => {
    const entry = { id: mockQueueId++, room_id: roomId, url, added_by: userId, upvotes: 0, added_at: new Date().toISOString() };
    mockQueueStore.push(entry);
    return entry;
  }),
  upvoteQueue:    jest.fn(async (queueId, userId) => {
    const key = `${queueId}-${userId}`;
    if (mockQueueVotes.has(key)) return { success: false, error: 'Already upvoted' };
    mockQueueVotes.set(key, true);
    const entry = mockQueueStore.find(e => e.id === queueId);
    if (entry) entry.upvotes++;
    return { success: true, upvotes: entry?.upvotes ?? 0 };
  }),
  getQueue:       jest.fn(async (roomId) =>
    mockQueueStore.filter(e => e.room_id === roomId).sort((a, b) => b.upvotes - a.upvotes)
  ),
  popTopEntry:    jest.fn(async (roomId) => {
    const sorted = mockQueueStore.filter(e => e.room_id === roomId).sort((a, b) => b.upvotes - a.upvotes);
    if (sorted.length === 0) return null;
    const top = sorted[0];
    const idx = mockQueueStore.findIndex(e => e.id === top.id);
    mockQueueStore.splice(idx, 1);
    return top;
  }),
  removeFromQueue: jest.fn(async (queueId) => {
    const idx = mockQueueStore.findIndex(e => e.id === queueId);
    if (idx >= 0) mockQueueStore.splice(idx, 1);
  }),
  voteSkip:       jest.fn(async (roomId, userId) => {
    const key = `${roomId}-${userId}`;
    if (mockSkipVotes.has(key)) return { success: false, count: 0, error: 'Already voted to skip' };
    mockSkipVotes.set(key, true);
    let count = 0;
    for (const k of mockSkipVotes.keys()) { if (k.startsWith(`${roomId}-`)) count++; }
    return { success: true, count };
  }),
  getSkipCount:    jest.fn(async () => 0),
  checkSkipMajority: jest.fn((count, total) => count > total / 2),
  clearSkipVotes:  jest.fn(async (roomId) => {
    for (const k of [...mockSkipVotes.keys()]) { if (k.startsWith(`${roomId}-`)) mockSkipVotes.delete(k); }
  }),
}));

const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { handleConnection } = require('../server/syncService');

// ── Test helpers ──────────────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss    = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
    wss.on('connection', handleConnection);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, wss, port });
    });
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('open',  () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMsg(ws) {
  return new Promise((resolve) => {
    ws.once('message', data => resolve(JSON.parse(data)));
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

/**
 * Drain messages until we find one matching the given type, or timeout.
 */
async function waitForMsg(ws, type, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await Promise.race([
      nextMsg(ws),
      new Promise(r => setTimeout(() => r({ type: '__timeout__' }), 300)),
    ]);
    if (msg.type === type) return msg;
    if (msg.type === '__timeout__') continue;
  }
  return null;
}

// ── Suite setup ───────────────────────────────────────────────────────────

let server, port;
const ROOM = 'test-room-001';

beforeAll(async () => ({ server, port } = await startServer()));
afterAll(()  => server.close());

beforeEach(() => {
  mockQueueStore.length = 0;
  mockQueueVotes.clear();
  mockSkipVotes.clear();
  mockQueueId = 100;
});

// ── FR-04: Role gating ────────────────────────────────────────────────────

describe('FR-04 Role gating', () => {
  test('guest PLAY is rejected with ERROR', async () => {
    const ws = await connect(port);
    send(ws, { type: 'JOIN', roomId: `${ROOM}-gate`, userId: 'g1', role: 'guest', displayName: 'Guest1' });

    // Consume MEMBER_LIST
    await nextMsg(ws);

    send(ws, { type: 'PLAY', position: 0 });
    const msg = await nextMsg(ws);
    expect(msg.type).toBe('ERROR');
    expect(msg.message).toMatch(/host/i);
    ws.close();
  });
});

// ── FR-02: Playback sync broadcast ───────────────────────────────────────

describe('FR-02 Playback sync', () => {
  test('host PLAY broadcasts to guest', async () => {
    const rid = `${ROOM}-sync`;
    const [hostWs, guestWs] = await Promise.all([connect(port), connect(port)]);

    send(hostWs,  { type: 'JOIN', roomId: rid, userId: 'h1', role: 'host',  displayName: 'Host' });
    send(guestWs, { type: 'JOIN', roomId: rid, userId: 'g2', role: 'guest', displayName: 'Guest' });

    // Wait for member-list messages to settle (both clients joined)
    await Promise.all([nextMsg(hostWs), nextMsg(guestWs)]);

    // If a second MEMBER_LIST arrived, consume it
    const extra = await Promise.race([
      nextMsg(guestWs),
      new Promise(r => setTimeout(() => r(null), 100)),
    ]);

    send(hostWs, { type: 'PLAY', position: 42 });

    const guestMsg = extra?.type === 'PLAY' ? extra : await nextMsg(guestWs);
    expect(guestMsg.type).toBe('PLAY');
    expect(guestMsg.position).toBe(42);

    hostWs.close();
    guestWs.close();
  });

  test('host PAUSE is broadcast to all guests', async () => {
    const rid = `${ROOM}-pause`;
    const host  = await connect(port);
    const guest = await connect(port);

    send(host,  { type: 'JOIN', roomId: rid, userId: 'h2', role: 'host',  displayName: 'Hostess' });
    send(guest, { type: 'JOIN', roomId: rid, userId: 'g3', role: 'guest', displayName: 'Viewer' });
    await Promise.all([nextMsg(host), nextMsg(guest)]);

    send(host, { type: 'PAUSE', position: 99 });

    const msgs = await Promise.race([
      nextMsg(guest),
      new Promise(r => setTimeout(() => r(null), 500)),
    ]);

    // Could be a second MEMBER_LIST or the PAUSE — drain until PAUSE
    const received = msgs?.type === 'PAUSE' ? msgs : await nextMsg(guest);
    expect(received.type).toBe('PAUSE');
    expect(received.position).toBe(99);

    host.close(); guest.close();
  });
});

// ── FR-03: Late-join catch-up ─────────────────────────────────────────────

describe('FR-03 Late-join catch-up', () => {
  test('late joiner receives CATCHUP with stored position', async () => {
    const { setState } = require('../server/stateStore');
    const rid = `${ROOM}-catchup`;

    // Pre-seed state as if playback is in progress
    await setState(rid, { url: 'https://www.youtube-nocookie.com/embed/abc', position: 222, status: 'playing' });

    const ws = await connect(port);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'late1', role: 'guest', displayName: 'LateJoiner' });

    const catchup = await waitForMsg(ws, 'CATCHUP');

    expect(catchup).not.toBeNull();
    expect(catchup.position).toBe(222);
    expect(catchup.status).toBe('playing');
    ws.close();
  });
});

// ── FR-05: Queue via WebSocket ───────────────────────────────────────────

describe('FR-05 Queue via WebSocket', () => {
  test('QUEUE_ADD broadcasts QUEUE_UPDATE to all members', async () => {
    const rid = `${ROOM}-qadd`;
    const [hostWs, guestWs] = await Promise.all([connect(port), connect(port)]);

    send(hostWs,  { type: 'JOIN', roomId: rid, userId: 'qh1', role: 'host',  displayName: 'QHost' });
    send(guestWs, { type: 'JOIN', roomId: rid, userId: 'qg1', role: 'guest', displayName: 'QGuest' });

    // Drain join messages
    await waitForMsg(hostWs, 'MEMBER_LIST');
    await waitForMsg(guestWs, 'MEMBER_LIST');

    send(guestWs, { type: 'QUEUE_ADD', url: 'https://youtube.com/watch?v=test1' });

    // Both should receive QUEUE_UPDATE
    const hostUpdate = await waitForMsg(hostWs, 'QUEUE_UPDATE');
    expect(hostUpdate).not.toBeNull();
    expect(hostUpdate.queue.length).toBe(1);
    expect(hostUpdate.queue[0].url).toContain('test1');

    hostWs.close();
    guestWs.close();
  });

  test('QUEUE_UPVOTE updates vote count for all members', async () => {
    const rid = `${ROOM}-qup`;
    const [hostWs, guestWs] = await Promise.all([connect(port), connect(port)]);

    send(hostWs,  { type: 'JOIN', roomId: rid, userId: 'qh2', role: 'host',  displayName: 'QHost2' });
    send(guestWs, { type: 'JOIN', roomId: rid, userId: 'qg2', role: 'guest', displayName: 'QGuest2' });

    await waitForMsg(hostWs, 'MEMBER_LIST');
    await waitForMsg(guestWs, 'MEMBER_LIST');

    // Add an entry first
    send(hostWs, { type: 'QUEUE_ADD', url: 'https://youtube.com/watch?v=uv' });
    const addUpdate = await waitForMsg(guestWs, 'QUEUE_UPDATE');
    const queueId = addUpdate.queue[0].id;

    // Upvote from guest
    send(guestWs, { type: 'QUEUE_UPVOTE', queueId });
    const upUpdate = await waitForMsg(hostWs, 'QUEUE_UPDATE');
    expect(upUpdate).not.toBeNull();
    expect(upUpdate.queue[0].upvotes).toBe(1);

    hostWs.close();
    guestWs.close();
  });

  test('non-host QUEUE_REMOVE is rejected', async () => {
    const rid = `${ROOM}-qrem`;
    const guestWs = await connect(port);

    send(guestWs, { type: 'JOIN', roomId: rid, userId: 'qg3', role: 'guest', displayName: 'QGuest3' });
    await waitForMsg(guestWs, 'MEMBER_LIST');

    send(guestWs, { type: 'QUEUE_REMOVE', queueId: 999 });
    const err = await waitForMsg(guestWs, 'ERROR');
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/host/i);

    guestWs.close();
  });
});

// ── FR-06: Skip Vote via WebSocket ───────────────────────────────────────

describe('FR-06 Skip Vote via WebSocket', () => {
  test('SKIP_VOTE broadcasts SKIP_STATUS to all members', async () => {
    const rid = `${ROOM}-skip`;
    const [hostWs, guestWs] = await Promise.all([connect(port), connect(port)]);

    send(hostWs,  { type: 'JOIN', roomId: rid, userId: 'sh1', role: 'host',  displayName: 'SkipHost' });
    send(guestWs, { type: 'JOIN', roomId: rid, userId: 'sg1', role: 'guest', displayName: 'SkipGuest' });

    await waitForMsg(hostWs, 'MEMBER_LIST');
    await waitForMsg(guestWs, 'MEMBER_LIST');

    send(guestWs, { type: 'SKIP_VOTE' });

    const status = await waitForMsg(hostWs, 'SKIP_STATUS');
    expect(status).not.toBeNull();
    expect(status.count).toBe(1);
    expect(status.needed).toBeGreaterThan(0);

    hostWs.close();
    guestWs.close();
  });
});

// ── FR-07: Host migration ─────────────────────────────────────────────────

describe('FR-07 Host migration', () => {
  test('guest is promoted within 3 s when host disconnects', async () => {
    const rid = `${ROOM}-migrate`;
    const host  = await connect(port);
    const guest = await connect(port);

    send(host,  { type: 'JOIN', roomId: rid, userId: 'h3', role: 'host',  displayName: 'LeadHost' });
    send(guest, { type: 'JOIN', roomId: rid, userId: 'g4', role: 'guest', displayName: 'WillBeHost' });

    await Promise.all([nextMsg(host), nextMsg(guest)]);
    // Consume possible second MEMBER_LIST
    await Promise.race([nextMsg(guest), new Promise(r => setTimeout(r, 100))]);

    host.close(); // simulate host disconnect

    // Guest should receive HOST_PROMOTED within 3 s
    const promoted = await Promise.race([
      (async () => {
        let msg;
        while ((msg = await nextMsg(guest)).type !== 'HOST_PROMOTED') { /* drain */ }
        return msg;
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3500)),
    ]);

    expect(promoted.type).toBe('HOST_PROMOTED');
    guest.close();
    // Allow cleanup logs to fire before Jest exits
    await new Promise(r => setTimeout(r, 200));
  }, 5000 /* allow 5 s for this test */);
});
