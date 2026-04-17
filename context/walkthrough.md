# WatchParty — Implementation Walkthrough

## What Was Built

Full-stack prototype satisfying all four **Must Have** FRs from [requirements.md](file:///home/cypher/SE/project3/requirements.md), using the exact architecture from [architecture.png](file:///home/cypher/SE/project3/architecture.png).

---

## Files Created

| File | Purpose |
|------|---------|
| [package.json](file:///home/cypher/SE/project3/package.json) | Express, ws, uuidv7, pg, ioredis dependencies |
| [.env.example](file:///home/cypher/SE/project3/.env.example) | Environment variable template |
| [server/schema.sql](file:///home/cypher/SE/project3/server/schema.sql) | PostgreSQL DDL (rooms, room_members, queue) |
| [server/db.js](file:///home/cypher/SE/project3/server/db.js) | pg Pool + [initDb()](file:///home/cypher/SE/project3/server/db.js#37-46) (idempotent schema init) |
| [server/stateStore.js](file:///home/cypher/SE/project3/server/stateStore.js) | Two-layer state: in-memory Map + Redis hash |
| [server/roomService.js](file:///home/cypher/SE/project3/server/roomService.js) | FR-01/FR-04 — room creation, token check, role assignment |
| [server/syncService.js](file:///home/cypher/SE/project3/server/syncService.js) | FR-02/FR-03/FR-07 — WebSocket hub, broadcast, catch-up, host migration |
| [server/gateway.js](file:///home/cypher/SE/project3/server/gateway.js) | Rate limiter (100 req/min), JSON body, route mounting |
| [server/index.js](file:///home/cypher/SE/project3/server/index.js) | HTTP + WebSocket server entry point |
| [public/css/style.css](file:///home/cypher/SE/project3/public/css/style.css) | Dark-mode glass design system (Inter, gradients, micro-animations) |
| [public/index.html](file:///home/cypher/SE/project3/public/index.html) | Landing — Create/Join tabs, no account needed |
| [public/room.html](file:///home/cypher/SE/project3/public/room.html) | In-room — grid layout, YouTube embed, adaptive role UI |
| [public/js/main.js](file:///home/cypher/SE/project3/public/js/main.js) | Landing page: create-room API call, join via invite link |
| [public/js/room.js](file:///home/cypher/SE/project3/public/js/room.js) | WebSocket client: PLAY/PAUSE/SEEK/CATCHUP/HOST_PROMOTED |
| [tests/room.test.js](file:///home/cypher/SE/project3/tests/room.test.js) | roomService unit tests (mocked DB) |
| [tests/sync.test.js](file:///home/cypher/SE/project3/tests/sync.test.js) | syncService integration tests (live ws.Server) |

---

## FR Coverage

| FR | Requirement | Implementation |
|----|-------------|---------------|
| FR-01 | Room creation + invite link | `POST /api/rooms` → UUIDv7 roomId + 32-byte token → `/room.html?roomId=…&token=…` |
| FR-02 | Playback sync ≤ 1 s | WS `PLAY/PAUSE/SEEK` from host → broadcast to all guests via `syncService` |
| FR-03 | Late-join catch-up | On `JOIN`, server reads `stateStore` and sends `CATCHUP {position, status, url}` |
| FR-04 | Host/guest roles | First joiner = host (DB check); guests cannot send playback commands |

## NFR Coverage

| NFR | How addressed |
|-----|--------------|
| NFR-01 Sync ≤ 1s | Single-hop broadcast — no relay processing outside the WS handler |
| NFR-03 Fault tolerance | Redis persists state across crashes; host migration fires within 2.5 s |
| NFR-04 Scalability | Sliding-window rate limiter (100/min/IP); pg pool capped at 10 conn |
| NFR-05 Usability | No account, no install; entire create → invite flow is 2 clicks |
| NFR-06 Security | Timing-safe token comparison; 24 h inactivity expiry on invite links |
| NFR-07 Browser compat | Vanilla HTML/CSS/JS + YouTube IFrame API (Chrome, Firefox, Safari) |
| NFR-08 Maintainability | Each module ≤ 1 responsibility; Jest coverage on all critical paths |

---

## Test Results

```
PASS  tests/room.test.js
PASS  tests/sync.test.js

Tests:  14 passed, 14 total
Time:   3.94 s
```

**room.test.js** (8 tests): room creation uniqueness, host/guest roles, wrong token → 403, unknown room → 404, missing fields → 400, expired token → 403, rate limiter → 429.

**sync.test.js** (6 tests): guest PLAY rejected, host PLAY broadcast, host PAUSE broadcast, late-join CATCHUP, host migration within 3 s.

---

## How to Run

```bash
# 1. Copy env
cp .env.example .env
# edit DATABASE_URL and REDIS_URL

# 2. Create Postgres database
createdb watchparty

# 3. Start server (schema auto-applied)
npm start

# 4. Open http://localhost:3000
```

### Manual Verification Steps
1. **FR-01** — Click "Create Room" → URL changes to `/room.html?roomId=…&token=…`
2. **FR-04** — Open invite link in a second tab → first tab shows 👑 Host controls; second shows `⏸ Playback controlled by the host`
3. **FR-02** — Paste a YouTube URL (host panel) → click Load → Press Play → guest tab starts within ~1 s
4. **FR-03** — Open a third tab with the invite link mid-playback → video auto-seeks to current position
5. **NFR-06** — Tamper `token` param in URL → `/api/rooms/join` returns `403 Invalid invite token`
