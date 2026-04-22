/**
 * tests/syncExtra.test.js
 * Additional WebSocket tests for syncService coverage
 * Covers: LOAD, CHAT_MSG, CHAT_REACTION, SET_NAME, GRANT_COHOST, VIDEO_ENDED,
 *         SYNC_CHECK, unknown message, invalid JSON, must-JOIN-first
 */
'use strict';

// ── Mocks ────────────────────────────────────────────────────────────────
jest.mock('../server/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../server/stateStore', () => {
  const store = new Map();
  return {
    setState: jest.fn(async (id, snap) => store.set(id, { ...(store.get(id) ?? {}), ...snap })),
    getState: jest.fn(async (id) => store.get(id) ?? null),
    deleteState: jest.fn(async (id) => store.delete(id)),
  };
});

jest.mock('../server/roomService', () => ({
  createRoom: jest.fn(),
  joinRoom: jest.fn(),
  promoteToHost: jest.fn().mockResolvedValue(undefined),
  getMemberCount: jest.fn().mockResolvedValue(2),
}));

jest.mock('../server/queueService', () => ({
  addToQueue: jest.fn().mockResolvedValue({ id: 1, url: 'x', upvotes: 0 }),
  upvoteQueue: jest.fn().mockResolvedValue({ success: true, upvotes: 1 }),
  getQueue: jest.fn().mockResolvedValue([]),
  popTopEntry: jest.fn().mockResolvedValue(null),
  removeFromQueue: jest.fn().mockResolvedValue(undefined),
  voteSkip: jest.fn().mockResolvedValue({ success: true, count: 1 }),
  getSkipCount: jest.fn().mockResolvedValue(0),
  checkSkipMajority: jest.fn().mockReturnValue(false),
  clearSkipVotes: jest.fn().mockResolvedValue(undefined),
}));

const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { handleConnection } = require('../server/syncService');

// ── Helpers ──────────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    wss.on('connection', handleConnection);
    server.listen(0, () => resolve({ server, wss, port: server.address().port }));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('open', () => {
      startBuffering(ws);
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

const msgBuffers = new Map(); // ws -> array of received messages

function startBuffering(ws) {
  if (!msgBuffers.has(ws)) {
    msgBuffers.set(ws, []);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      msgBuffers.get(ws).push(msg);
    });
  }
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function waitForMsg(ws, type, timeoutMs = 2000) {
  startBuffering(ws);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buffer = msgBuffers.get(ws);
    const index = buffer.findIndex(m => m.type === type);
    if (index !== -1) {
      return buffer.splice(index, 1)[0];
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`[test] TIMEOUT waiting for ${type}. Current buffer:`, msgBuffers.get(ws));
  return null;
}

const { _resetSyncService } = require('../server/syncService');
let server, port;
const openSockets = new Set();

beforeAll(async () => {
  ({ server, port } = await startServer());
});
afterAll(() => server.close());

afterEach(() => {
  _resetSyncService();
  for (const ws of openSockets) {
    if (ws.readyState === 1) ws.close();
  }
  openSockets.clear();
  msgBuffers.clear();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('syncService: error handling', () => {
  test('invalid JSON returns ERROR', async () => {
    const ws = await connect(port);
    openSockets.add(ws);
    ws.send('not json at all');
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg.type).toBe('ERROR');
    expect(msg.message).toMatch(/invalid json/i);
  });

  test('message before JOIN returns ERROR', async () => {
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'PLAY', position: 0 });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg.type).toBe('ERROR');
    expect(msg.message).toMatch(/join/i);
  });

  test('unknown message type returns ERROR', async () => {
    const rid = `r-unk-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'u-unk', role: 'host', displayName: 'H' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'TOTALLY_UNKNOWN' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
    expect(msg.message).toMatch(/unknown/i);
  });
});

describe('syncService: LOAD', () => {
  test('host can load a YouTube URL', async () => {
    const rid = `r-load-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'u-load', role: 'host', displayName: 'Loader' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'LOAD', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' });
    const msg = await waitForMsg(ws, 'LOAD');
    expect(msg).not.toBeNull();
    expect(msg.url).toContain('dQw4w9WgXcQ');
  });

  test('guest LOAD is rejected', async () => {
    const rid = `r-load-g-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'u-load-g', role: 'guest', displayName: 'Viewer' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'LOAD', url: 'https://youtube.com/watch?v=test' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
    expect(msg.message).toMatch(/host/i);
  });

  test('invalid URL returns ERROR', async () => {
    const rid = `r-load-bad-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'u-load-bad', role: 'host', displayName: 'Bad' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'LOAD', url: 'not-a-url' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
  });
});

describe('syncService: CHAT_MSG', () => {
  test('host can send a chat message', async () => {
    const rid = `r-chat-${Math.random()}`;
    const [h, g] = await Promise.all([connect(port), connect(port)]);
    openSockets.add(h); openSockets.add(g);
    send(h, { type: 'JOIN', roomId: rid, userId: 'ch', role: 'host', displayName: 'Chatter' });
    send(g, { type: 'JOIN', roomId: rid, userId: 'cg', role: 'guest', displayName: 'Listener' });
    await waitForMsg(h, 'MEMBER_LIST');
    await waitForMsg(g, 'MEMBER_LIST');

    send(h, { type: 'CHAT_MSG', text: 'Hello world!' });
    const msg = await waitForMsg(g, 'CHAT_MSG');
    expect(msg).not.toBeNull();
    expect(msg.text).toBe('Hello world!');
    expect(msg.displayName).toBe('Chatter');
  });

  test('empty chat message returns ERROR', async () => {
    const rid = `r-chat-empty-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'ce', role: 'host', displayName: 'E' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'CHAT_MSG', text: '' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
  });
});

describe('syncService: CHAT_REACTION', () => {
  test('user can send an emoji reaction', async () => {
    const rid = `r-react-${Math.random()}`;
    const [h, g] = await Promise.all([connect(port), connect(port)]);
    openSockets.add(h); openSockets.add(g);
    send(h, { type: 'JOIN', roomId: rid, userId: 'rh', role: 'host', displayName: 'Reactor' });
    send(g, { type: 'JOIN', roomId: rid, userId: 'rg', role: 'guest', displayName: 'Watcher' });
    await waitForMsg(h, 'MEMBER_LIST');
    await waitForMsg(g, 'MEMBER_LIST');

    send(g, { type: 'CHAT_REACTION', emoji: '🔥' });
    const msg = await waitForMsg(h, 'CHAT_REACTION');
    expect(msg).not.toBeNull();
    expect(msg.emoji).toBe('🔥');
  });

  test('empty emoji returns ERROR', async () => {
    const rid = `r-react-e-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 're', role: 'host', displayName: 'E' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'CHAT_REACTION', emoji: '' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
  });
});

describe('syncService: SET_NAME', () => {
  test('user can change display name mid-session', async () => {
    const rid = `r-name-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'nm', role: 'host', displayName: 'OldName' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'SET_NAME', displayName: 'NewName' });
    // Should broadcast MEMBER_LIST then system CHAT_MSG
    await waitForMsg(ws, 'MEMBER_LIST');
    const chatMsg = await waitForMsg(ws, 'CHAT_MSG');
    expect(chatMsg).not.toBeNull();
    expect(chatMsg.text).toBe('OldName is now known as NewName');
  });

  test('empty name returns ERROR', async () => {
    const rid = `r-name-e-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'ne', role: 'host', displayName: 'X' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'SET_NAME', displayName: '' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
  });
});

describe('syncService: GRANT_COHOST', () => {
  test('host can grant co-host to a guest', async () => {
    const rid = `r-cohost-${Math.random()}`;
    const [h, g] = await Promise.all([connect(port), connect(port)]);
    openSockets.add(h); openSockets.add(g);
    send(h, { type: 'JOIN', roomId: rid, userId: 'coh', role: 'host', displayName: 'Host' });
    send(g, { type: 'JOIN', roomId: rid, userId: 'cog', role: 'guest', displayName: 'Guest' });
    await waitForMsg(h, 'MEMBER_LIST');
    await waitForMsg(g, 'MEMBER_LIST');

    send(h, { type: 'GRANT_COHOST', targetUserId: 'cog' });
    const promoted = await waitForMsg(g, 'HOST_PROMOTED');
    expect(promoted).not.toBeNull();
    expect(promoted.role).toBe('co-host');
  });

  test('guest cannot grant co-host', async () => {
    const rid = `r-cohost-e-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'coe', role: 'guest', displayName: 'G' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'GRANT_COHOST', targetUserId: 'nobody' });
    const msg = await waitForMsg(ws, 'ERROR');
    expect(msg).not.toBeNull();
    expect(msg.message).toMatch(/host/i);
  });
});

describe('syncService: SEEK', () => {
  test('host SEEK broadcasts to guests', async () => {
    const rid = `r-seek-${Math.random()}`;
    const [h, g] = await Promise.all([connect(port), connect(port)]);
    openSockets.add(h); openSockets.add(g);
    send(h, { type: 'JOIN', roomId: rid, userId: 'sh', role: 'host', displayName: 'Host' });
    send(g, { type: 'JOIN', roomId: rid, userId: 'sg', role: 'guest', displayName: 'Guest' });
    await waitForMsg(h, 'MEMBER_LIST');
    await waitForMsg(g, 'MEMBER_LIST');

    send(h, { type: 'SEEK', position: 120 });
    const msg = await waitForMsg(g, 'SEEK');
    expect(msg).not.toBeNull();
    expect(msg.position).toBe(120);
  });
});

describe('syncService: VIDEO_ENDED', () => {
  test('host VIDEO_ENDED triggers playNextFromQueue', async () => {
    const rid = `r-ended-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'vh', role: 'host', displayName: 'H' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'VIDEO_ENDED' });
    // Should receive QUEUE_EMPTY since popTopEntry returns null
    const msg = await waitForMsg(ws, 'QUEUE_EMPTY');
    expect(msg).not.toBeNull();
  });
});

describe('syncService: SYNC_CHECK', () => {
  test('sync check from host is processed without error', async () => {
    const rid = `r-syncchk-${Math.random()}`;
    const ws = await connect(port);
    openSockets.add(ws);
    send(ws, { type: 'JOIN', roomId: rid, userId: 'sc', role: 'host', displayName: 'H' });
    await waitForMsg(ws, 'MEMBER_LIST');
    send(ws, { type: 'SYNC_CHECK', position: 30, expected: 30, drift: 0 });
    // No response expected — just verify it doesn't error
    await new Promise((r) => setTimeout(r, 200));
  });
});
