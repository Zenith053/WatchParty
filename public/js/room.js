/**
 * room.js — WebSocket client for the WatchParty room page
 *
 * FR-02: Applies host PLAY/PAUSE/SEEK to the YouTube IFrame player
 * FR-03: Handles CATCHUP message → seeks to current position on join
 * FR-04: Role-gates controls (host shows controls bar; guest sees message)
 * FR-05: Queue management — add, upvote, remove entries
 * FR-06: Skip vote — majority-based skip mechanic
 * FR-07: Handles HOST_PROMOTED → unlocks controls if this client is promoted
 */
'use strict';

// ── Session credentials (written by main.js) ──────────────────────────────
const roomId      = new URLSearchParams(location.search).get('roomId');
const token       = new URLSearchParams(location.search).get('token');
const userId      = sessionStorage.getItem('wp_userId');
const displayName = sessionStorage.getItem('wp_displayName') ?? 'Guest';

let role      = sessionStorage.getItem('wp_role') ?? 'guest';
let inviteLink = sessionStorage.getItem('wp_inviteLink') ?? location.href;

// Guard: missing credentials → redirect home
if (!roomId || !userId) {
  location.replace(`/?roomId=${roomId ?? ''}&token=${token ?? ''}`);
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const roomIdDisplay  = $('room-id-display');
const roleBadge      = $('role-badge');
const memberList     = $('member-list');
const memberCount    = $('member-count');
const emptyState     = $('empty-state');
const emptyHint      = $('empty-state-hint');
const videoFrame     = $('video-frame');
const guestOverlay   = $('guest-overlay');
const urlSection     = $('url-section');
const urlInput       = $('url-input');
const hostControls   = $('host-controls');
const hostSeek       = $('host-seek');
const guestMsg       = $('guest-msg');
const btnPlayPause   = $('btn-play-pause');
const seekBar        = $('seek-bar');
const timeCurrent    = $('time-current');
const timeTotal      = $('time-total');
const inviteDisplay  = $('invite-display');

// Queue DOM refs (FR-05)
const queueUrlInput  = $('queue-url-input');
const queueList      = $('queue-list');
const queueEmpty     = $('queue-empty');
const queueCount     = $('queue-count');

// Skip DOM refs (FR-06)
const skipSection    = $('skip-section');
const skipProgress   = $('skip-progress');

// ── Toast helper ──────────────────────────────────────────────────────────
function toast(message, type = 'info', durationMs = 3500) {
  const icons = { error: '❌', success: '✅', info: 'ℹ️', warn: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] ?? 'ℹ️'}</span><span>${message}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut 400ms ease forwards';
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, durationMs);
}

// ── Sidebar Tab Switcher ──────────────────────────────────────────────────
function switchSidebarTab(tab) {
  ['room', 'queue'].forEach(t => {
    $(`stab-${t}`).classList.toggle('active', t === tab);
    $(`stab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`spanel-${t}`).classList.toggle('active', t === tab);
  });
}

// ── Role UI ───────────────────────────────────────────────────────────────
function applyRoleUI() {
  const isHost = role === 'host' || role === 'co-host';

  roleBadge.className = `badge badge-${role === 'host' ? 'host' : role === 'co-host' ? 'cohost' : 'guest'}`;
  roleBadge.textContent = role === 'host' ? '👑 Host' : role === 'co-host' ? '⭐ Co-Host' : '👤 Guest';

  urlSection.classList.toggle('hidden', !isHost);
  hostControls.classList.toggle('hidden', !isHost);
  hostSeek.classList.toggle('hidden', !isHost);
  guestMsg.classList.toggle('hidden',  isHost);
  guestOverlay.classList.toggle('hidden', isHost);
}

// ── Invite link display ───────────────────────────────────────────────────
function showInviteLink() {
  roomIdDisplay.textContent = roomId.slice(0, 8) + '…';
  inviteDisplay.textContent = inviteLink;
}

// ── Catch-up flash ────────────────────────────────────────────────────────
function showCatchupFlash() {
  const el = document.createElement('div');
  el.className = 'catchup-flash';
  el.textContent = '⏩ Caught up to live position';
  $('player-area') ?? document.querySelector('.player-area').appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// ── Time formatting ───────────────────────────────────────────────────────
function fmt(s) {
  s = Math.floor(s ?? 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ══════════════════════════════════════════════════════════════════════════
// YouTube IFrame Player
// ══════════════════════════════════════════════════════════════════════════
let ytPlayer       = null;
let ytReady        = false;
let pendingCatchup = null;   // { position, status } received before player ready
let seekPending    = false;  // user is actively dragging
let poller         = null;   // seek-bar update interval

// Called by YouTube IFrame API when script loads
window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function createPlayer(embedUrl) {
  emptyState.classList.add('hidden');
  videoFrame.classList.remove('hidden');
  videoFrame.src = embedUrl;

  // Destroy existing polling
  if (poller) clearInterval(poller);

  // Start polling for seek bar + time display (host only)
  if (role === 'host' || role === 'co-host') {
    startSeekPoller();
  }
}

function startSeekPoller() {
  if (poller) clearInterval(poller);
  poller = setInterval(() => {
    if (!videoFrame.src || seekPending) return;
    // We can't read YT iframe state cross-origin without the API object.
    // room.js tracks position locally via the server's state messages.
  }, 500);
}

// ──────────────────────────────────────────────────────────────────────────
// Local playback state tracking (used for seek bar, re-broadcast on rejoin)
// ──────────────────────────────────────────────────────────────────────────
let localPosition  = 0;
let localStatus    = 'paused';
let localDuration  = 0;  // set once known

// We use the YouTube postMessage API to control the embed
function ytPostMessage(event, args = []) {
  if (!videoFrame.contentWindow) return;
  videoFrame.contentWindow.postMessage(
    JSON.stringify({ event, func: event, args }),
    '*'
  );
}

function ytPlay()        { ytPostMessage('playVideo'); }
function ytPause()       { ytPostMessage('pauseVideo'); }
function ytSeekTo(s)     { ytPostMessage('seekTo', [s, true]); }

// Listen for messages back from the YouTube embed
window.addEventListener('message', (ev) => {
  try {
    const data = JSON.parse(ev.data);
    // YT sends info events with currentTime
    if (data.info?.currentTime !== undefined) {
      localPosition = data.info.currentTime;
    }
    if (data.info?.duration) {
      localDuration = data.info.duration;
    }
    // Detect video ended (playerState 0)
    if (data.info?.playerState === 0) {
      onVideoEnded();
    }
    updateSeekBar();
    updateTimestamp();
  } catch { /* non-JSON message from another source */ }
});

function updateSeekBar() {
  if (seekPending || !localDuration) return;
  const pct = (localPosition / localDuration) * 100;
  seekBar.value = pct;
  seekBar.style.setProperty('--progress', `${pct}%`);
  timeCurrent.textContent = fmt(localPosition);
  timeTotal.textContent   = fmt(localDuration);
}

function updateTimestamp() {
  timeCurrent.textContent = fmt(localPosition);
}

/**
 * FR-05: When the current video ends, notify the server to auto-play next.
 */
function onVideoEnded() {
  if (role === 'host' || role === 'co-host') {
    ws.send(JSON.stringify({ type: 'VIDEO_ENDED' }));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WebSocket Connection
// ══════════════════════════════════════════════════════════════════════════
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT   = 5;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'JOIN', roomId, userId, role, displayName }));
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(500 * 2 ** reconnectAttempts, 10_000);
      toast(`Connection lost — reconnecting in ${Math.round(delay/1000)}s…`, 'warn', delay);
      setTimeout(connect, delay);
    } else {
      toast('Could not reconnect. Please refresh.', 'error', 10_000);
    }
  });

  ws.addEventListener('error', (e) => {
    console.error('[room.js] WS error', e);
  });
}

// ── Incoming message handler ──────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    // FR-03: Late-join catch-up
    case 'CATCHUP':
      localPosition = msg.position ?? 0;
      localStatus   = msg.status   ?? 'paused';
      if (msg.url) {
        createPlayer(msg.url);
        setTimeout(() => {
          ytSeekTo(localPosition);
          if (localStatus === 'playing') ytPlay();
          showCatchupFlash();
        }, 1500); // give iframe time to load
      }
      updateSeekBar();
      break;

    // FR-02: Playback sync
    case 'PLAY':
      localPosition = msg.position ?? localPosition;
      localStatus   = 'playing';
      ytSeekTo(localPosition);
      ytPlay();
      btnPlayPause.textContent = '⏸';
      break;

    case 'PAUSE':
      localPosition = msg.position ?? localPosition;
      localStatus   = 'paused';
      ytSeekTo(localPosition);
      ytPause();
      btnPlayPause.textContent = '▶';
      break;

    case 'SEEK':
      localPosition = msg.position ?? localPosition;
      ytSeekTo(localPosition);
      updateSeekBar();
      break;

    // New video loaded by host
    case 'LOAD':
      createPlayer(msg.url);
      localPosition = 0;
      localStatus   = 'paused';
      updateSeekBar();
      break;

    // FR-07: This client is promoted to host
    case 'HOST_PROMOTED':
      if (msg.userId === userId) {
        role = msg.role ?? 'host';
        applyRoleUI();
        toast('You are now the host!', 'success');
      }
      break;

    // Member list update (NFR-05: show who's in the room)
    case 'MEMBER_LIST':
      renderMembers(msg.members ?? []);
      break;

    // FR-05: Queue update
    case 'QUEUE_UPDATE':
      renderQueue(msg.queue ?? []);
      break;

    // FR-06: Skip vote status
    case 'SKIP_STATUS':
      updateSkipProgress(msg.count ?? 0, msg.needed ?? 0);
      break;

    // FR-05: Queue is empty (no next video)
    case 'QUEUE_EMPTY':
      toast('Queue is empty — no next video.', 'info');
      break;

    case 'ERROR':
      toast(msg.message, 'error');
      break;
  }
}

// ── Member list rendering ─────────────────────────────────────────────────
function renderMembers(members) {
  memberCount.textContent = `${members.length} watching`;
  memberList.innerHTML = '';
  members.forEach(m => {
    const el = document.createElement('div');
    el.className = 'member-item';
    const initial = (m.displayName ?? '?')[0].toUpperCase();
    const badgeClass = m.role === 'host' ? 'badge-host' : m.role === 'co-host' ? 'badge-cohost' : 'badge-guest';
    const roleLabel  = m.role === 'host' ? '👑 Host' : m.role === 'co-host' ? '⭐ Co-Host' : 'Guest';
    el.innerHTML = `
      <div class="member-avatar" aria-hidden="true">${initial}</div>
      <span class="member-name">${m.displayName ?? 'Guest'}</span>
      <span class="badge ${badgeClass}">${roleLabel}</span>
    `;
    memberList.appendChild(el);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FR-05: Queue UI
// ══════════════════════════════════════════════════════════════════════════

/**
 * Render the queue list from server data.
 */
function renderQueue(queue) {
  queueCount.textContent = `(${queue.length})`;
  queueList.innerHTML = '';

  if (queue.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'queue-empty-msg';
    emptyEl.textContent = 'No videos in queue yet. Nominate one above!';
    queueList.appendChild(emptyEl);
    return;
  }

  queue.forEach((entry, idx) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.queueId = entry.id;

    // Extract a friendly display name from the URL
    const displayUrl = extractVideoLabel(entry.url);

    let removeBtn = '';
    if (role === 'host' || role === 'co-host') {
      removeBtn = `<button class="queue-remove-btn" onclick="removeFromQueue(${entry.id})" aria-label="Remove from queue">✕</button>`;
    }

    el.innerHTML = `
      <span class="queue-rank">#${idx + 1}</span>
      <div class="queue-info">
        <span class="queue-url" title="${entry.url}">${displayUrl}</span>
        <span class="queue-meta">Added by ${entry.added_by === userId ? 'you' : entry.added_by?.slice(0, 8) + '…'}</span>
      </div>
      <div class="queue-actions">
        <button class="queue-vote-btn" onclick="upvoteQueue(${entry.id})" aria-label="Upvote">
          ▲ ${entry.upvotes}
        </button>
        ${removeBtn}
      </div>
    `;
    queueList.appendChild(el);
  });
}

/**
 * Extract a human-readable label from a video URL.
 */
function extractVideoLabel(url) {
  try {
    const u = new URL(url);
    // YouTube
    const v = u.searchParams.get('v');
    if (v) return `youtube.com/watch?v=${v}`;
    if (u.hostname === 'youtu.be') return `youtu.be/${u.pathname.slice(1)}`;
    // Fallback
    return u.hostname + u.pathname;
  } catch {
    return url.length > 40 ? url.slice(0, 40) + '…' : url;
  }
}

/**
 * Add a video to the queue (FR-05).
 */
function addToQueue() {
  const url = queueUrlInput.value.trim();
  if (!url) { toast('Enter a YouTube URL to nominate.', 'error'); return; }
  ws.send(JSON.stringify({ type: 'QUEUE_ADD', url }));
  queueUrlInput.value = '';
  toast('Video added to queue!', 'success');
}

/**
 * Upvote a queue entry (FR-05).
 */
function upvoteQueue(queueId) {
  ws.send(JSON.stringify({ type: 'QUEUE_UPVOTE', queueId }));
}

/**
 * Remove a queue entry — host only (FR-05).
 */
function removeFromQueue(queueId) {
  ws.send(JSON.stringify({ type: 'QUEUE_REMOVE', queueId }));
}

// ══════════════════════════════════════════════════════════════════════════
// FR-06: Skip Vote UI
// ══════════════════════════════════════════════════════════════════════════

/**
 * Vote to skip the current video (FR-06).
 */
function voteSkip() {
  ws.send(JSON.stringify({ type: 'SKIP_VOTE' }));
}

/**
 * Update the skip vote progress display.
 */
function updateSkipProgress(count, needed) {
  skipProgress.textContent = `${count} / ${needed} votes`;
}

// ══════════════════════════════════════════════════════════════════════════
// Host control functions (FR-02 / FR-04)
// ══════════════════════════════════════════════════════════════════════════

function togglePlay() {
  if (localStatus === 'playing') {
    ws.send(JSON.stringify({ type: 'PAUSE', position: localPosition }));
  } else {
    ws.send(JSON.stringify({ type: 'PLAY',  position: localPosition }));
  }
}

// Seek bar: local visual update while dragging
function onSeekInput(value) {
  seekPending = true;
  const s = (parseFloat(value) / 100) * (localDuration || 1);
  timeCurrent.textContent = fmt(s);
}

// Seek bar: committed → broadcast SEEK
function onSeekCommit(value) {
  seekPending   = false;
  localPosition = (parseFloat(value) / 100) * (localDuration || 1);
  ws.send(JSON.stringify({ type: 'SEEK', position: localPosition }));
}

// Load URL (host panel)
function loadVideo() {
  const url = urlInput.value.trim();
  if (!url) { toast('Enter a YouTube URL first.', 'error'); return; }
  ws.send(JSON.stringify({ type: 'LOAD', url }));
  urlInput.value = '';
}

// Copy invite link
function copyInvite() {
  navigator.clipboard.writeText(inviteLink)
    .then(() => toast('Invite link copied!', 'success'))
    .catch(() => toast('Could not copy — please copy manually.', 'warn'));
}

// Leave room
function leaveRoom() {
  if (ws) ws.close();
  sessionStorage.clear();
  location.replace('/');
}

// ── Enter url with Enter key ──────────────────────────────────────────────
urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') loadVideo(); });
queueUrlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addToQueue(); });

// ── Bootstrap ─────────────────────────────────────────────────────────────
(function init() {
  applyRoleUI();
  showInviteLink();
  if (role === 'guest') {
    emptyHint.textContent = 'Waiting for the host to load a video…';
  }
  connect();
})();
