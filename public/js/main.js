/**
 * main.js — Landing page logic (NFR-05: room + invite in < 2 min)
 * Handles Create Room and Join via link tabs.
 */
'use strict';

// ── Toast helper ──────────────────────────────────────────────────────────
function toast(message, type = 'info', durationMs = 3500) {
  const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut 400ms ease forwards';
    el.addEventListener('animationend', () => el.remove());
  }, durationMs);
}

// ── Tab switcher ──────────────────────────────────────────────────────────
function switchTab(tab) {
  ['create', 'join'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
  });
}

// ── Create Room (FR-01) ───────────────────────────────────────────────────
async function createRoom() {
  const displayName = document.getElementById('display-name-create').value.trim() || 'Host';
  const btn         = document.getElementById('btn-create');
  const label       = document.getElementById('create-label');
  const spinner     = document.getElementById('create-spinner');

  btn.disabled = true;
  label.textContent = 'Creating…';
  spinner.classList.remove('hidden');

  try {
    const res  = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error ?? 'Server error');

    // Immediately join as host
    const joinRes = await fetch('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: data.roomId, token: data.token, displayName }),
    });
    const joinData = await joinRes.json();
    if (!joinRes.ok) throw new Error(joinData.error ?? 'Failed to join as host');

    // Persist credentials for room.js
    sessionStorage.setItem('wp_roomId',      data.roomId);
    sessionStorage.setItem('wp_token',        data.token);
    sessionStorage.setItem('wp_userId',       joinData.userId);
    sessionStorage.setItem('wp_role',         joinData.role);
    sessionStorage.setItem('wp_displayName',  displayName);
    sessionStorage.setItem('wp_inviteLink',   data.inviteLink);

    window.location.href = `/room.html?roomId=${data.roomId}&token=${data.token}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    label.textContent = 'Create a Room';
    spinner.classList.add('hidden');
  }
}

// ── Join via invite link (FR-01 / FR-04) ─────────────────────────────────
async function joinViaLink() {
  const raw  = document.getElementById('invite-link-input').value.trim();
  const displayName = document.getElementById('display-name-join').value.trim() || 'Guest';

  if (!raw) { toast('Paste an invite link first.', 'error'); return; }

  let roomId, token;
  try {
    const url = new URL(raw);
    roomId = url.searchParams.get('roomId');
    token  = url.searchParams.get('token');
  } catch {
    toast('That doesn\'t look like a valid invite link.', 'error');
    return;
  }

  if (!roomId || !token) {
    toast('Invite link is missing roomId or token.', 'error');
    return;
  }

  const btn = document.getElementById('btn-join');
  btn.disabled = true;
  btn.textContent = 'Joining…';

  try {
    const res  = await fetch('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, token, displayName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to join');

    sessionStorage.setItem('wp_roomId',     roomId);
    sessionStorage.setItem('wp_token',       token);
    sessionStorage.setItem('wp_userId',      data.userId);
    sessionStorage.setItem('wp_role',        data.role);
    sessionStorage.setItem('wp_displayName', displayName);
    sessionStorage.setItem('wp_inviteLink',  raw);

    window.location.href = `/room.html?roomId=${roomId}&token=${token}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Join Room →';
  }
}

// Auto-switch to Join tab if URL already has invite params
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('roomId') && params.get('token')) {
    switchTab('join');
    document.getElementById('invite-link-input').value = window.location.href;
  }
})();
