/**
 * queueService.js — FR-05 Vote-to-Watch Queue · FR-06 Skip Vote
 *
 * Queue: members nominate video URLs; entries ranked by upvote count;
 *        top entry auto-plays when the current video ends.
 * Skip:  majority-vote skip mechanic; resets when a new video starts.
 *
 * All DB operations use the shared pool from db.js.
 */
'use strict';

const { query } = require('./db');

// ── FR-05: Queue operations ───────────────────────────────────────────────

/**
 * Add a URL to the room's queue.
 * @param {string} roomId
 * @param {string} url       Raw video URL (normalised later by syncService)
 * @param {string} userId    Who nominated it
 * @returns {object}         The inserted queue entry
 */
async function addToQueue(roomId, url, userId) {
  const { rows } = await query(
    `INSERT INTO queue (room_id, url, added_by)
     VALUES ($1, $2, $3)
     RETURNING id, room_id, url, added_by, upvotes, added_at`,
    [roomId, url, userId]
  );
  return rows[0];
}

/**
 * Upvote a queue entry (1 vote per user, enforced via queue_votes).
 * @returns {{ success: boolean, upvotes?: number, error?: string }}
 */
async function upvoteQueue(queueId, userId) {
  try {
    await query(
      `INSERT INTO queue_votes (queue_id, user_id) VALUES ($1, $2)`,
      [queueId, userId]
    );
  } catch (err) {
    // Duplicate key → user already voted
    if (err.code === '23505') {
      return { success: false, error: 'Already upvoted' };
    }
    throw err;
  }

  const { rows } = await query(
    `UPDATE queue SET upvotes = upvotes + 1 WHERE id = $1 RETURNING upvotes`,
    [queueId]
  );

  return { success: true, upvotes: rows[0]?.upvotes ?? 0 };
}

/**
 * Get the queue for a room, sorted by upvotes DESC then added_at ASC.
 */
async function getQueue(roomId) {
  const { rows } = await query(
    `SELECT id, url, added_by, upvotes, added_at
     FROM queue
     WHERE room_id = $1
     ORDER BY upvotes DESC, added_at ASC`,
    [roomId]
  );
  return rows;
}

/**
 * Pop (remove + return) the top-voted entry from the queue.
 * Called when the current video ends to auto-play next.
 * @returns {object|null}  The entry, or null if queue is empty.
 */
async function popTopEntry(roomId) {
  const { rows } = await query(
    `DELETE FROM queue
     WHERE id = (
       SELECT id FROM queue
       WHERE room_id = $1
       ORDER BY upvotes DESC, added_at ASC
       LIMIT 1
     )
     RETURNING id, url, added_by, upvotes`,
    [roomId]
  );
  return rows[0] ?? null;
}

/**
 * Remove a specific queue entry (host-only action).
 */
async function removeFromQueue(queueId) {
  await query(`DELETE FROM queue WHERE id = $1`, [queueId]);
}

// ── FR-06: Skip Vote operations ───────────────────────────────────────────

/**
 * Cast a skip vote for the current video.
 * @returns {{ success: boolean, count: number, error?: string }}
 */
async function voteSkip(roomId, userId) {
  try {
    await query(
      `INSERT INTO skip_votes (room_id, user_id) VALUES ($1, $2)`,
      [roomId, userId]
    );
  } catch (err) {
    if (err.code === '23505') {
      return { success: false, count: await getSkipCount(roomId), error: 'Already voted to skip' };
    }
    throw err;
  }
  const count = await getSkipCount(roomId);
  return { success: true, count };
}

/**
 * Get current skip vote count for a room.
 */
async function getSkipCount(roomId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM skip_votes WHERE room_id = $1`,
    [roomId]
  );
  return rows[0]?.count ?? 0;
}

/**
 * Check if skip votes have reached majority.
 * @param {number} totalMembers  Current number of connected members in the room
 */
function checkSkipMajority(skipCount, totalMembers) {
  if (totalMembers <= 0) return false;
  return skipCount > totalMembers / 2;
}

/**
 * Clear all skip votes for a room (called when a new video starts).
 */
async function clearSkipVotes(roomId) {
  await query(`DELETE FROM skip_votes WHERE room_id = $1`, [roomId]);
}

module.exports = {
  addToQueue,
  upvoteQueue,
  getQueue,
  popTopEntry,
  removeFromQueue,
  voteSkip,
  getSkipCount,
  checkSkipMajority,
  clearSkipVotes,
};
