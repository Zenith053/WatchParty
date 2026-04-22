/**
 * gateway.js — API Gateway using Facade Pattern (NFR-06 Security · NFR-04 Scalability)
 *
 * Design Pattern: Facade
 *   Provides a unified, simplified interface that hides the complexity of
 *   subsystem routing, rate limiting, and middleware configuration.
 *
 * Responsibilities:
 *   1. Rate-limiting: 100 req/min per IP (sliding-window in memory)
 *   2. JSON body parsing with size limit
 *   3. Route mounting: /api/rooms → roomService handlers
 *   4. Serves static files from /public
 *   5. Health check endpoint
 */
'use strict';

const express   = require('express');
const path      = require('path');
const { createRoom, joinRoom } = require('./roomService');

// ── API Gateway Facade ────────────────────────────────────────────────────

class APIGateway {
  /**
   * @param {object} [options]
   * @param {number} [options.rateLimit=100]  Max requests per window
   * @param {number} [options.windowMs=60000] Rate limit window in ms
   * @param {string} [options.bodyLimit='16kb'] Max JSON body size
   */
  constructor(options = {}) {
    this.rateLimit  = options.rateLimit  ?? 100;
    this.windowMs   = options.windowMs   ?? 60_000;
    this.bodyLimit  = options.bodyLimit   ?? '16kb';
    this.ipWindows  = new Map(); // ip → [timestamp, ...]
    this.router     = express.Router();

    this._setupMiddleware();
    this._mountRoutes();

    // Prune every 5 minutes
    const PRUNE_INTERVAL_MS = 5 * 60_000;
    this.pruneTimer = setInterval(() => this._pruneRateLimiter(), PRUNE_INTERVAL_MS);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  // ── Middleware setup (private) ─────────────────────────────────────────

  _setupMiddleware() {
    this.router.use(express.json({ limit: this.bodyLimit }));
    this.router.use(this._createRateLimiter());
  }

  /**
   * Create a sliding-window rate limiter middleware (NFR-04).
   * @returns {Function} Express middleware
   */
  _createRateLimiter() {
    return (req, res, next) => {
      const ip  = req.ip;
      const now = Date.now();
      const hits = (this.ipWindows.get(ip) ?? []).filter(t => now - t < this.windowMs);
      hits.push(now);
      this.ipWindows.set(ip, hits);

      if (hits.length > this.rateLimit) {
        return res.status(429).json({ error: 'Too many requests — slow down' });
      }
      next();
    };
  }

  // ── Route mounting (private) ──────────────────────────────────────────

  _mountRoutes() {
    // Room routes (FR-01, FR-04)
    this.router.post('/rooms',      createRoom);
    this.router.post('/rooms/join', joinRoom);

    // Health check
    this.router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Get the Express router (for mounting on the app).
   * @returns {express.Router}
   */
  getRouter() {
    return this.router;
  }

  /**
   * Get the rate limiter middleware (for testing).
   * @returns {Function}
   */
  getRateLimiter() {
    return this._createRateLimiter();
  }
  /**
   * NFR-04: Periodic cleanup to prevent ipWindows Map from leaking memory.
   * Removes IP entries where all hits are older than windowMs.
   */
  _pruneRateLimiter() {
    const now = Date.now();
    let pruned = 0;
    for (const [ip, hits] of this.ipWindows.entries()) {
      const remains = hits.filter(t => now - t < this.windowMs);
      if (remains.length === 0) {
        this.ipWindows.delete(ip);
        pruned++;
      } else {
        this.ipWindows.set(ip, remains);
      }
    }
    if (pruned > 0 && process.env.WP_NODE_ENV !== 'test') {
      console.debug(`[gateway] Pruned ${pruned} stale IPs from rate limiter`);
    }
  }
}

// ── Static file serving ────────────────────────────────────────────────────

function staticMiddleware() {
  return express.static(path.join(__dirname, '..', 'public'));
}

// ── Singleton gateway + backward-compatible exports ────────────────────────

const gateway = new APIGateway();

module.exports = {
  router:           gateway.getRouter(),
  staticMiddleware,
  rateLimiter:      gateway.getRateLimiter(),
  APIGateway,  // Export class for testing / custom configuration
};
