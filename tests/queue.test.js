/**
 * tests/queue.test.js
 * Unit tests for queueService (FR-05, FR-06)
 * Uses mocked DB; tests queue operations and skip vote logic.
 */
'use strict';

// ── Mock DB ───────────────────────────────────────────────────────────────
const mockQueueStore = [];
const mockQueueVotes = new Map();
const mockSkipVotes = new Map();
let mockQueueIdCounter = 1;

jest.mock('../server/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query: jest.fn(async (text, params) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    // ── queue_votes (must check BEFORE generic queue) ──────────────────
    if (/^INSERT INTO queue_votes/i.test(sql)) {
      const key = `${params[0]}-${params[1]}`;
      if (mockQueueVotes.has(key)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      mockQueueVotes.set(key, true);
      return { rows: [] };
    }

    // ── skip_votes (must check BEFORE generic queue) ──────────────────
    if (/^INSERT INTO skip_votes/i.test(sql)) {
      const key = `${params[0]}-${params[1]}`;
      if (mockSkipVotes.has(key)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      mockSkipVotes.set(key, true);
      return { rows: [] };
    }

    if (/SELECT COUNT.*FROM skip_votes/i.test(sql)) {
      const roomId = params[0];
      let count = 0;
      for (const key of mockSkipVotes.keys()) {
        if (key.startsWith(`${roomId}-`)) count++;
      }
      return { rows: [{ count }] };
    }

    if (/^DELETE FROM skip_votes/i.test(sql)) {
      const roomId = params[0];
      for (const key of [...mockSkipVotes.keys()]) {
        if (key.startsWith(`${roomId}-`)) mockSkipVotes.delete(key);
      }
      return { rows: [] };
    }

    // ── queue ──────────────────────────────────────────────────────────
    if (/^INSERT INTO queue\b/i.test(sql) && !/queue_votes/i.test(sql)) {
      const entry = {
        id: mockQueueIdCounter++,
        room_id: params[0],
        url: params[1],
        added_by: params[2],
        upvotes: 0,
        added_at: new Date().toISOString(),
      };
      mockQueueStore.push(entry);
      return { rows: [entry] };
    }

    // specific DELETE popTopEntry (MUST BE BEFORE SELECT)
    if (/^DELETE FROM queue.*SELECT id FROM queue/i.test(sql)) {
      const roomId = params[0];
      const sorted = mockQueueStore
        .filter(e => e.room_id === roomId)
        .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
      if (sorted.length === 0) return { rows: [] };
      const top = sorted[0];
      const idx = mockQueueStore.findIndex(e => e.id === top.id);
      mockQueueStore.splice(idx, 1);
      return { rows: [top] };
    }

    // specific DELETE removeFromQueue (MUST BE BEFORE SELECT)
    if (/^DELETE FROM queue WHERE id = \$\d+$/i.test(sql)) {
      const idx = mockQueueStore.findIndex(e => e.id === params[0]);
      if (idx >= 0) mockQueueStore.splice(idx, 1);
      return { rows: [] };
    }

    if (/SELECT.*FROM queue.*ORDER BY/i.test(sql)) {
      const roomId = params[0];
      const entries = mockQueueStore
        .filter(e => e.room_id === roomId)
        .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
      return { rows: entries };
    }

    if (/^UPDATE queue SET upvotes/i.test(sql)) {
      const entry = mockQueueStore.find(e => e.id === params[0]);
      if (entry) {
        entry.upvotes++;
        return { rows: [{ upvotes: entry.upvotes }] };
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
  mockQueueStore.length = 0;
  mockQueueVotes.clear();
  mockSkipVotes.clear();
  mockQueueIdCounter = 1;
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
