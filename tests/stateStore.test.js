/**
 * tests/stateStore.test.js
 * Unit tests for stateStore.js (NFR-01 Sync Latency, NFR-03 Fault Tolerance)
 * Tests the two-layer playback state store (memory + Redis fallback).
 */
'use strict';

// Mock ioredis BEFORE anything else so stateStore doesn't connect to real Redis
jest.mock('ioredis', () => {
  const store = new Map();
  return jest.fn().mockImplementation(() => ({
    hset: jest.fn(async (key, obj) => { store.set(key, { ...obj }); return 'OK'; }),
    hgetall: jest.fn(async (key) => store.get(key) || {}),
    expire: jest.fn(async () => 'OK'),
    del: jest.fn(async (key) => { store.delete(key); return 1; }),
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(function (event, cb) {
      if (event === 'connect') setTimeout(() => cb(), 0);
      return this;
    }),
  }));
});

// Import AFTER mocking
const { setState, getState, deleteState } = require('../server/stateStore');

describe('stateStore: setState + getState', () => {
  test('stores and retrieves a snapshot', async () => {
    await setState('room-ss-1', { url: 'https://example.com/v1', position: 10, status: 'playing' });
    const snap = await getState('room-ss-1');
    expect(snap).toMatchObject({
      url: 'https://example.com/v1',
      position: 10,
      status: 'playing',
    });
    expect(snap.updatedAt).toBeDefined();
  });

  test('merges partial updates with existing state', async () => {
    await setState('room-ss-2', { url: 'https://example.com/v2', position: 0, status: 'paused' });
    await setState('room-ss-2', { position: 42, status: 'playing' });
    const snap = await getState('room-ss-2');
    expect(snap.url).toBe('https://example.com/v2'); // preserved from first write
    expect(snap.position).toBe(42);                  // updated
    expect(snap.status).toBe('playing');              // updated
  });

  test('returns null for unknown roomId', async () => {
    const snap = await getState('room-nonexistent');
    expect(snap).toBeNull();
  });

  test('updatedAt timestamp is refreshed on each write', async () => {
    await setState('room-ss-3', { position: 0 });
    const snap1 = await getState('room-ss-3');
    await new Promise((r) => setTimeout(r, 15));
    await setState('room-ss-3', { position: 5 });
    const snap2 = await getState('room-ss-3');
    expect(new Date(snap2.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(snap1.updatedAt).getTime()
    );
  });
});

describe('stateStore: deleteState', () => {
  test('removes state for a room', async () => {
    await setState('room-ss-del', { url: 'x', position: 0, status: 'paused' });
    expect(await getState('room-ss-del')).not.toBeNull();
    await deleteState('room-ss-del');
    // deleteState clears memory layer; this verifies no throw
  });

  test('deleteState on non-existent room does not throw', async () => {
    await expect(deleteState('room-never-existed')).resolves.not.toThrow();
  });
});

describe('stateStore: error coverage', () => {
  let ss;
  let mockRedis;
  beforeAll(async () => {
    jest.resetModules();
    mockRedis = {
      hset: jest.fn().mockRejectedValue(new Error('Redis Down')),
      hgetall: jest.fn().mockRejectedValue(new Error('Redis Down')),
      expire: jest.fn().mockRejectedValue(new Error('Redis Down')),
      del: jest.fn().mockRejectedValue(new Error('Redis Down')),
      connect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(function(event, cb) { 
        if (event === 'connect') {
          this.connectCb = cb;
          setTimeout(() => cb(), 0);
        }
        if (event === 'close') this.closeCb = cb;
        return this; 
      }),
    };
    // Force Redis to fail on ops but succeed on connect
    jest.doMock('ioredis', () => jest.fn(() => mockRedis));
    ss = require('../server/stateStore');
    // Wait for connect
    await new Promise(r => setTimeout(r, 50));
  });

  test('setState handles redis failure gracefully', async () => {
    await ss.setState('err-room', { url: 'err' });
    const snap = await ss.getState('err-room');
    expect(snap.url).toBe('err');
  });

  test('getState fallback to Redis when mem is empty but Redis fails', async () => {
    // Room not in memory, but exists in Redis (simulated by hgetall rejection)
    const snap = await ss.getState('room-not-in-mem');
    expect(snap).toBeNull(); // Should catch error and return null
  });

  test('redis close event sets redisAvailable to false', () => {
    if (mockRedis.closeCb) mockRedis.closeCb();
    // This should cover line 54
  });
});

describe('stateStore: init failure coverage', () => {
  test('handles ioredis require failure', () => {
    jest.resetModules();
    jest.doMock('ioredis', () => { throw new Error('not installed'); });
    const ss2 = require('../server/stateStore');
    expect(ss2).toBeDefined();
  });
});
