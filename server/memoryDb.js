/**
 * memoryDb.js — In-memory database fallback (no PostgreSQL required)
 *
 * Provides the same query interface as db.js but stores data in Maps.
 * Used when WP_DATABASE_URL is not set or PostgreSQL is unreachable.
 * Suitable for prototype / demo / local development.
 */
'use strict';

// ── In-memory tables ───────────────────────────────────────────────────────
const rooms = new Map();        // id → { id, invite_token, created_at, last_active_at }
const roomMembers = new Map();  // `${room_id}:${user_id}` → { room_id, user_id, display_name, role, joined_at }
const queue = new Map();        // id → { id, room_id, url, added_by, upvotes, added_at }
const queueVotes = new Map();   // `${queue_id}:${user_id}` → true
const skipVotes = new Map();    // `${room_id}:${user_id}` → true

let queueSerial = 0;

// ── SQL-like query dispatcher ──────────────────────────────────────────────

/**
 * Simulate parameterised SQL queries against in-memory store.
 * Matches the pg Pool.query({ text, params }) / pool.query(text, params) API.
 */
async function query(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();

  // ── CREATE / DDL — silently succeed ────────────────────────────────────
  if (sql.startsWith('CREATE') || sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE EXTENSION') || sql.startsWith('CREATE INDEX')) {
    return { rows: [], rowCount: 0 };
  }

  // ── rooms ──────────────────────────────────────────────────────────────

  // INSERT INTO rooms
  if (/INSERT INTO rooms/i.test(sql)) {
    const [id, invite_token] = params;
    const now = new Date().toISOString();
    rooms.set(id, { id, invite_token, created_at: now, last_active_at: now });
    return { rows: [{ id, invite_token }], rowCount: 1 };
  }

  // SELECT invite_token, last_active_at FROM rooms WHERE id = $1
  if (/SELECT invite_token.*FROM rooms WHERE id/i.test(sql)) {
    const room = rooms.get(params[0]);
    return { rows: room ? [room] : [], rowCount: room ? 1 : 0 };
  }

  // UPDATE rooms SET last_active_at
  if (/UPDATE rooms SET last_active_at/i.test(sql)) {
    const room = rooms.get(params[0]);
    if (room) room.last_active_at = new Date().toISOString();
    return { rows: [], rowCount: room ? 1 : 0 };
  }

  // ── room_members ───────────────────────────────────────────────────────

  // SELECT user_id FROM room_members WHERE room_id = $1
  if (/SELECT user_id FROM room_members WHERE room_id/i.test(sql)) {
    const members = [...roomMembers.values()].filter(m => m.room_id === params[0]);
    return { rows: members, rowCount: members.length };
  }

  // INSERT INTO room_members
  if (/INSERT INTO room_members/i.test(sql)) {
    const [room_id, user_id, display_name, role] = params;
    const key = `${room_id}:${user_id}`;
    if (!roomMembers.has(key)) {
      roomMembers.set(key, {
        room_id, user_id, display_name, role,
        joined_at: new Date().toISOString(),
      });
    }
    return { rows: [], rowCount: 1 };
  }

  // UPDATE room_members SET role
  if (/UPDATE room_members SET role/i.test(sql)) {
    const [room_id, user_id] = params;
    const key = `${room_id}:${user_id}`;
    const member = roomMembers.get(key);
    if (member) member.role = 'host';
    return { rows: [], rowCount: member ? 1 : 0 };
  }

  // UPDATE room_members SET display_name
  if (/UPDATE room_members SET display_name/i.test(sql)) {
    const [display_name, room_id, user_id] = params;
    const key = `${room_id}:${user_id}`;
    const member = roomMembers.get(key);
    if (member) member.display_name = display_name;
    return { rows: [], rowCount: member ? 1 : 0 };
  }

  // SELECT COUNT(*) FROM room_members WHERE room_id
  if (/SELECT COUNT.*FROM room_members WHERE room_id/i.test(sql)) {
    const count = [...roomMembers.values()].filter(m => m.room_id === params[0]).length;
    return { rows: [{ count }], rowCount: 1 };
  }

  // ── queue ──────────────────────────────────────────────────────────────

  // INSERT INTO queue (not queue_votes)
  if (/INSERT INTO queue\b(?!_)/i.test(sql)) {
    const [room_id, url, added_by] = params;
    const id = ++queueSerial;
    const entry = { id, room_id, url, added_by, upvotes: 0, added_at: new Date().toISOString() };
    queue.set(id, entry);
    return { rows: [entry], rowCount: 1 };
  }

  // SELECT ... FROM queue WHERE room_id ORDER BY upvotes DESC
  if (/SELECT.*FROM queue.*WHERE room_id/i.test(sql) && /ORDER BY/i.test(sql)) {
    const entries = [...queue.values()]
      .filter(e => e.room_id === params[0])
      .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
    return { rows: entries, rowCount: entries.length };
  }

  // DELETE FROM queue WHERE id = (SELECT ... LIMIT 1) RETURNING
  if (/DELETE FROM queue.*WHERE id.*SELECT id FROM queue/i.test(sql)) {
    const entries = [...queue.values()]
      .filter(e => e.room_id === params[0])
      .sort((a, b) => b.upvotes - a.upvotes || new Date(a.added_at) - new Date(b.added_at));
    const top = entries[0];
    if (top) {
      queue.delete(top.id);
      // Also clean up queue votes for this entry
      for (const [k] of queueVotes) {
        if (k.startsWith(`${top.id}:`)) queueVotes.delete(k);
      }
      return { rows: [top], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // DELETE FROM queue WHERE id = $1 (simple)
  if (/DELETE FROM queue WHERE id/i.test(sql) && !/SELECT/i.test(sql)) {
    const id = params[0];
    const existed = queue.delete(id);
    // Clean up queue votes
    for (const [k] of queueVotes) {
      if (k.startsWith(`${id}:`)) queueVotes.delete(k);
    }
    return { rows: [], rowCount: existed ? 1 : 0 };
  }

  // UPDATE queue SET upvotes = upvotes + 1
  if (/UPDATE queue SET upvotes.*upvotes \+ 1/i.test(sql)) {
    const entry = queue.get(params[0]);
    if (entry) {
      entry.upvotes++;
      return { rows: [{ upvotes: entry.upvotes }], rowCount: 1 };
    }
    return { rows: [{ upvotes: 0 }], rowCount: 0 };
  }

  // ── queue_votes ────────────────────────────────────────────────────────

  // INSERT INTO queue_votes
  if (/INSERT INTO queue_votes/i.test(sql)) {
    const [queue_id, user_id] = params;
    const key = `${queue_id}:${user_id}`;
    if (queueVotes.has(key)) {
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    }
    queueVotes.set(key, true);
    return { rows: [], rowCount: 1 };
  }

  // ── skip_votes ─────────────────────────────────────────────────────────

  // INSERT INTO skip_votes
  if (/INSERT INTO skip_votes/i.test(sql)) {
    const [room_id, user_id] = params;
    const key = `${room_id}:${user_id}`;
    if (skipVotes.has(key)) {
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    }
    skipVotes.set(key, true);
    return { rows: [], rowCount: 1 };
  }

  // SELECT COUNT(*) FROM skip_votes WHERE room_id
  if (/SELECT COUNT.*FROM skip_votes WHERE room_id/i.test(sql)) {
    const count = [...skipVotes.keys()].filter(k => k.startsWith(`${params[0]}:`)).length;
    return { rows: [{ count }], rowCount: 1 };
  }

  // DELETE FROM skip_votes WHERE room_id
  if (/DELETE FROM skip_votes WHERE room_id/i.test(sql)) {
    for (const [k] of skipVotes) {
      if (k.startsWith(`${params[0]}:`)) skipVotes.delete(k);
    }
    return { rows: [], rowCount: 0 };
  }

  // ── Fallback ───────────────────────────────────────────────────────────
  console.log('[memoryDb] Unhandled query:', sql, params);
  return { rows: [], rowCount: 0 };
}

async function initDb() {
  console.log('[memoryDb] In-memory database initialised (no PostgreSQL)');
}

function _resetMemoryDb() {
  rooms.clear();
  roomMembers.clear();
  queue.clear();
  queueVotes.clear();
  skipVotes.clear();
  queueSerial = 0;
}

module.exports = { pool: null, query, initDb, _resetMemoryDb };
