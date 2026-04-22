/**
 * tests/gateway.test.js
 * Unit tests for gateway.js (NFR-04 Rate Limiter, NFR-06 Security)
 * Tests rate limiting, route mounting, health check, and static middleware.
 */
'use strict';

jest.mock('../server/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query: jest.fn(async (sql, params) => {
    // INSERT room
    if (sql.startsWith('INSERT INTO rooms')) {
      return { rows: [{ id: params[0], invite_token: params[1] }] };
    }
    return { rows: [] };
  }),
}));

const express = require('express');
const request = require('supertest');
const { router, staticMiddleware, rateLimiter } = require('../server/gateway');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', router);
  return app;
}

describe('Gateway: Health check', () => {
  test('GET /api/health returns { status: "ok" }', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('Gateway: Rate limiter', () => {
  test('rateLimiter is a function', () => {
    expect(typeof rateLimiter).toBe('function');
  });

  test('allows requests under the limit', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('Gateway: Static middleware', () => {
  test('staticMiddleware returns a function', () => {
    const mw = staticMiddleware();
    expect(typeof mw).toBe('function');
  });
});

describe('Gateway: Route mounting', () => {
  test('POST /api/rooms is routed (not 404)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/rooms');
    // Should return 201 (success) or 500 (db error) or 429 (rate limit), but NOT 404
    expect(res.status).not.toBe(404);
  });

  test('POST /api/rooms/join is routed (not 404)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/rooms/join').send({});
    // Should return 400 (missing params) or 429 (rate limit), not 404
    expect(res.status).not.toBe(404);
  });
});
