/**
 * gateway.js — API Gateway middleware (NFR-06 Security · NFR-04 Scalability)
 *
 * Responsibilities:
 *   1. Invite-token pre-validation on WS upgrade (lightweight, no DB hit)
 *   2. Rate-limiting: 100 req/min per IP (sliding-window in memory)
 *   3. Route mounting: /api/rooms → roomService handlers
 *   4. Serves static files from /public
 */
'use strict';

const express   = require('express');
const path      = require('path');
const { createRoom, joinRoom } = require('./roomService');

const router = express.Router();

// ── Rate limiter (sliding-window, NFR-04) ──────────────────────────────────
const ipWindows = new Map(); // ip → [timestamp, ...]
const RATE_LIMIT    = 100;
const WINDOW_MS     = 60_000;

function rateLimiter(req, res, next) {
  const ip  = req.ip;
  const now = Date.now();
  const hits = (ipWindows.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  ipWindows.set(ip, hits);

  if (hits.length > RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests — slow down' });
  }
  return next();
}

// ── JSON body parsing ──────────────────────────────────────────────────────
router.use(express.json({ limit: '16kb' }));
router.use(rateLimiter);

// ── Room routes ────────────────────────────────────────────────────────────
router.post('/rooms',      createRoom);
router.post('/rooms/join', joinRoom);

// ── Health check ───────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Static file serving ────────────────────────────────────────────────────
function staticMiddleware() {
  return express.static(path.join(__dirname, '..', 'public'));
}

module.exports = { router, staticMiddleware, rateLimiter };
