/**
 * syncService.js — WebSocket hub for a room (Mediator + Command + Observer patterns)
 *
 * Design Patterns Applied:
 *   - Command:   Each message type is a discrete Command object (see commands/).
 *                 The hub dispatches via CommandRegistry — no if/else chain.
 *   - Observer:  Events are emitted on the RoomEventBus for decoupled consumers
 *                 (logging, analytics, future modules).
 *   - Mediator:  This module mediates all room communication. Per-room state
 *                 (members, chat history) is managed centrally.
 *
 * FR-02 Playback Sync:   host PLAY/PAUSE/SEEK → broadcast to all guests (≤1 s, NFR-01)
 * FR-03 Late-Join:       CATCHUP snapshot sent immediately on JOIN
 * FR-04 Host/Guest:      non-host commands are rejected (via Command.validate())
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
const { getQueue, popTopEntry, clearSkipVotes } = require('./queueService');
const CommandRegistry         = require('./commands/CommandRegistry');
const { eventBus }            = require('./eventBus');

// ── Shared State (Mediator pattern — centralised per-room state) ─────────

// roomId → Map<userId, { ws, role, joinedAt, displayName, userId }>
const rooms = new Map();

// FR-10: Chat history per room (in-memory, capped at 200 messages)
const chatHistory = new Map(); // roomId → [{ userId, displayName, text, emoji, type, timestamp }]

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

    eventBus.emitRoom(roomId, 'queue:auto_play', { url });
    console.log(`[sync] Auto-playing next from queue in room ${roomId}: ${url}`);
  } catch (err) {
    console.error('[sync] playNextFromQueue error:', err.message);
  }
}

// ── URL normalisation (YouTube → nocookie embed) ──────────────────────────

function normaliseUrl(raw) {
  try {
    const url = new URL(raw);
    let videoId = url.searchParams.get('v');
    if (!videoId && url.hostname === 'youtu.be') {
      videoId = url.pathname.slice(1);
    }
    if (videoId) {
      return `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&rel=0`;
    }
    return raw;
  } catch {
    return null;
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

    eventBus.emitRoom(roomId, 'room:host_migrated', { newHostId: oldest.userId });
    console.log(`[sync] Host migrated to ${oldest.userId} in room ${roomId}`);
  }, HOST_MIGRATION_DELAY_MS);
}

// ── Observer Pattern: Register global event listeners ──────────────────────

eventBus.on('playback:play',  (e) => console.log(`[event] PLAY  room=${e.roomId} pos=${e.position}`));
eventBus.on('playback:pause', (e) => console.log(`[event] PAUSE room=${e.roomId} pos=${e.position}`));
eventBus.on('playback:seek',  (e) => console.log(`[event] SEEK  room=${e.roomId} pos=${e.position}`));
eventBus.on('playback:load',  (e) => console.log(`[event] LOAD  room=${e.roomId}`));
eventBus.on('queue:add',      (e) => console.log(`[event] QUEUE_ADD room=${e.roomId}`));
eventBus.on('chat:message',   (e) => console.log(`[event] CHAT  room=${e.roomId}`));

// ── WebSocket upgrade handler ──────────────────────────────────────────────

/**
 * Called by index.js on each 'upgrade' event that passes gateway checks.
 * Uses Command Pattern: parses message → looks up CommandRegistry → validate → execute.
 *
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

    // ── JOIN — handled directly (connection setup, not a repeatable command) ──
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

      eventBus.emitRoom(roomId, 'room:join', { userId, role: userRole });
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

    // ── Command Pattern: Dispatch via Registry ──────────────────────────────
    const CommandClass = CommandRegistry.get(msg.type);
    if (!CommandClass) {
      send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
      return;
    }

    // Build the execution context for this command
    const context = {
      roomId,
      userId,
      userRole,
      ws,
      rooms,
      chatHistory,
      eventBus,
      send:                (obj) => send(ws, obj),
      broadcast:           (obj, exclude) => broadcast(roomId, obj, exclude),
      broadcastMemberList: ()    => broadcastMemberList(roomId),
      broadcastQueue:      ()    => broadcastQueue(roomId),
      broadcastSkipStatus: (cnt) => broadcastSkipStatus(roomId, cnt),
      playNextFromQueue:   ()    => playNextFromQueue(roomId),
    };

    const cmd = new CommandClass(context);

    // Validate
    const validation = cmd.validate(msg);
    if (!validation.valid) {
      send(ws, { type: 'ERROR', message: validation.error });
      return;
    }

    // Execute
    try {
      await cmd.execute(msg);
    } catch (err) {
      console.error(`[sync] Command ${msg.type} error:`, err.message);
      send(ws, { type: 'ERROR', message: `Failed to process ${msg.type}` });
    }

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
      eventBus.teardownRoom(roomId); // Observer cleanup
      console.log(`[sync] Room ${roomId} empty — cleaned up`);
      return;
    }

    // FR-07: if departed member was the host, trigger migration
    if (departed?.role === 'host') {
      scheduleHostMigration(roomId, userId);
    }

    broadcastMemberList(roomId);
    eventBus.emitRoom(roomId, 'room:leave', { userId });
    console.log(`[sync] ${userId} left room ${roomId}`);
  });

  ws.on('error', (err) => {
    console.error('[sync] ws error:', err.message);
  });
}

module.exports = { handleConnection, _resetSyncService };
