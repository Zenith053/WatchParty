/**
 * tests/sync.test.js
 * Integration tests for syncService WebSocket hub (FR-02, FR-03, FR-04, FR-07)
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
  createRoom:    jest.fn(),
  joinRoom:      jest.fn(),
  promoteToHost: jest.fn().mockResolvedValue(undefined),
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

// ── Suite setup ───────────────────────────────────────────────────────────

let server, port;
const ROOM = 'test-room-001';

beforeAll(async () => ({ server, port } = await startServer()));
afterAll(()  => server.close());

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

    let catchup = null;
    const deadline = Date.now() + 2000;
    while (!catchup && Date.now() < deadline) {
      const msg = await Promise.race([
        nextMsg(ws),
        new Promise(r => setTimeout(() => r({ type: '__timeout__' }), 500)),
      ]);
      if (msg.type === 'CATCHUP') catchup = msg;
    }

    expect(catchup).not.toBeNull();
    expect(catchup.position).toBe(222);
    expect(catchup.status).toBe('playing');
    ws.close();
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
  }, 5000 /* allow 5 s for this test */);
});
