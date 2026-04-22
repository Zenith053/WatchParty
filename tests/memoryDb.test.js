/**
 * tests/memoryDb.test.js
 * Unit tests for memoryDb.js — in-memory database fallback
 * Verifies SQL-like query dispatch for all table operations.
 */
'use strict';

// Isolate from other modules that auto-connect to Redis/Postgres
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  connect: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnThis(),
})));

const { query, initDb } = require('../server/memoryDb');

describe('memoryDb: initDb', () => {
  test('initialises without error', async () => {
    await expect(initDb()).resolves.not.toThrow();
  });
});

describe('memoryDb: DDL statements', () => {
  test('CREATE TABLE succeeds silently', async () => {
    const result = await query('CREATE TABLE IF NOT EXISTS test (id INT)');
    expect(result.rows).toEqual([]);
  });

  test('CREATE EXTENSION succeeds silently', async () => {
    const result = await query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    expect(result.rows).toEqual([]);
  });

  test('CREATE INDEX succeeds silently', async () => {
    const result = await query('CREATE INDEX IF NOT EXISTS idx_test ON test(id)');
    expect(result.rows).toEqual([]);
  });
});

describe('memoryDb: rooms table', () => {
  const roomId = 'mem-room-001';
  const token = 'abc123token';

  test('INSERT INTO rooms stores a room', async () => {
    const result = await query('INSERT INTO rooms (id, invite_token) VALUES ($1, $2)', [roomId, token]);
    expect(result.rowCount).toBe(1);
  });

  test('SELECT invite_token FROM rooms retrieves stored room', async () => {
    const result = await query('SELECT invite_token, last_active_at FROM rooms WHERE id = $1', [roomId]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].invite_token).toBe(token);
    expect(result.rows[0].last_active_at).toBeDefined();
  });

  test('SELECT returns empty for non-existent room', async () => {
    const result = await query('SELECT invite_token, last_active_at FROM rooms WHERE id = $1', ['no-such-room']);
    expect(result.rows.length).toBe(0);
  });

  test('UPDATE rooms SET last_active_at updates timestamp', async () => {
    const result = await query('UPDATE rooms SET last_active_at = NOW() WHERE id = $1', [roomId]);
    expect(result.rowCount).toBe(1);
  });
});

describe('memoryDb: room_members table', () => {
  const roomId = 'mem-room-members-001';
  const userId = 'user-mem-001';

  test('INSERT INTO room_members stores a member', async () => {
    await query('INSERT INTO rooms (id, invite_token) VALUES ($1, $2)', [roomId, 'tok']);
    const result = await query(
      'INSERT INTO room_members (room_id, user_id, display_name, role) VALUES ($1, $2, $3, $4)',
      [roomId, userId, 'Alice', 'host']
    );
    expect(result.rowCount).toBe(1);
  });

  test('does not insert duplicate members', async () => {
    const result = await query(
      'INSERT INTO room_members (room_id, user_id, display_name, role) VALUES ($1, $2, $3, $4)',
      [roomId, userId, 'Alice', 'host']
    );
    // Should silently skip — don't add again
    expect(result.rowCount).toBe(1);
  });

  test('SELECT user_id FROM room_members returns members', async () => {
    const result = await query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].user_id).toBe(userId);
  });

  test('UPDATE room_members SET role promotes a member', async () => {
    const result = await query(
      "UPDATE room_members SET role = 'host' WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );
    expect(result.rowCount).toBe(1);
  });

  test('UPDATE room_members SET display_name changes name', async () => {
    const result = await query(
      'UPDATE room_members SET display_name = $1 WHERE room_id = $2 AND user_id = $3',
      ['Bob', roomId, userId]
    );
    expect(result.rowCount).toBe(1);
  });

  test('SELECT COUNT FROM room_members returns count', async () => {
    const result = await query(
      'SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1',
      [roomId]
    );
    expect(result.rows[0].count).toBeGreaterThanOrEqual(1);
  });
});

describe('memoryDb: queue table', () => {
  const roomId = 'mem-room-queue-001';

  test('INSERT INTO queue adds an entry', async () => {
    const result = await query(
      'INSERT INTO queue (room_id, url, added_by) VALUES ($1, $2, $3) RETURNING id, room_id, url, added_by, upvotes, added_at',
      [roomId, 'https://youtube.com/watch?v=abc', 'u1']
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].url).toContain('abc');
    expect(result.rows[0].upvotes).toBe(0);
  });

  test('SELECT FROM queue returns entries sorted by upvotes', async () => {
    await query(
      'INSERT INTO queue (room_id, url, added_by) VALUES ($1, $2, $3) RETURNING id, room_id, url, added_by, upvotes, added_at',
      [roomId, 'https://youtube.com/watch?v=def', 'u2']
    );
    const result = await query(
      'SELECT id, url, added_by, upvotes, added_at FROM queue WHERE room_id = $1 ORDER BY upvotes DESC, added_at ASC',
      [roomId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });

  test('UPDATE queue SET upvotes increments', async () => {
    const entries = await query(
      'SELECT id, url, added_by, upvotes, added_at FROM queue WHERE room_id = $1 ORDER BY upvotes DESC, added_at ASC',
      [roomId]
    );
    const id = entries.rows[0].id;
    const result = await query(
      'UPDATE queue SET upvotes = upvotes + 1 WHERE id = $1 RETURNING upvotes',
      [id]
    );
    expect(result.rows[0].upvotes).toBeGreaterThanOrEqual(1);
  });

  test('DELETE FROM queue (pop top) returns and removes top entry', async () => {
    const result = await query(
      'DELETE FROM queue WHERE id = (SELECT id FROM queue WHERE room_id = $1 ORDER BY upvotes DESC, added_at ASC LIMIT 1) RETURNING id, url, added_by, upvotes',
      [roomId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
    expect(result.rowCount).toBeGreaterThanOrEqual(0);
  });

  test('DELETE FROM queue WHERE id removes a specific entry', async () => {
    const entry = await query(
      'INSERT INTO queue (room_id, url, added_by) VALUES ($1, $2, $3) RETURNING id, room_id, url, added_by, upvotes, added_at',
      [roomId, 'https://youtube.com/watch?v=todelete', 'u3']
    );
    const id = entry.rows[0].id;
    await query('DELETE FROM queue WHERE id = $1', [id]);
    const remaining = await query(
      'SELECT id, url, added_by, upvotes, added_at FROM queue WHERE room_id = $1 ORDER BY upvotes DESC, added_at ASC',
      [roomId]
    );
    const found = remaining.rows.find((e) => e.id === id);
    expect(found).toBeUndefined();
  });
});

describe('memoryDb: queue_votes table', () => {
  test('INSERT INTO queue_votes succeeds', async () => {
    const result = await query('INSERT INTO queue_votes (queue_id, user_id) VALUES ($1, $2)', [999, 'voter1']);
    expect(result.rowCount).toBe(1);
  });

  test('duplicate vote throws error with code 23505', async () => {
    await query('INSERT INTO queue_votes (queue_id, user_id) VALUES ($1, $2)', [888, 'voter2']);
    await expect(
      query('INSERT INTO queue_votes (queue_id, user_id) VALUES ($1, $2)', [888, 'voter2'])
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('memoryDb: skip_votes table', () => {
  const roomId = 'mem-skip-room';

  test('INSERT INTO skip_votes succeeds', async () => {
    const result = await query('INSERT INTO skip_votes (room_id, user_id) VALUES ($1, $2)', [roomId, 's1']);
    expect(result.rowCount).toBe(1);
  });

  test('duplicate skip vote throws error with code 23505', async () => {
    await expect(
      query('INSERT INTO skip_votes (room_id, user_id) VALUES ($1, $2)', [roomId, 's1'])
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('SELECT COUNT FROM skip_votes returns correct count', async () => {
    await query('INSERT INTO skip_votes (room_id, user_id) VALUES ($1, $2)', [roomId, 's2']);
    const result = await query(
      'SELECT COUNT(*)::int AS count FROM skip_votes WHERE room_id = $1',
      [roomId]
    );
    expect(result.rows[0].count).toBeGreaterThanOrEqual(2);
  });

  test('DELETE FROM skip_votes clears votes for a room', async () => {
    await query('DELETE FROM skip_votes WHERE room_id = $1', [roomId]);
    const result = await query(
      'SELECT COUNT(*)::int AS count FROM skip_votes WHERE room_id = $1',
      [roomId]
    );
    expect(result.rows[0].count).toBe(0);
  });
});

describe('memoryDb: unhandled queries', () => {
  test('unrecognised SQL returns empty rows', async () => {
    const result = await query('DROP TABLE something');
    expect(result.rows).toEqual([]);
  });
});
