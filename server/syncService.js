/**
 * syncService.js — WebSocket hub for a room
 *
 * FR-02 Playback Sync:   host PLAY/PAUSE/SEEK → broadcast to all guests (≤1 s, NFR-01)
 * FR-03 Late-Join:       CATCHUP snapshot sent immediately on JOIN
 * FR-04 Host/Guest:      non-host commands are rejected
 * FR-05 Vote-to-Watch:   QUEUE_ADD/UPVOTE/REMOVE → broadcast updated queue
 * FR-06 Skip Vote:       SKIP_VOTE → majority check → auto-play next from queue
 * FR-07 Host Migration:  host dropout → oldest guest promoted within 3 s (NFR-03)
 * FR-08 Display Names:   SET_NAME → update display name mid-session
 * FR-10 Live Chat:       CHAT_MSG/CHAT_REACTION → real-time text + emoji
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
 *     { type: 'CHAT_MSG',    text }     — FR-10: send a chat message
 *     { type: 'CHAT_REACTION', emoji }  — FR-10: send an emoji reaction
 *     { type: 'SET_NAME',   displayName } — FR-08: change display name
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
 *     { type: 'CHAT_MSG',     userId, displayName, text, timestamp }
 *     { type: 'CHAT_REACTION', userId, displayName, emoji, timestamp }
 *     { type: 'CHAT_HISTORY', messages } — sent on JOIN for late joiners
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

// FR-10: Chat history per room (in-memory, capped at 200 messages)
const chatHistory = new Map(); // roomId → [{ userId, displayName, text, emoji, type, timestamp }]
const MAX_CHAT_HISTORY = 200;

const HOST_MIGRATION_DELAY_MS = 2_500; // promote within 3 s (NFR-03)

/**
 * RESET function ONLY for testing purposes to avoid cross-test state leakage.
 */
function _resetSyncService() {
  rooms.clear();
  chatHistory.clear();
}

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

function scheduleHostMigration(roomId, _departedUserId) {
  const members = rooms.get(roomId);
  if (!members || members.size === 0) return;

  setTimeout(async () => {
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
  console.log('[sync] handleConnection called! ws readyState:', ws.readyState);
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
      const members = rooms.get(roomId);

      // NFR-04: Enforce max 10 members per room
      if (members.size >= 10 && !members.has(userId)) {
        send(ws, { type: 'ERROR', message: 'Room is full (max 10 users)' });
        ws.close();
        return;
      }

      members.set(userId, {
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

      // FR-10: Send chat history to late joiner
      const history = chatHistory.get(roomId);
      if (history && history.length > 0) {
        send(ws, { type: 'CHAT_HISTORY', messages: history });
      }

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
      console.log(`[sync] LOAD room=${roomId} user=${userId}`);
      return;
    }

    // ── PLAY / PAUSE / SEEK (FR-02) ───────────────────────────────────────
    if (['PLAY', 'PAUSE', 'SEEK'].includes(msg.type)) {
      if (!isAuthorised(userRole)) {
        send(ws, { type: 'ERROR', message: 'Only host/co-host can control playback' });
        return;
      }
      const position = parseFloat(msg.position ?? 0);
      const currentState = msg.type === 'SEEK' ? await getState(roomId) : null;
      const status =
        msg.type === 'PLAY' ? 'playing' :
        msg.type === 'PAUSE' ? 'paused' :
        currentState?.status ?? 'paused';

      await setState(roomId, { position, status });
      // Broadcast to ALL (including host) so the host's own player also commits state
      broadcast(roomId, { type: msg.type, position });
      console.log(`[sync] ${msg.type} room=${roomId} user=${userId} position=${position}`);
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

    // ── CHAT_MSG (FR-10) — real-time text message ───────────────────────
    if (msg.type === 'CHAT_MSG') {
      const text = (msg.text ?? '').trim().slice(0, 500); // cap at 500 chars
      if (!text) {
        send(ws, { type: 'ERROR', message: 'Chat message cannot be empty' });
        return;
      }
      const member = rooms.get(roomId)?.get(userId);
      const chatMsg = {
        type: 'CHAT_MSG',
        userId,
        displayName: member?.displayName ?? 'Guest',
        text,
        timestamp: new Date().toISOString(),
      };
      // Store in history
      if (!chatHistory.has(roomId)) chatHistory.set(roomId, []);
      const history = chatHistory.get(roomId);
      history.push(chatMsg);
      if (history.length > MAX_CHAT_HISTORY) history.shift();
      // Broadcast to all room members
      broadcast(roomId, chatMsg);
      return;
    }

    // ── CHAT_REACTION (FR-10) — emoji reaction ──────────────────────────
    if (msg.type === 'CHAT_REACTION') {
      const emoji = (msg.emoji ?? '').trim().slice(0, 8); // single emoji
      if (!emoji) {
        send(ws, { type: 'ERROR', message: 'Emoji is required' });
        return;
      }
      const member = rooms.get(roomId)?.get(userId);
      const reactionMsg = {
        type: 'CHAT_REACTION',
        userId,
        displayName: member?.displayName ?? 'Guest',
        emoji,
        timestamp: new Date().toISOString(),
      };
      // Store in history
      if (!chatHistory.has(roomId)) chatHistory.set(roomId, []);
      const history = chatHistory.get(roomId);
      history.push(reactionMsg);
      if (history.length > MAX_CHAT_HISTORY) history.shift();
      // Broadcast to all
      broadcast(roomId, reactionMsg);
      return;
    }

    // ── SET_NAME (FR-08) — change display name mid-session ──────────────
    if (msg.type === 'SET_NAME') {
      const newName = (msg.displayName ?? '').trim().slice(0, 32);
      if (!newName) {
        send(ws, { type: 'ERROR', message: 'Display name cannot be empty' });
        return;
      }
      const member = rooms.get(roomId)?.get(userId);
      if (member) {
        const oldName = member.displayName;
        member.displayName = newName;
        // Persist to DB
        try {
          const { query: dbQuery } = require('./db');
          await dbQuery(
            `UPDATE room_members SET display_name = $1 WHERE room_id = $2 AND user_id = $3`,
            [newName, roomId, userId]
          );
        } catch { /* DB unavailable */ }
        broadcastMemberList(roomId);
        // Notify everyone about the name change
        broadcast(roomId, {
          type: 'CHAT_MSG',
          userId: 'system',
          displayName: 'System',
          text: `${oldName} is now known as ${newName}`,
          timestamp: new Date().toISOString(),
          isSystem: true,
        });
        console.log(`[sync] ${userId} changed name from "${oldName}" to "${newName}" in room ${roomId}`);
      }
      return;
    }

    // ── SYNC_CHECK (NEW) — guest reports drift, host can verify ──────────
    if (msg.type === 'SYNC_CHECK') {
      const guestPos = parseFloat(msg.position ?? 0);
      const guestExpected = parseFloat(msg.expected ?? 0);
      const guestDrift = parseFloat(msg.drift ?? 0);
      
      // Only host processes and acts on sync checks
      if (isAuthorised(userRole)) {
        console.log(`[sync] SYNC_CHECK from guest ${userId}: pos=${guestPos.toFixed(1)}s, expected=${guestExpected.toFixed(1)}s, drift=${guestDrift.toFixed(1)}s`);
      }
      // Guest just reports, no broadcast needed (host will act directly)
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
      chatHistory.delete(roomId); // FR-10: clean up chat history
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

module.exports = { handleConnection, _resetSyncService };
