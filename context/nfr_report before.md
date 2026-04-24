# WatchParty — NFR Compliance Audit

**Scope:** All 8 Non-Functional Requirements (NFR-01 → NFR-08) from [requirements.md](file:///Users/rahul/Documents/WatchParty/requirements.md)  
**Audited against:** Every file in the WatchParty repository  
**Date:** 2026-04-21

---

## Summary Table

| NFR | Attribute | Status | Grade |
|-----|-----------|--------|-------|
| NFR-01 | Sync Latency (≤1 s) | ✅ Fully Met | A |
| NFR-02 | Availability (99% uptime) | ⚠️ Partially Met | C |
| NFR-03 | Fault Tolerance (host migration ≤3 s) | ✅ Fully Met | A |
| NFR-04 | Scalability (≤10 users/room, ≤20 rooms) | ⚠️ Partially Met | B |
| NFR-05 | Usability (room+invite in 2 min, no install) | ✅ Fully Met | A |
| NFR-06 | Security (invite-only, 24 h token expiry) | ⚠️ Partially Met | B |
| NFR-07 | Browser Compatibility (Chrome/Firefox/Safari) | ⚠️ Partially Met | C |
| NFR-08 | Maintainability (coding standards, ≥70% coverage) | ❌ Not Met | D |

---

## Detailed Analysis

---

### NFR-01 — Sync Latency ≤1 s  ✅ Fully Met

> **Requirement:** Playback state propagates to all guests within 1 s on broadband.

**Evidence in code:**

| What | Where | How |
|------|-------|-----|
| Direct WebSocket broadcast | [syncService.js:71-77](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L71-L77) | `broadcast()` iterates the in-memory `rooms` Map and calls `ws.send()` — zero DB round-trips in the hot path |
| In-memory state reads | [stateStore.js:94-96](file:///Users/rahul/Documents/WatchParty/server/stateStore.js#L94-L96) | `getState()` reads from an in-memory Map (µs) before touching Redis |
| State writes are fire-and-forget to Redis | [stateStore.js:79-86](file:///Users/rahul/Documents/WatchParty/server/stateStore.js#L79-L86) | Redis write failure doesn't block the broadcast |
| Command pattern (PLAY/PAUSE/SEEK) | [syncService.js:268-285](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L268-L285) | Discrete command objects, validated and broadcast immediately |

**Verdict:** The architecture is purpose-built for sub-second latency. No DB/Redis in the broadcast critical path. ✅

> [!TIP]
> **Optional improvement:** Add server-side latency instrumentation (timestamp on outbound messages vs. broadcast call time) to *prove* ≤1 s during evaluation.

---

### NFR-02 — Availability (99% uptime)  ⚠️ Partially Met

> **Requirement:** Server targets 99% uptime during evaluation; planned downtime announced in advance.

**Evidence in code:**

| What | Where |
|------|-------|
| Graceful shutdown on SIGTERM | [index.js:65-68](file:///Users/rahul/Documents/WatchParty/server/index.js#L65-L68) |
| DB fallback to in-memory if Postgres unavailable | [db.js:59-74](file:///Users/rahul/Documents/WatchParty/server/db.js#L59-L74) |
| Redis fallback to memory-only | [stateStore.js:24-64](file:///Users/rahul/Documents/WatchParty/server/stateStore.js#L24-L64) |

**Gaps found:**

| Gap | Impact | Severity |
|-----|--------|----------|
| **No process manager** — `npm start` runs a bare `node server/index.js`; crash = downtime | Unhandled exceptions kill the process with no auto-restart | 🔴 High |
| **No health-check monitoring** — `/api/health` exists but nothing polls it | No alerting on degradation | 🟡 Medium |
| **Single-process architecture** — no clustering, no load balancer config | Single point of failure | 🟡 Medium |
| **No `SIGINT` handler** — only `SIGTERM` is handled | Ctrl+C during dev creates orphan connections | 🟢 Low |

> [!IMPORTANT]
> **Recommended improvements:**
> 1. Add `pm2` or `systemd` unit file for auto-restart on crash
> 2. Add `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers to log and restart gracefully
> 3. Add `SIGINT` alongside `SIGTERM` in the shutdown handler
> 4. Document a monitoring/uptime strategy (e.g., UptimeRobot polling `/api/health`)

---

### NFR-03 — Fault Tolerance (host migration ≤3 s)  ✅ Fully Met

> **Requirement:** Host dropout triggers automatic promotion of a guest within 3 s; session continues uninterrupted.

**Evidence in code:**

| What | Where |
|------|-------|
| `HOST_MIGRATION_DELAY_MS = 2_500` (well within 3 s) | [syncService.js:61](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L61) |
| `scheduleHostMigration()` promotes oldest-connected guest | [syncService.js:148-175](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L148-L175) |
| On `ws.close`, if departed was host → trigger migration | [syncService.js:510-513](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L510-L513) |
| `HOST_PROMOTED` message sent to new host + `MEMBER_LIST` broadcast | [syncService.js:171-172](file:///Users/rahul/Documents/WatchParty/server/syncService.js#L171-L172) |
| Persisted to DB via `promoteToHost()` | [roomService.js:132-138](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L132-L138) |
| **Test: guest promoted within 3 s** | [sync.test.js:337-367](file:///Users/rahul/Documents/WatchParty/tests/sync.test.js#L337-L367) — 5 s timeout, asserts `HOST_PROMOTED` |

**Verdict:** Fully implemented with test coverage. ✅

> [!TIP]
> **Minor improvement:** The migration timer is not cancelled if a new host reconnects before 2.5 s. Consider storing the timer handle and clearing it on re-join.

---

### NFR-04 — Scalability (≤10 users/room, ≤20 rooms)  ⚠️ Partially Met

> **Requirement:** Supports ≤10 users/room and ≤20 simultaneous rooms without performance degradation.

**Evidence in code:**

| What | Where |
|------|-------|
| Rate limiter: 100 req/min per IP | [gateway.js:18-34](file:///Users/rahul/Documents/WatchParty/server/gateway.js#L18-L34) |
| Rate limiter test | [room.test.js:157-167](file:///Users/rahul/Documents/WatchParty/tests/room.test.js#L157-L167) |
| JSON body limit: 16 KB | [gateway.js:37](file:///Users/rahul/Documents/WatchParty/server/gateway.js#L37) |
| DB pool max: 10 connections | [db.js:23](file:///Users/rahul/Documents/WatchParty/server/db.js#L23) |

**Gaps found:**

| Gap | Impact | Severity |
|-----|--------|----------|
| **No room member cap** — code never checks `members.size < 10` before JOIN | 11th user can join; no enforcement | 🔴 High |
| **No concurrent room cap** — `rooms` Map grows unbounded | 21st room can be created; no enforcement | 🟡 Medium |
| **Rate limiter leaks memory** — `ipWindows` Map is never pruned for stale IPs | Memory grows linearly with unique visitors | 🟡 Medium |
| **No load/stress test** | Can't verify "without performance degradation" claim | 🟡 Medium |

> [!IMPORTANT]
> **Recommended improvements:**
> 1. Add a member count check in the `JOIN` handler: reject with error if `members.size >= 10`
> 2. Add a room count check in `createRoom()`: reject if `rooms.size >= 20`
> 3. Add a periodic cleanup interval for the `ipWindows` map (e.g., every 5 min, purge entries older than `WINDOW_MS`)
> 4. Add a basic load test script (e.g., using `ws` library) simulating 10 users in 20 rooms

---

### NFR-05 — Usability (create+invite in <2 min, no install)  ✅ Fully Met

> **Requirement:** First-time user can create a room and invite a friend within 2 minutes; no account or install needed.

**Evidence in code:**

| What | Where |
|------|-------|
| Landing page: single-button room creation | [index.html:153-156](file:///Users/rahul/Documents/WatchParty/public/index.html#L153-L156) |
| No auth / no account required | [roomService.js:37](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L37) — comment: "No auth required (NFR-05)" |
| `POST /api/rooms` → returns `inviteLink` immediately | [roomService.js:48-52](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L48-L52) |
| Copy invite link button | [room.html:675](file:///Users/rahul/Documents/WatchParty/public/room.html#L675) |
| Join panel: paste invite link and go | [index.html:162-175](file:///Users/rahul/Documents/WatchParty/public/index.html#L162-L175) |
| Optional display name (defaults to "Guest") | [roomService.js:65](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L65) |
| Browser-based, no install | Pure HTML/CSS/JS served via Express static |

**Verdict:** The happy path (create → copy link → friend joins) is achievable well within 2 minutes. ✅

---

### NFR-06 — Security (invite-only, 24 h token expiry)  ⚠️ Partially Met

> **Requirement:** Rooms accessible only via invite link; tokens expire after 24 hours of inactivity.

**Evidence in code ✅:**

| What | Where |
|------|-------|
| 32-byte cryptographic invite token | [roomService.js:17-23](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L17-L23) |
| Constant-time token comparison (`timingSafeEqual`) | [roomService.js:84-90](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L84-L90) |
| 24 h token expiry check on `last_active_at` | [roomService.js:92-97](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L92-L97) |
| `last_active_at` refreshed on every join | [roomService.js:115-118](file:///Users/rahul/Documents/WatchParty/server/roomService.js#L115-L118) |
| Redis TTL mirrors 24 h | [stateStore.js:67](file:///Users/rahul/Documents/WatchParty/server/stateStore.js#L67) |
| Test: wrong token → 403 | [room.test.js:112-118](file:///Users/rahul/Documents/WatchParty/tests/room.test.js#L112-L118) |
| Test: expired token → 403 | [room.test.js:136-153](file:///Users/rahul/Documents/WatchParty/tests/room.test.js#L136-L153) |

**Gaps found:**

| Gap | Impact | Severity |
|-----|--------|----------|
| **No token validation on WebSocket upgrade** — anyone who knows a `roomId` can connect to `/ws` without a valid token | Bypasses invite-only requirement entirely | 🔴 Critical |
| **No `helmet` or security headers** | Missing `X-Frame-Options`, `CSP`, `HSTS`, etc. | 🟡 Medium |
| **No CORS policy** | Any origin can make API requests | 🟡 Medium |
| **No WebSocket message size limit** | Potential DoS via oversized messages | 🟢 Low |
| **Chat message capped at 500 chars but no XSS sanitization** | Messages are broadcast as raw text; if client renders as HTML, XSS is possible | 🟡 Medium |

> [!CAUTION]
> **Critical finding:** The WebSocket upgrade path in [index.js:43-55](file:///Users/rahul/Documents/WatchParty/server/index.js#L43-L55) only checks `req.url.startsWith('/ws')` — it does **not** validate the invite token. The gateway.js comment mentions "Invite-token pre-validation on WS upgrade" but this is **not implemented**. A user can skip the `/api/rooms/join` flow and connect directly via WebSocket with any `roomId`.

> [!IMPORTANT]
> **Recommended improvements:**
> 1. **Add token validation on WS upgrade:** Parse `?token=` from the upgrade URL, validate against DB before calling `wss.handleUpgrade()`
> 2. Add `helmet` middleware for security headers
> 3. Add CORS middleware restricting to the app's own origin
> 4. Set `maxPayload` on `WebSocketServer` (e.g., 64 KB)
> 5. Sanitize chat/reaction content on the server or ensure client uses `textContent` (not `innerHTML`)

---

### NFR-07 — Browser Compatibility (Chrome, Firefox, Safari)  ⚠️ Partially Met

> **Requirement:** Core features work on the latest two stable versions of Chrome, Firefox, and Safari.

**Evidence in code:**

| What | Where |
|------|-------|
| Standard HTML5, CSS3, vanilla JS | `public/index.html`, `public/room.html` |
| YouTube IFrame API (cross-browser) | [room.html:758](file:///Users/rahul/Documents/WatchParty/public/room.html#L758) |
| `WebSocket` (native in all modern browsers) | Client-side JS |
| CSS Grid, Flexbox (universal support) | `public/css/style.css`, inline styles |
| Responsive media queries | [room.html:587-598](file:///Users/rahul/Documents/WatchParty/public/room.html#L587-L598) |

**Gaps found:**

| Gap | Impact | Severity |
|-----|--------|----------|
| **No cross-browser test suite** | Can't prove compatibility with latest 2 versions | 🔴 High |
| **No browser testing infrastructure** (Playwright/Selenium/BrowserStack) | No automated verification | 🟡 Medium |
| **`-webkit-` prefixed CSS** without standard fallback for seek bar | [room.html:406-414](file:///Users/rahul/Documents/WatchParty/public/room.html#L406-L414) — `::-webkit-slider-runnable-track` won't style on Firefox | 🟡 Medium |
| **`??` (nullish coalescing) used in server code** | Not a client issue, but limits server to Node ≥14 | 🟢 Low |
| Footer in `index.html` claims Chrome/Firefox/Safari support but nothing tests it | [index.html:194](file:///Users/rahul/Documents/WatchParty/public/index.html#L194) | 🟢 Low |

> [!IMPORTANT]
> **Recommended improvements:**
> 1. Add Playwright or Cypress for cross-browser E2E tests (at minimum: Chrome + Firefox)
> 2. Add Firefox-compatible range slider styling (`::-moz-range-track`)
> 3. Manual smoke test checklist for Safari (WebKit quirks with WebSocket + IFrame)

---

### NFR-08 — Maintainability (coding standards, ≥70% test coverage)  ❌ Not Met

> **Requirement:** Agreed coding standards enforced; each module has ≥70% unit-test coverage before integration.

**Evidence in code:**

| What | Where |
|------|-------|
| `'use strict'` in all server modules | ✅ Every `.js` file |
| JSDoc comments on public functions | ✅ Consistent across services |
| Modular architecture (roomService, queueService, stateStore, syncService, gateway) | ✅ Good separation |
| 3 test files with meaningful coverage | `tests/sync.test.js`, `tests/room.test.js`, `tests/queue.test.js` |
| Jest configured in `package.json` | ✅ `"test": "jest --testEnvironment node --forceExit"` |

**Gaps found:**

| Gap | Impact | Severity |
|-----|--------|----------|
| **No linter configured** — no ESLint, Prettier, or `.editorconfig` in the project | "Agreed coding standards enforced" is unverifiable | 🔴 High |
| **No coverage reporting** — Jest not configured with `--coverage`; no coverage thresholds | Can't prove ≥70% per module | 🔴 High |
| **No CI/CD pipeline** — no `.github/workflows`, no `Makefile`, no pre-commit hooks | Standards not enforced automatically | 🔴 High |
| **Untested modules:** `memoryDb.js` (214 lines), `stateStore.js` (134 lines), `gateway.js` (53 lines), `db.js` (78 lines) have **no direct unit tests** | Multiple modules below 70% threshold | 🟡 Medium |
| **Client JS completely untested** — `room.js` (44 KB) and `main.js` (5 KB) have zero tests | Largest codebase area with 0% coverage | 🟡 Medium |
| **`handlers/` directory is empty** — dead code from refactoring? | Confusing project structure | 🟢 Low |

> [!WARNING]
> **This is the most significant NFR gap.** The requirement states "each module has ≥70% unit-test coverage before integration" — currently, only 3 of 7+ server modules have tests, and no coverage threshold is enforced.

> [!IMPORTANT]
> **Recommended improvements:**
> 1. **Add ESLint + Prettier:**
>    ```bash
>    npm install -D eslint prettier eslint-config-prettier
>    ```
>    Create `.eslintrc.json` with agreed rules and add `"lint": "eslint server/ tests/"` to `package.json`
> 2. **Enable coverage thresholds in Jest** — add to `package.json`:
>    ```json
>    "jest": {
>      "coverageThreshold": {
>        "global": { "branches": 70, "functions": 70, "lines": 70, "statements": 70 }
>      }
>    }
>    ```
> 3. **Add unit tests for untested modules:** `stateStore.js`, `memoryDb.js`, `gateway.js`, `db.js`
> 4. **Add CI pipeline** — even a basic GitHub Actions workflow that runs `npm test` on push
> 5. **Clean up `server/handlers/`** — the directory is empty and may confuse contributors
> 6. **Add a pre-commit hook** via `husky` to enforce lint + test

---

## Priority Improvement Roadmap

### 🔴 P0 — Must Fix (blocks NFR compliance)

1. **NFR-06:** Add WebSocket upgrade token validation (security bypass)
2. **NFR-08:** Add ESLint config + enforce coding standards
3. **NFR-08:** Add `--coverage` with 70% thresholds to Jest
4. **NFR-04:** Enforce 10-user/room and 20-room caps

### 🟡 P1 — Should Fix (significant gaps)

5. **NFR-02:** Add process manager (pm2) for auto-restart
6. **NFR-06:** Add `helmet` + CORS middleware
7. **NFR-07:** Add Firefox range slider CSS + cross-browser E2E test
8. **NFR-08:** Write unit tests for `stateStore.js`, `memoryDb.js`, `gateway.js`
9. **NFR-02:** Add `uncaughtException` / `unhandledRejection` handlers

### 🟢 P2 — Nice to Have

10. **NFR-01:** Add latency instrumentation/logging
11. **NFR-03:** Cancel migration timer if new host connects before timeout
12. **NFR-04:** Rate limiter memory cleanup interval
13. **NFR-08:** Add CI/CD pipeline + pre-commit hooks
14. Clean up empty `server/handlers/` directory
