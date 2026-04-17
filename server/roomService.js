/**
 * roomService.js — FR-01 Room Creation · FR-04 Host/Guest Roles (NFR-06 Security)
 *
 * REST handlers mounted by gateway.js:
 *   POST /api/rooms        → create room, return inviteLink
 *   POST /api/rooms/join   → validate token, assign role, return roomId + userId
 *
 * Design: Host-Authoritative (one source of truth per room).
 * IDs use UUIDv7 for lexicographic time-ordering.
 */
'use strict';

const crypto = require('crypto');
const { uuidv7 } = require('uuidv7');
const { query } = require('./db');

const INVITE_TOKEN_BYTES = 32;
const TOKEN_EXPIRY_HOURS = 24;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeInviteToken() {
  return crypto.randomBytes(INVITE_TOKEN_BYTES).toString('hex');
}

function inviteLink(req, roomId, token) {
  const base = process.env.WP_BASE_URL ||
    `${req.protocol}://${req.get('host')}`;
  return `${base}/room.html?roomId=${roomId}&token=${token}`;
}

// ── Handlers ───────────────────────────────────────────────────────────────

/**
 * POST /api/rooms
 * Creates a new room. No auth required (NFR-05).
 */
async function createRoom(req, res) {
  try {
    const roomId = uuidv7();
    const token  = makeInviteToken();

    await query(
      `INSERT INTO rooms (id, invite_token) VALUES ($1, $2)`,
      [roomId, token]
    );

    res.status(201).json({
      roomId,
      token,
      inviteLink: inviteLink(req, roomId, token),
    });
  } catch (err) {
    console.error('[roomService] createRoom:', err.message);
    res.status(500).json({ error: 'Failed to create room' });
  }
}

/**
 * POST /api/rooms/join
 * Body: { roomId, token, displayName? }
 * Validates invite token (NFR-06), assigns role, returns { userId, role }.
 */
async function joinRoom(req, res) {
  const { roomId, token, displayName = 'Guest' } = req.body ?? {};

  if (!roomId || !token) {
    return res.status(400).json({ error: 'roomId and token are required' });
  }

  try {
    // 1. Validate room + token
    const { rows } = await query(
      `SELECT invite_token, last_active_at FROM rooms WHERE id = $1`,
      [roomId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const room = rows[0];

    // Constant-time token comparison (prevent timing attacks — NFR-06)
    const expected = Buffer.from(room.invite_token);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length ||
        !crypto.timingSafeEqual(expected, provided)) {
      return res.status(403).json({ error: 'Invalid invite token' });
    }

    // Token expiry: 24 h of inactivity (NFR-06)
    const lastActive = new Date(room.last_active_at);
    const hoursSince = (Date.now() - lastActive.getTime()) / 3_600_000;
    if (hoursSince > TOKEN_EXPIRY_HOURS) {
      return res.status(403).json({ error: 'Invite link has expired' });
    }

    // 2. Assign role — first member in the room becomes host
    const { rows: members } = await query(
      `SELECT user_id FROM room_members WHERE room_id = $1`,
      [roomId]
    );
    const role = members.length === 0 ? 'host' : 'guest';

    const userId = uuidv7();
    await query(
      `INSERT INTO room_members (room_id, user_id, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, userId, displayName.slice(0, 32), role]
    );

    // 3. Refresh last_active_at
    await query(
      `UPDATE rooms SET last_active_at = NOW() WHERE id = $1`,
      [roomId]
    );

    res.status(200).json({ userId, role, roomId });
  } catch (err) {
    console.error('[roomService] joinRoom:', err.message);
    res.status(500).json({ error: 'Failed to join room' });
  }
}

/**
 * POST /api/rooms/:roomId/promote
 * Body: { targetUserId }   — called internally by syncService on host dropout.
 * Also exposed as HTTP so the host can explicitly grant co-host.
 */
async function promoteToHost(roomId, targetUserId) {
  await query(
    `UPDATE room_members SET role = 'host'
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, targetUserId]
  );
}

/**
 * Get the count of connected members in a room (from DB).
 * Used by FR-06 skip vote majority calculation.
 */
async function getMemberCount(roomId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = $1`,
    [roomId]
  );
  return rows[0]?.count ?? 0;
}

module.exports = { createRoom, joinRoom, promoteToHost, getMemberCount };
