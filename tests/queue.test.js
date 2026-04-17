/**
 * tests/queue.test.js
 * Unit tests for queueService (FR-05, FR-06)
 * Uses mocked DB; tests queue operations and skip vote logic.
 */
'use strict';

// ── Mock DB ───────────────────────────────────────────────────────────────
const queueStore = [];
const queueVotes = new Map(); // `${queueId}-${userId}` → true
const skipVotes  = new Map(); // `${roomId}-${userId}` → true
let queueIdCounter = 1;

jest.mock('../server/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query: jest.fn(async (sql, params) => {
    // INSERT INTO queue
    if (sql.startsWith('INSERT INTO queue')) {
      const entry = {
        id: queueIdCounter++,
        room_id: params[0],
        url: params[1],
        added_by: params[2],
        upvotes: 0,
        added_at: new Date().toISOString(),
      };
      queueStore.push(entry);
      return { rows: [entry] };
    }

    // SELECT queue entries
    if (sql.includes('FROM queue') && sql.includes('ORDER BY')) {
      const roomId = params[0];
      const entries = queueStore
        .filter(e => e.room_id === roomId)
        .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
      return { rows: entries };
    }

    // INSERT INTO queue_votes
    if (sql.startsWith('INSERT INTO queue_votes')) {
      const key = `${params[0]}-${params[1]}`;
      if (queueVotes.has(key)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      queueVotes.set(key, true);
      return { rows: [] };
    }

    // UPDATE queue upvotes
    if (sql.startsWith('UPDATE queue SET upvotes')) {
      const entry = queueStore.find(e => e.id === params[0]);
      if (entry) {
        entry.upvotes++;
        return { rows: [{ upvotes: entry.upvotes }] };
      }
      return { rows: [] };
    }

    // DELETE FROM queue (pop top)
    if (sql.startsWith('DELETE FROM queue') && sql.includes('SELECT id FROM queue')) {
      const roomId = params[0];
      const sorted = queueStore
        .filter(e => e.room_id === roomId)
        .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
      if (sorted.length === 0) return { rows: [] };
      const top = sorted[0];
      const idx = queueStore.findIndex(e => e.id === top.id);
      queueStore.splice(idx, 1);
      return { rows: [top] };
    }

    // DELETE FROM queue (remove by id)
    if (sql.startsWith('DELETE FROM queue WHERE id')) {
      const idx = queueStore.findIndex(e => e.id === params[0]);
      if (idx >= 0) queueStore.splice(idx, 1);
      return { rows: [] };
    }

    // INSERT INTO skip_votes
    if (sql.startsWith('INSERT INTO skip_votes')) {
      const key = `${params[0]}-${params[1]}`;
      if (skipVotes.has(key)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      skipVotes.set(key, true);
      return { rows: [] };
    }

    // COUNT skip_votes
    if (sql.includes('COUNT') && sql.includes('skip_votes')) {
      const roomId = params[0];
      let count = 0;
      for (const key of skipVotes.keys()) {
        if (key.startsWith(`${roomId}-`)) count++;
      }
      return { rows: [{ count }] };
    }

    // DELETE FROM skip_votes
    if (sql.startsWith('DELETE FROM skip_votes')) {
      const roomId = params[0];
      for (const key of [...skipVotes.keys()]) {
        if (key.startsWith(`${roomId}-`)) skipVotes.delete(key);
      }
      return { rows: [] };
    }

    return { rows: [] };
  }),
}));

const {
  addToQueue, upvoteQueue, getQueue, popTopEntry,
  removeFromQueue, voteSkip, checkSkipMajority, clearSkipVotes,
} = require('../server/queueService');

// Reset stores between tests
beforeEach(() => {
  queueStore.length = 0;
  queueVotes.clear();
  skipVotes.clear();
  queueIdCounter = 1;
});

// ── FR-05: Queue Operations ──────────────────────────────────────────────

describe('FR-05 Queue: addToQueue', () => {
  test('adds an entry to the queue', async () => {
    const entry = await addToQueue('room-1', 'https://youtube.com/watch?v=abc', 'user-1');
    expect(entry).toMatchObject({
      id: expect.any(Number),
      room_id: 'room-1',
      url: 'https://youtube.com/watch?v=abc',
      added_by: 'user-1',
      upvotes: 0,
    });
  });
});

describe('FR-05 Queue: getQueue', () => {
  test('returns entries sorted by upvotes DESC', async () => {
    await addToQueue('room-2', 'https://youtube.com/watch?v=a', 'u1');
    const e2 = await addToQueue('room-2', 'https://youtube.com/watch?v=b', 'u2');
    // Manually upvote e2
    e2.upvotes = 5;

    const queue = await getQueue('room-2');
    expect(queue.length).toBe(2);
    expect(queue[0].url).toContain('v=b'); // higher upvotes first
  });
});

describe('FR-05 Queue: upvoteQueue', () => {
  test('increments upvote count', async () => {
    const entry = await addToQueue('room-3', 'https://youtube.com/watch?v=x', 'u1');
    const result = await upvoteQueue(entry.id, 'u2');
    expect(result.success).toBe(true);
    expect(result.upvotes).toBe(1);
  });

  test('rejects duplicate upvote from same user', async () => {
    const entry = await addToQueue('room-4', 'https://youtube.com/watch?v=y', 'u1');
    await upvoteQueue(entry.id, 'u2');
    const result = await upvoteQueue(entry.id, 'u2');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already/i);
  });
});

describe('FR-05 Queue: popTopEntry', () => {
  test('returns and removes the top-voted entry', async () => {
    await addToQueue('room-5', 'https://youtube.com/watch?v=low', 'u1');
    const high = await addToQueue('room-5', 'https://youtube.com/watch?v=high', 'u2');
    high.upvotes = 10;

    const popped = await popTopEntry('room-5');
    expect(popped.url).toContain('v=high');

    const remaining = await getQueue('room-5');
    expect(remaining.length).toBe(1);
    expect(remaining[0].url).toContain('v=low');
  });

  test('returns null when queue is empty', async () => {
    const popped = await popTopEntry('room-empty');
    expect(popped).toBeNull();
  });
});

describe('FR-05 Queue: removeFromQueue', () => {
  test('removes a specific entry', async () => {
    const entry = await addToQueue('room-6', 'https://youtube.com/watch?v=del', 'u1');
    await removeFromQueue(entry.id);
    const queue = await getQueue('room-6');
    expect(queue.length).toBe(0);
  });
});

// ── FR-06: Skip Vote ─────────────────────────────────────────────────────

describe('FR-06 Skip: voteSkip', () => {
  test('registers a skip vote', async () => {
    const result = await voteSkip('room-s1', 'u1');
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  test('rejects duplicate skip vote from same user', async () => {
    await voteSkip('room-s2', 'u1');
    const result = await voteSkip('room-s2', 'u1');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already/i);
  });
});

describe('FR-06 Skip: checkSkipMajority', () => {
  test('returns true when votes exceed 50%', () => {
    expect(checkSkipMajority(3, 5)).toBe(true);   // 3/5 > 50%
    expect(checkSkipMajority(3, 4)).toBe(true);   // 3/4 > 50%
  });

  test('returns false when votes do not exceed 50%', () => {
    expect(checkSkipMajority(2, 5)).toBe(false);  // 2/5 = 40%
    expect(checkSkipMajority(1, 3)).toBe(false);  // 1/3 = 33%
  });

  test('returns false for edge cases', () => {
    expect(checkSkipMajority(0, 0)).toBe(false);
    expect(checkSkipMajority(0, 1)).toBe(false);
  });
});

describe('FR-06 Skip: clearSkipVotes', () => {
  test('clears all skip votes for a room', async () => {
    await voteSkip('room-s3', 'u1');
    await voteSkip('room-s3', 'u2');
    await clearSkipVotes('room-s3');

    // Can vote again after clear
    const result = await voteSkip('room-s3', 'u1');
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});
