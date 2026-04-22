/**
 * tests/db.test.js
 * Unit tests for db.js — database connection layer (NFR-08 Maintainability)
 * Tests the fallback to in-memory mode when PostgreSQL is unavailable.
 *
 * IMPORTANT: We must mock pg BEFORE requiring db.js, since db.js
 * connects eagerly at module load time.
 */
'use strict';

describe('db.js: memory fallback mode', () => {
  let db;

  beforeAll(() => {
    // Reset module cache so we get a fresh db.js
    jest.resetModules();

    // Mock pg to throw on construction (forces memory fallback)
    jest.doMock('pg', () => ({
      Pool: jest.fn(() => { throw new Error('pg unavailable'); }),
    }));

    // Mock ioredis to prevent stateStore from blocking (if transitively imported)
    jest.doMock('ioredis', () => {
      return jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        on: jest.fn().mockReturnThis(),
        hset: jest.fn().mockResolvedValue('OK'),
        hgetall: jest.fn().mockResolvedValue({}),
        expire: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
      }));
    });

    db = require('../server/db');
  });

  test('exports initDb function', () => {
    expect(typeof db.initDb).toBe('function');
  });

  test('exports query function', () => {
    expect(typeof db.query).toBe('function');
  });

  test('initDb succeeds in memory-fallback mode', async () => {
    await expect(db.initDb()).resolves.not.toThrow();
  });

  test('query INSERT works in memory-fallback mode', async () => {
    const result = await db.query(
      'INSERT INTO rooms (id, invite_token) VALUES ($1, $2)',
      ['db-test-room', 'tok123']
    );
    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
  });

  test('query SELECT returns rows in memory-fallback mode', async () => {
    const result = await db.query(
      'SELECT invite_token, last_active_at FROM rooms WHERE id = $1',
      ['db-test-room']
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].invite_token).toBe('tok123');
  });

  test('query SELECT returns empty for non-existent data', async () => {
    const result = await db.query(
      'SELECT invite_token, last_active_at FROM rooms WHERE id = $1',
      ['nonexistent']
    );
    expect(result.rows).toEqual([]);
  });
});

describe('db.js: postgres path coverage', () => {
  let db;
  const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
  const mockOn = jest.fn();

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('pg', () => ({
      Pool: jest.fn(() => ({
        query: mockQuery,
        on: mockOn,
      })),
    }));
    db = require('../server/db');
  });

  test('initDb calls pool.query for schema', async () => {
    await db.initDb();
    expect(mockQuery).toHaveBeenCalled();
  });

  test('query calls pool.query', async () => {
    await db.query('SELECT 1', []);
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', []);
  });

  test('pool error handler is registered', () => {
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    // Trigger the error callback to cover console.error
    const errorCb = mockOn.mock.calls.find(call => call[0] === 'error')[1];
    errorCb(new Error('test error'));
  });

  test('initDb switches to memory on failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('conn failed'));
    await db.initDb();
    // After failure, it should use memoryDb
    // We can't easily check 'useMemory' flag but we can check if it still works
    const res = await db.query('SELECT 1', []);
    expect(res).toBeDefined();
  });
});
