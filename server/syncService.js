/**
 * syncService.js — WebSocket hub for a room
 *
 * FR-02 Playback Sync:   host PLAY/PAUSE/SEEK → broadcast to all guests (≤1 s, NFR-01)
 * FR-03 Late-Join:       CATCHUP snapshot sent immediately on JOIN
 * FR-04 Host/Guest:      non-host commands are rejected
 * FR-05 Vote-to-Watch:   QUEUE_ADD/UPVOTE/REMOVE → broadcast updated queue
 * FR-06 Skip Vote:       SKIP_VOTE → majority check → auto-play next from queue
 * FR-07 Host Migration:  host dropout → oldest guest promoted within 3 s (NFR-03)
 *
 * Message envelope (JSON):
 *   Client → Server:
 *     { type: 'JOIN',   roomId, userId, role }
 *     { type: 'PLAY',   position }
 *     { type: 'PAUSE',  position }
 *     { type: 'SEEK',   position }
 *     { type: 'LOAD',   url }          — host loads a new video URL
 *     { type: 'GRANT_COHOST', targetUserId }
 *     { type: 'QUEUE_ADD',    url }     — any member nominates a video
 *     { type: 'QUEUE_UPVOTE', queueId } — any member upvotes
 *     { type: 'QUEUE_REMOVE', queueId } — host only
 *     { type: 'SKIP_VOTE' }            — any member votes to skip
 *     { type: 'VIDEO_ENDED' }          — client signals video finished
 *
 *   Server → Client:
 *     { type: 'PLAY',         position }
 *     { type: 'PAUSE',        position }
 *     { type: 'SEEK',         position }
 *     { type: 'LOAD',         url }
 *     { type: 'CATCHUP',      position, status, url }
 *     { type: 'HOST_PROMOTED', userId }   — sent to newly promoted host
 *     { type: 'MEMBER_LIST',   members }
 *     { type: 'QUEUE_UPDATE',  queue }    — full queue list broadcast
 *     { type: 'SKIP_STATUS',   count, needed } — skip vote progress
 *     { type: 'ERROR',         message }
 */
'use strict';

const { setState, getState } = require('./stateStore');
const { promoteToHost }       = require('./roomService');
const {
  addToQueue, upvoteQueue, getQueue, popTopEntry,
  removeFromQueue, voteSkip, checkSkipMajority, clearSkipVotes,
} = require('./queueService');

// roomId → Map<userId, { ws, role, joinedAt }>
const rooms = new Map();

const HOST_MIGRATION_DELAY_MS = 2_500; // promote within 3 s (NFR-03)

// ── Helpers ────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(roomId, obj, excludeUserId = null) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const [uid, { ws }] of members) {
    if (uid !== excludeUserId) send(ws, obj);
  }
}

function broadcastMemberList(roomId) {
  const members = rooms.get(roomId);
  if (!members) return;
  const list = [...members.values()].map(m => ({
    userId: m.userId,
    displayName: m.displayName,
    role: m.role,
  }));
  broadcast(roomId, { type: 'MEMBER_LIST', members: list });
}

function isAuthorised(role) {
  return role === 'host' || role === 'co-host';
}

/**
 * Broadcast the current queue list to all room members (FR-05).
 */
async function broadcastQueue(roomId) {
  try {
    const queue = await getQueue(roomId);
    broadcast(roomId, { type: 'QUEUE_UPDATE', queue });
  } catch (err) {
    console.error('[sync] broadcastQueue error:', err.message);
  }
}

/**
 * Broadcast skip vote status to all room members (FR-06).
 */
function broadcastSkipStatus(roomId, count) {
  const members = rooms.get(roomId);
  const totalMembers = members ? members.size : 0;
  const needed = Math.floor(totalMembers / 2) + 1;
  broadcast(roomId, { type: 'SKIP_STATUS', count, needed });
}

/**
 * Auto-play the next video from the queue (FR-05).
 * Called when current video ends or skip majority is reached (FR-06).
 */
async function playNextFromQueue(roomId) {
  try {
    const entry = await popTopEntry(roomId);
    if (!entry) {
      broadcast(roomId, { type: 'QUEUE_EMPTY' });
      return;
    }

    const url = normaliseUrl(entry.url) || entry.url;
    await setState(roomId, { url, position: 0, status: 'playing' });
    await clearSkipVotes(roomId);

    broadcast(roomId, { type: 'LOAD', url });
    // Auto-play after a brief delay for iframe load
    setTimeout(() => {
      broadcast(roomId, { type: 'PLAY', position: 0 });
    }, 500);

    await broadcastQueue(roomId);
    broadcastSkipStatus(roomId, 0);
    console.log(`[sync] Auto-playing next from queue in room ${roomId}: ${url}`);
  } catch (err) {
    console.error('[sync] playNextFromQueue error:', err.message);
  }
}

// ── Host Migration (FR-07 / NFR-03) ────────────────────────────────────────

function scheduleHostMigration(roomId, departedUserId) {
  const members = rooms.get(roomId);
  if (!members || members.size === 0) return;

  const migrationTimer = setTimeout(async () => {
    const current = rooms.get(roomId);
    if (!current || current.size === 0) return;

    // Still no host? Pick the longest-connected guest.
    const hasHost = [...current.values()].some(m => m.role === 'host');
    if (hasHost) return;

    const oldest = [...current.values()].reduce((a, b) =>
      a.joinedAt < b.joinedAt ? a : b
    );

    oldest.role = 'host';
    try {
      await promoteToHost(roomId, oldest.userId);
    } catch {
      // DB might be unavailable; in-memory promotion still works
    }

    send(oldest.ws, { type: 'HOST_PROMOTED', userId: oldest.userId });
    broadcastMemberList(roomId);
    console.log(`[sync] Host migrated to ${oldest.userId} in room ${roomId}`);
  }, HOST_MIGRATION_DELAY_MS);
}

// ── WebSocket upgrade handler ──────────────────────────────────────────────

/**
 * Called by index.js on each 'upgrade' event that passes gateway checks.
 * @param {import('ws')} ws
 * @param {object} _req  The raw HTTP upgrade request (for IP logging)
 */
function handleConnection(ws, _req) {
  let roomId   = null;
  let userId   = null;
  let userRole = 'guest';

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      send(ws, { type: 'ERROR', message: 'Invalid JSON' });
      return;
    }

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (msg.type === 'JOIN') {
      roomId   = msg.roomId;
      userId   = msg.userId;
      userRole = msg.role ?? 'guest';

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      rooms.get(roomId).set(userId, {
        ws, userId, role: userRole,
        displayName: msg.displayName ?? 'Guest',
        joinedAt: Date.now(),
      });

      // FR-03 Late-Join Catch-up: send current playback state immediately
      const snap = await getState(roomId);
      if (snap) {
        send(ws, {
          type: 'CATCHUP',
          url:      snap.url      ?? null,
          position: snap.position ?? 0,
          status:   snap.status   ?? 'paused',
        });
      }

      broadcastMemberList(roomId);

      // Send current queue to the new joiner (FR-05)
      try {
        const queue = await getQueue(roomId);
        send(ws, { type: 'QUEUE_UPDATE', queue });
      } catch { /* DB unavailable */ }

      console.log(`[sync] ${userId} (${userRole}) joined room ${roomId}`);
      return;
    }

    // All subsequent messages require a JOIN first
    if (!roomId || !userId) {
      send(ws, { type: 'ERROR', message: 'Must JOIN first' });
      return;
    }

    const member = rooms.get(roomId)?.get(userId);
    if (member) userRole = member.role; // keep in sync with any promotions

    // ── LOAD (host loads a video URL) ─────────────────────────────────────
    if (msg.type === 'LOAD') {
      if (!isAuthorised(userRole)) {
        send(ws, { type: 'ERROR', message: 'Only host can load videos' });
        return;
      }
      const url = normaliseUrl(msg.url ?? '');
      if (!url) {
        send(ws, { type: 'ERROR', message: 'Invalid video URL' });
        return;
      }
      await setState(roomId, { url, position: 0, status: 'paused' });
      await clearSkipVotes(roomId);
      broadcast(roomId, { type: 'LOAD', url });
      broadcastSkipStatus(roomId, 0);
      return;
    }

    // ── PLAY / PAUSE / SEEK (FR-02) ───────────────────────────────────────
    if (['PLAY', 'PAUSE', 'SEEK'].includes(msg.type)) {
      if (!isAuthorised(userRole)) {
        send(ws, { type: 'ERROR', message: 'Only host/co-host can control playback' });
        return;
      }
      const position = parseFloat(msg.position ?? 0);
      const status   = msg.type === 'PLAY' ? 'playing' : 'paused';

      await setState(roomId, { position, status });
      // Broadcast to ALL (including host) so the host's own player also commits state
      broadcast(roomId, { type: msg.type, position });
      return;
    }

    // ── GRANT_COHOST (FR-04) ──────────────────────────────────────────────
    if (msg.type === 'GRANT_COHOST') {
      if (userRole !== 'host') {
        send(ws, { type: 'ERROR', message: 'Only host can grant co-host' });
        return;
      }
      const target = rooms.get(roomId)?.get(msg.targetUserId);
      if (!target) {
        send(ws, { type: 'ERROR', message: 'Target user not in room' });
        return;
      }
      target.role = 'co-host';
      send(target.ws, { type: 'HOST_PROMOTED', role: 'co-host', userId: msg.targetUserId });
      broadcastMemberList(roomId);
      return;
    }

    // ── QUEUE_ADD (FR-05) — any member can nominate ───────────────────────
    if (msg.type === 'QUEUE_ADD') {
      const rawUrl = (msg.url ?? '').trim();
      if (!rawUrl) {
        send(ws, { type: 'ERROR', message: 'URL is required' });
        return;
      }
      try {
        await addToQueue(roomId, rawUrl, userId);
        await broadcastQueue(roomId);
      } catch (err) {
        send(ws, { type: 'ERROR', message: 'Failed to add to queue' });
        console.error('[sync] QUEUE_ADD error:', err.message);
      }
      return;
    }

    // ── QUEUE_UPVOTE (FR-05) — any member can upvote ─────────────────────
    if (msg.type === 'QUEUE_UPVOTE') {
      const queueId = parseInt(msg.queueId, 10);
      if (!queueId) {
        send(ws, { type: 'ERROR', message: 'Invalid queueId' });
        return;
      }
      try {
        const result = await upvoteQueue(queueId, userId);
        if (!result.success) {
          send(ws, { type: 'ERROR', message: result.error });
          return;
        }
        await broadcastQueue(roomId);
      } catch (err) {
        send(ws, { type: 'ERROR', message: 'Failed to upvote' });
        console.error('[sync] QUEUE_UPVOTE error:', err.message);
      }
      return;
    }

    // ── QUEUE_REMOVE (FR-05) — host only ─────────────────────────────────
    if (msg.type === 'QUEUE_REMOVE') {
      if (!isAuthorised(userRole)) {
        send(ws, { type: 'ERROR', message: 'Only host can remove queue entries' });
        return;
      }
      const queueId = parseInt(msg.queueId, 10);
      if (!queueId) {
        send(ws, { type: 'ERROR', message: 'Invalid queueId' });
        return;
      }
      try {
        await removeFromQueue(queueId);
        await broadcastQueue(roomId);
      } catch (err) {
        send(ws, { type: 'ERROR', message: 'Failed to remove from queue' });
        console.error('[sync] QUEUE_REMOVE error:', err.message);
      }
      return;
    }

    // ── SKIP_VOTE (FR-06) — any member can vote to skip ──────────────────
    if (msg.type === 'SKIP_VOTE') {
      try {
        const result = await voteSkip(roomId, userId);
        if (!result.success) {
          send(ws, { type: 'ERROR', message: result.error });
          return;
        }

        const totalMembers = rooms.get(roomId)?.size ?? 0;
        broadcastSkipStatus(roomId, result.count);

        // Check majority → auto-play next
        if (checkSkipMajority(result.count, totalMembers)) {
          await playNextFromQueue(roomId);
        }
      } catch (err) {
        send(ws, { type: 'ERROR', message: 'Failed to register skip vote' });
        console.error('[sync] SKIP_VOTE error:', err.message);
      }
      return;
    }

    // ── VIDEO_ENDED — auto-play next from queue ─────────────────────────
    if (msg.type === 'VIDEO_ENDED') {
      // Only process from host to avoid duplicates
      if (isAuthorised(userRole)) {
        await playNextFromQueue(roomId);
      }
      return;
    }

    send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
  });

  ws.on('close', () => {
    if (!roomId || !userId) return;
    const members = rooms.get(roomId);
    if (!members) return;

    const departed = members.get(userId);
    members.delete(userId);

    if (members.size === 0) {
      rooms.delete(roomId);
      console.log(`[sync] Room ${roomId} empty — cleaned up`);
      return;
    }

    // FR-07: if departed member was the host, trigger migration
    if (departed?.role === 'host') {
      scheduleHostMigration(roomId, userId);
    }

    broadcastMemberList(roomId);
    console.log(`[sync] ${userId} left room ${roomId}`);
  });

  ws.on('error', (err) => {
    console.error('[sync] ws error:', err.message);
  });
}

// ── URL normalisation (YouTube → nocookie embed) ──────────────────────────

function normaliseUrl(raw) {
  try {
    const url = new URL(raw);
    // youtube.com/watch?v=ID  or  youtu.be/ID
    let videoId = url.searchParams.get('v');
    if (!videoId && url.hostname === 'youtu.be') {
      videoId = url.pathname.slice(1);
    }
    if (videoId) {
      return `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&rel=0`;
    }
    // Return raw URL as-is (allows future native <video> support)
    return raw;
  } catch {
    return null;
  }
}

module.exports = { handleConnection };
