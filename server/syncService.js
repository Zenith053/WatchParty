/**
 * syncService.js — WebSocket hub for a room (Mediator + Command + Observer patterns)
 *
 * Design Patterns Applied:
 *   - Command:   Each message type is a discrete Command object (see commands/).
 *                 The hub dispatches via CommandRegistry — no if/else chain.
 *   - Observer:  Events are emitted on the RoomEventBus for decoupled consumers
 *                 (logging, analytics, future modules).
 *   - Mediator:  This module mediates all room communication. Per-room state
 *                 is managed via RoomManager and ChatService (extracted classes).
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
 *     { type: 'SYNC_REQUEST' }          — member asks server for canonical room timestamp
 *     { type: 'SYNC_RESPONSE', requestedBy } — legacy host response path; server ignores host time
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
 *     { type: 'SYNC_RESPONSE', source:'server', position, status } — canonical sync response
 *     { type: 'ERROR',         message }
 */
'use strict';

const { setState, getState, buildPlaybackClock } = require('./stateStore');
const { promoteToHost }       = require('./roomService');
const { getQueue, popTopEntry, clearSkipVotes } = require('./queueService');
const { normaliseUrl }        = require('./urlUtils');
const CommandRegistry         = require('./commands/CommandRegistry');
const { eventBus }            = require('./eventBus');
const RoomManager             = require('./RoomManager');
const RoomMember              = require('./RoomMember');
const ChatService             = require('./ChatService');

// ── Extracted services (replacing raw Maps — Design Smells #1, #3, #5, #6) ──

const roomManager = new RoomManager();
const chatService = new ChatService();

const HOST_MIGRATION_DELAY_MS = 2_500; // promote within 3 s (NFR-03)

/**
 * RESET function ONLY for testing purposes to avoid cross-test state leakage.
 */
function _resetSyncService() {
  roomManager.reset();
  chatService.reset();
}

// ── Queue & Skip Helpers ──────────────────────────────────────────────────

/**
 * Broadcast the current queue list to all room members (FR-05).
 */
async function broadcastQueue(roomId) {
  try {
    const queue = await getQueue(roomId);
    roomManager.broadcast(roomId, { type: 'QUEUE_UPDATE', queue });
  } catch (err) {
    console.error('[sync] broadcastQueue error:', err.message);
  }
}

/**
 * Broadcast skip vote status to all room members (FR-06).
 */
function broadcastSkipStatus(roomId, count) {
  const totalMembers = roomManager.getMemberCount(roomId);
  const needed = Math.floor(totalMembers / 2) + 1;
  roomManager.broadcast(roomId, { type: 'SKIP_STATUS', count, needed });
}

/**
 * Auto-play the next video from the queue (FR-05).
 * Called when current video ends or skip majority is reached (FR-06).
 */
async function playNextFromQueue(roomId) {
  try {
    const entry = await popTopEntry(roomId);
    if (!entry) {
      roomManager.broadcast(roomId, { type: 'QUEUE_EMPTY' });
      return;
    }

    const url = normaliseUrl(entry.url) || entry.url;
    await setState(roomId, { url, position: 0, status: 'playing' });
    await clearSkipVotes(roomId);

    roomManager.broadcast(roomId, { type: 'LOAD', url });
    // Auto-play after a brief delay for iframe load
    setTimeout(() => {
      roomManager.broadcast(roomId, { type: 'PLAY', position: 0 });
    }, 500);

    await broadcastQueue(roomId);
    broadcastSkipStatus(roomId, 0);

    eventBus.emitRoom(roomId, 'queue:auto_play', { url });
    console.log(`[sync] Auto-playing next from queue in room ${roomId}: ${url}`);
  } catch (err) {
    console.error('[sync] playNextFromQueue error:', err.message);
  }
}

// ── Host Migration (FR-07 / NFR-03) ────────────────────────────────────────

function scheduleHostMigration(roomId, _departedUserId) {
  const members = roomManager.getMembers(roomId);
  if (!members || members.size === 0) return;

  setTimeout(async () => {
    const current = roomManager.getMembers(roomId);
    if (!current || current.size === 0) return;

    // Still no host? Pick the longest-connected guest.
    const hasHost = [...current.values()].some(m => m.role === 'host');
    if (hasHost) return;

    const oldest = [...current.values()].reduce((a, b) =>
      a.joinedAt < b.joinedAt ? a : b
    );

    oldest.promote('host');
    try {
      await promoteToHost(roomId, oldest.userId);
    } catch {
      // DB might be unavailable; in-memory promotion still works
    }

    roomManager.send(oldest.ws, { type: 'HOST_PROMOTED', userId: oldest.userId });
    roomManager.broadcastMemberList(roomId);

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
      roomManager.send(ws, { type: 'ERROR', message: 'Invalid JSON' });
      return;
    }

    // ── JOIN — handled directly (connection setup, not a repeatable command) ──
    if (msg.type === 'JOIN') {
      roomId   = msg.roomId;
      userId   = msg.userId;
      userRole = msg.role ?? 'guest';

      // NFR-04: Enforce max 10 members per room
      const currentCount = roomManager.getMemberCount(roomId);
      if (currentCount >= 10 && !roomManager.getMember(roomId, userId)) {
        roomManager.send(ws, { type: 'ERROR', message: 'Room is full (max 10 users)' });
        ws.close();
        return;
      }

      const member = new RoomMember({
        ws, userId, role: userRole,
        displayName: msg.displayName ?? 'Guest',
      });
      roomManager.addMember(roomId, member);

      // FR-03 Late-Join Catch-up: send current playback state immediately
      const snap = await getState(roomId);
      if (snap) {
        const clock = buildPlaybackClock(snap);
        roomManager.send(ws, {
          type: 'CATCHUP',
          url:      clock.url      ?? null,
          ...clock,
        });
      }

      roomManager.broadcastMemberList(roomId);

      // Send current queue to the new joiner (FR-05)
      try {
        const queue = await getQueue(roomId);
        roomManager.send(ws, { type: 'QUEUE_UPDATE', queue });
      } catch { /* DB unavailable */ }

      // FR-10: Send chat history to late joiner
      const history = chatService.getHistory(roomId);
      if (history.length > 0) {
        roomManager.send(ws, { type: 'CHAT_HISTORY', messages: history });
      }

      eventBus.emitRoom(roomId, 'room:join', { userId, role: userRole });
      console.log(`[sync] ${userId} (${userRole}) joined room ${roomId}`);
      return;
    }

    // All subsequent messages require a JOIN first
    if (!roomId || !userId) {
      roomManager.send(ws, { type: 'ERROR', message: 'Must JOIN first' });
      return;
    }

    const member = roomManager.getMember(roomId, userId);
    if (member) userRole = member.role; // keep in sync with any promotions

    // ── Command Pattern: Dispatch via Registry ──────────────────────────────
    const CommandClass = CommandRegistry.get(msg.type);
    if (!CommandClass) {
      roomManager.send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
      return;
    }

    // Build the execution context for this command (Smell #6: operations, not raw data)
    const context = {
      roomId,
      userId,
      userRole,
      ws,
      // Extracted services (replacing raw Maps)
      roomManager,
      chatService,
      eventBus,
      // Convenience operations scoped to current room/user
      getMember:           (uid) => roomManager.getMember(roomId, uid ?? userId),
      getMemberCount:      ()    => roomManager.getMemberCount(roomId),
      // Communication helpers
      send:                (obj) => roomManager.send(ws, obj),
      broadcast:           (obj, exclude) => roomManager.broadcast(roomId, obj, exclude),
      broadcastMemberList: ()    => roomManager.broadcastMemberList(roomId),
      broadcastQueue:      ()    => broadcastQueue(roomId),
      broadcastSkipStatus: (cnt) => broadcastSkipStatus(roomId, cnt),
      playNextFromQueue:   ()    => playNextFromQueue(roomId),
    };

    const cmd = new CommandClass(context);

    // Validate
    const validation = cmd.validate(msg);
    if (!validation.valid) {
      roomManager.send(ws, { type: 'ERROR', message: validation.error });
      return;
    }

    // Execute
    try {
      await cmd.execute(msg);
    } catch (err) {
      console.error(`[sync] Command ${msg.type} error:`, err.message);
      roomManager.send(ws, { type: 'ERROR', message: `Failed to process ${msg.type}` });
    }

  });

  ws.on('close', () => {
    if (!roomId || !userId) return;

    const departed = roomManager.removeMember(roomId, userId);

    if (roomManager.isEmpty(roomId)) {
      roomManager.deleteRoom(roomId);
      chatService.clear(roomId); // FR-10: clean up chat history
      eventBus.teardownRoom(roomId); // Observer cleanup
      console.log(`[sync] Room ${roomId} empty — cleaned up`);
      return;
    }

    // FR-07: if departed member was the host, trigger migration
    if (departed?.role === 'host') {
      scheduleHostMigration(roomId, userId);
    }

    roomManager.broadcastMemberList(roomId);
    eventBus.emitRoom(roomId, 'room:leave', { userId });
    console.log(`[sync] ${userId} left room ${roomId}`);
  });

  ws.on('error', (err) => {
    console.error('[sync] ws error:', err.message);
  });
}

module.exports = { handleConnection, _resetSyncService };
