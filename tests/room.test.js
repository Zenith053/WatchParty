/**
 * tests/room.test.js
 * Unit tests for roomService HTTP handlers (FR-01, FR-04, NFR-06)
 * Uses supertest against a minimal Express app; mocks the DB.
 */
'use strict';

jest.mock('../server/db', () => {
  const rows = new Map();
  const members = new Map();
  return {
    initDb: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql, params) => {
      // INSERT room
      if (sql.startsWith('INSERT INTO rooms')) {
        rows.set(params[0], { id: params[0], invite_token: params[1], last_active_at: new Date().toISOString() });
        return { rows: [] };
      }
      // SELECT room
      if (sql.startsWith('SELECT invite_token')) {
        const r = rows.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      // SELECT members
      if (sql.startsWith('SELECT user_id FROM room_members')) {
        const m = members.get(params[0]) ?? [];
        return { rows: m };
      }
      // INSERT member
      if (sql.startsWith('INSERT INTO room_members')) {
        const key = params[0];
        const list = members.get(key) ?? [];
        list.push({ user_id: params[1] });
        members.set(key, list);
        return { rows: [] };
      }
      // UPDATE last_active_at
      if (sql.startsWith('UPDATE rooms')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
});

const express  = require('express');
const request  = require('supertest');
const { router } = require('../server/gateway');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', router);
  return app;
}

let app;
beforeEach(() => { app = buildApp(); });

// ── FR-01: Room Creation ───────────────────────────────────────────────────

describe('POST /api/rooms', () => {
  test('creates room and returns roomId, token, inviteLink', async () => {
    const res = await request(app).post('/api/rooms').expect(201);
    expect(res.body).toMatchObject({
      roomId: expect.any(String),
      token:  expect.any(String),
      inviteLink: expect.stringContaining('/room.html'),
    });
    expect(res.body.roomId).toHaveLength(36); // UUIDv7 canonical length
    expect(res.body.token).toHaveLength(64);  // 32 bytes hex
  });

  test('each call produces a unique roomId', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/rooms'),
      request(app).post('/api/rooms'),
    ]);
    expect(a.body.roomId).not.toEqual(b.body.roomId);
  });
});

// ── FR-01 / FR-04: Join Room ──────────────────────────────────────────────

describe('POST /api/rooms/join', () => {
  let roomId, token;

  beforeEach(async () => {
    const res = await request(app).post('/api/rooms').expect(201);
    ({ roomId, token } = res.body);
  });

  test('first joiner receives host role (FR-04)', async () => {
    const res = await request(app)
      .post('/api/rooms/join')
      .send({ roomId, token, displayName: 'Alice' })
      .expect(200);
    expect(res.body.role).toBe('host');
    expect(res.body.userId).toBeTruthy();
  });

  test('second joiner receives guest role (FR-04)', async () => {
    await request(app).post('/api/rooms/join').send({ roomId, token }).expect(200);
    const res = await request(app)
      .post('/api/rooms/join')
      .send({ roomId, token, displayName: 'Bob' })
      .expect(200);
    expect(res.body.role).toBe('guest');
  });

  test('wrong token returns 403 (NFR-06)', async () => {
    const res = await request(app)
      .post('/api/rooms/join')
      .send({ roomId, token: 'a'.repeat(64) })
      .expect(403);
    expect(res.body.error).toMatch(/invalid invite token/i);
  });

  test('unknown roomId returns 404', async () => {
    const res = await request(app)
      .post('/api/rooms/join')
      .send({ roomId: '00000000-0000-0000-0000-000000000000', token })
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('missing fields returns 400', async () => {
    const res = await request(app).post('/api/rooms/join').send({}).expect(400);
    expect(res.body.error).toBeTruthy();
  });
});

// ── NFR-06: Token expiry ──────────────────────────────────────────────────

describe('Token expiry (NFR-06)', () => {
  test('expired token returns 403', async () => {
    const { query } = require('../server/db');
    // Override SELECT to return a room whose last_active_at is 25 h ago
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    query.mockImplementationOnce(async (sql) => {
      if (sql.startsWith('SELECT invite_token')) {
        return { rows: [{ invite_token: 'a'.repeat(64), last_active_at: old }] };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post('/api/rooms/join')
      .send({ roomId: 'any-id', token: 'a'.repeat(64) })
      .expect(403);
    expect(res.body.error).toMatch(/expired/i);
  });
});

// ── NFR-04: Rate limiter ──────────────────────────────────────────────────

describe('Rate limiter (NFR-04)', () => {
  test('returns 429 after 100 requests within 1 min', async () => {
    const freshApp = buildApp();
    const promises = Array.from({ length: 101 }, () =>
      request(freshApp).get('/api/health')
    );
    const results = await Promise.all(promises);
    const statuses = results.map(r => r.status);
    expect(statuses).toContain(429);
  });
});
