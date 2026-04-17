# WatchParty — Must Have FR Implementation Plan

Implement the four **Must Have** functional requirements for the WatchParty prototype on top of a Node.js + WebSocket backend and a vanilla HTML/CSS/JS frontend, matching the architecture diagram exactly.

## User Review Required

> [!IMPORTANT]
> The implementation uses `youtube-nocookie.com` embed iframes as the video player so no OTT API credentials are needed during the prototype. Guests paste a YouTube URL; the server normalises it to an embed URL. If you need a different player (e.g., native `<video>` for local files), let me know before I start coding.

> [!NOTE]
> **Tech stack**: Node.js 18+, Express 4, `ws` (WebSocket), **PostgreSQL** (via `pg`), **Redis** (via `ioredis`), **`uuidv7`**, Jest (tests). No build step — runs with `node server/index.js`. Requires a running Postgres instance and Redis server (connection strings via env vars).

---

## Proposed Changes

### Backend — Foundation

#### [NEW] [package.json](file:///home/cypher/SE/project3/package.json)
Dependencies: `express`, `ws`, `uuidv7`, `pg`, `ioredis`. Dev-deps: `jest`, `supertest`.  
Scripts: `start`, `test`.

#### [NEW] [server/db.js](file:///home/cypher/SE/project3/server/db.js)
PostgreSQL via `pg` Pool — tables: `rooms (id UUID PK, invite_token TEXT, created_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ)`, `room_members (room_id, user_id, display_name, role, joined_at)`, `queue (room_id, url, upvotes, added_at)`. IDs generated with `uuidv7()`.  
Addresses NFR-06 (token expiry via `last_active_at`), NFR-08 (clean schema per module).

#### [NEW] [server/stateStore.js](file:///home/cypher/SE/project3/server/stateStore.js)
Two-layer store: in-memory `Map` (µs reads) **+ Redis** (`ioredis`) for persistence across restarts.  
Snapshot shape: `{ url, position, status, updatedAt }` serialised as a Redis hash (`HSET room:<id>:state`).  
Writes go to both layers; reads hit memory first with Redis fallback. Satisfies NFR-03 (state survives host crash).

---

### Backend — Services

#### [NEW] [server/roomService.js](file:///home/cypher/SE/project3/server/roomService.js)
**FR-01 Room Creation**: `POST /api/rooms` → generates **UUIDv7** room ID + 32-byte invite token; returns `{ roomId, inviteLink }`. No auth required.  
**FR-04 Roles**: first joiner = host; subsequent = guest. Host can grant co-host via `GRANT_COHOST` WS message.  
NFR-06: invite tokens expire after 24 h of room inactivity (checked on join).

#### [NEW] [server/syncService.js](file:///home/cypher/SE/project3/server/syncService.js)
Manages WebSocket connections per room (`Map<roomId, Set<ws>>`).  
**FR-02 Playback Sync**: host sends `{ type: "PLAY"|"PAUSE"|"SEEK", position }` → server validates sender is host → broadcasts to all guests; target latency ≤1 s (NFR-01).  
**FR-03 Late-Join Catch-up**: on `JOIN` message, server reads `stateStore` snapshot and immediately sends `{ type: "CATCHUP", position, status }` to the new client. Satisfies NFR-03.  
**FR-07 Host Migration** (NFR-03): on host websocket `close`, server picks the oldest-connected guest and sends `{ type: "HOST_PROMOTED" }` within 3 s.

#### [NEW] [server/gateway.js](file:///home/cypher/SE/project3/server/gateway.js)
Express middleware layer: invite-token validation, rate-limiting (100 req/min per IP via sliding-window counter), routes to roomService. NFR-06, NFR-04.

#### [NEW] [server/index.js](file:///home/cypher/SE/project3/server/index.js)
Wires Express + `ws.Server` on the same HTTP server. Entry point: `node server/index.js`. Port configurable via `PORT` env var (default 3000).

---

### Frontend

#### [NEW] [public/index.html](file:///home/cypher/SE/project3/public/index.html)
Landing page — "Create Room" button (calls `POST /api/rooms`, redirects to `/room.html?roomId=…&token=…`). No account required (NFR-05). Dark-mode glassmorphism design.

#### [NEW] [public/room.html](file:///home/cypher/SE/project3/public/room.html)
In-room page — YouTube iframe embed, host controls (play/pause/seek bar), guest view-only overlay, participant list, invite-link copy button. Adapts UI based on role.

#### [NEW] [public/css/style.css](file:///home/cypher/SE/project3/public/css/style.css)
Dark-mode design system: CSS custom properties, Inter font (Google Fonts), gradient accents, card glassmorphism, smooth micro-animations.

#### [NEW] [public/js/main.js](file:///home/cypher/SE/project3/public/js/main.js)
Landing page: calls `POST /api/rooms`, stores token in sessionStorage, redirects. Also handles join-via-invite flow (reads `?token=` param).

#### [NEW] [public/js/room.js](file:///home/cypher/SE/project3/public/js/room.js)
WebSocket client for the room page. Handles:
- FR-02: host control events → WS `PLAY/PAUSE/SEEK` → applies to iframe via YouTube IFrame API.
- FR-03: receives `CATCHUP` → seeks iframe to position.
- FR-04: role-based UI gating.
- FR-07: receives `HOST_PROMOTED` → unlocks controls.

---

### Tests

#### [NEW] [tests/room.test.js](file:///home/cypher/SE/project3/tests/room.test.js)
Jest + supertest. Covers: room creation returns valid invite link; duplicate token rejected; expired token rejected; role assignment (first = host, second = guest).

#### [NEW] [tests/sync.test.js](file:///home/cypher/SE/project3/tests/sync.test.js)
Jest with `ws` client. Covers: PLAY/PAUSE/SEEK broadcast to all guests; CATCHUP sent to late-joiner; non-host PLAY rejected; host-migration fires within 3 s.

---

## Verification Plan

### Automated Tests
```bash
# Set env vars (or create a .env file)
export DATABASE_URL="postgresql://localhost:5432/watchparty"
export REDIS_URL="redis://localhost:6379"

# Install deps
cd /home/cypher/SE/project3
npm install

# Run all Jest tests
npm test
```
Expected: all room & sync tests pass ✅.

### Manual Verification (Browser)
1. `node server/index.js` → open `http://localhost:3000`
2. **FR-01**: Click "Create Room" → verify URL contains `roomId` + `token`; copy invite link.
3. **FR-04**: Open copied invite link in a second browser tab → second tab shows "Guest" label; host tab shows playback controls, guest tab does not.
4. Load a YouTube URL in the host input field → video loads in iframe.
5. **FR-02**: Press Play in host tab → guest tab starts within ~1 s. Pause / Seek — verify guest mirrors within ~1 s (NFR-01).
6. **FR-03**: Open a third tab with the invite link mid-playback → verify it jumps to current position automatically (no manual seek needed).
7. **NFR-06 / Security**: Tamper `token` param → server returns 403.
8. **NFR-05 / Usability**: Time the full flow from landing page to inviting a friend: target ≤2 min.
