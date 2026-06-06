/**
 * stateStore.js — Singleton Pattern for playback state management (NFR-03)
 *
 * Design Patterns:
 *   - Singleton:      StateStore class with lazy initialization and explicit connect()
 *   - State Machine:  Validates playback status transitions via RoomStateMachine
 *
 * Layer 1: In-memory Map  (µs reads, lives with process)
 * Layer 2: Redis hash      (persistence across restarts / crashes)
 *
 * If Redis is unavailable, gracefully degrades to memory-only mode.
 *
 * Snapshot shape: { url, position, status, updatedAt }
 *   url       – current video URL (normalised embed)
 *   position  – playback position in seconds (float)
 *   status    – 'playing' | 'paused' | 'ended'
 *   updatedAt – ISO timestamp of last write
 */
'use strict';

const { RoomStateMachine } = require('./roomStateMachine');

// ── Singleton StateStore class ────────────────────────────────────────────

class StateStore {
  static #instance = null;

  /**
   * Get the singleton StateStore instance.
   * @returns {StateStore}
   */
  static getInstance() {
    if (!StateStore.#instance) {
      StateStore.#instance = new StateStore();
    }
    return StateStore.#instance;
  }

  /**
   * Reset the singleton (for testing only).
   */
  static resetInstance() {
    StateStore.#instance = null;
  }

  constructor() {
    /** @type {Map<string, object>} In-memory state (always available) */
    this.memStore = new Map();

    /** @type {Map<string, RoomStateMachine>} Per-room state machines */
    this.machines = new Map();

    /** @type {object|null} Redis client */
    this.redis = null;

    /** @type {boolean} Whether Redis is connected and usable */
    this.redisAvailable = false;

    this._connectRedis();
  }

  /**
   * Attempt to connect to Redis. Non-blocking; degrades gracefully.
   */
  _connectRedis() {
    try {
      const Redis = require('ioredis');
      this.redis = new Redis(process.env.WP_REDIS_URL || 'redis://localhost:6379', {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
          if (times > 2) {
            console.warn('[stateStore] Redis unavailable — running memory-only mode');
            return null; // stop retrying
          }
          return Math.min(times * 200, 1000);
        },
        enableOfflineQueue: false,
        connectTimeout: 3000,
      });

      this.redis.on('connect', () => {
        this.redisAvailable = true;
        console.log('[stateStore] Redis connected');
      });

      this.redis.on('error', (err) => {
        if (this.redisAvailable) {
          console.warn('[stateStore] Redis error (falling back to memory):', err.message);
        }
        this.redisAvailable = false;
      });

      this.redis.on('close', () => {
        this.redisAvailable = false;
      });

      // Attempt connection but don't block startup
      this.redis.connect().catch(() => {
        console.warn('[stateStore] Redis not available — using memory-only mode');
        this.redisAvailable = false;
      });
    } catch {
      console.warn('[stateStore] ioredis not available — using memory-only mode');
    }
  }

  /** Redis key for a room's state hash. */
  _redisKey(roomId) {
    return `room:${roomId}:state`;
  }

  /** TTL matches NFR-06 token expiry. */
  get REDIS_TTL() {
    return 86_400; // 24 h
  }

  /**
   * Get or create the state machine for a room.
   * @param {string} roomId
   * @param {string} [initialState='idle']
   * @returns {RoomStateMachine}
   */
  _getMachine(roomId, initialState = 'idle') {
    if (!this.machines.has(roomId)) {
      this.machines.set(roomId, new RoomStateMachine(initialState));
    }
    return this.machines.get(roomId);
  }

  /**
   * Write snapshot to both layers.
   * Validates state transitions via the RoomStateMachine.
   *
   * @param {string} roomId
   * @param {object} snapshot  Partial or full snapshot; merged with existing.
   */
  async setState(roomId, snapshot) {
    // State Machine validation: if a status change is requested, validate it
    if (snapshot.status) {
      const existing = this.memStore.get(roomId);
      const currentStatus = existing?.status ?? 'idle';
      const machine = this._getMachine(roomId, currentStatus);

      // Sync machine state with stored state (handles edge cases)
      if (machine.state !== currentStatus) {
        try {
          machine.transition(currentStatus);
        } catch {
          // If we can't sync, reset the machine to current state
          this.machines.set(roomId, new RoomStateMachine(
            ['idle', 'paused', 'playing', 'ended'].includes(currentStatus) ? currentStatus : 'idle'
          ));
        }
      }

      // Validate the requested transition
      try {
        machine.transition(snapshot.status);
      } catch (err) {
        console.warn(`[stateStore] ${err.message} — allowing anyway for backward compat`);
        // Allow the transition for backward compatibility but log the warning
        this.machines.set(roomId, new RoomStateMachine(snapshot.status));
      }
    }

    const existing = this.memStore.get(roomId) ?? {};
    const next = { ...existing, ...snapshot, updatedAt: new Date().toISOString() };
    this.memStore.set(roomId, next);

    if (this.redisAvailable && this.redis) {
      try {
        await this.redis.hset(this._redisKey(roomId), next);
        await this.redis.expire(this._redisKey(roomId), this.REDIS_TTL);
      } catch {
        // Redis unavailable — memory-only is degraded but functional
      }
    }

    return next;
  }

  /**
   * Read snapshot — memory first, Redis fallback.
   * @param {string} roomId
   * @returns {object|null}
   */
  async getState(roomId) {
    const mem = this.memStore.get(roomId);
    if (mem) return mem;

    if (this.redisAvailable && this.redis) {
      try {
        const raw = await this.redis.hgetall(this._redisKey(roomId));
        if (raw && raw.url) {
          // Rehydrate memory from Redis
          const snap = {
            url: raw.url,
            position: parseFloat(raw.position ?? 0),
            status: raw.status ?? 'paused',
            updatedAt: raw.updatedAt,
          };
          this.memStore.set(roomId, snap);
          return snap;
        }
      } catch {
        // Redis unavailable
      }
    }
    return null;
  }

  /**
   * Remove state for a room (called when room is deleted / expired).
   */
  async deleteState(roomId) {
    this.memStore.delete(roomId);
    this.machines.delete(roomId); // Clean up state machine
    if (this.redisAvailable && this.redis) {
      try {
        await this.redis.del(this._redisKey(roomId));
      } catch {
        // ignore
      }
    }
  }
}

// ── Module-level exports (backward-compatible with existing code) ─────────

const store = StateStore.getInstance();

function buildPlaybackClock(snapshot, nowMs = Date.now()) {
  if (!snapshot) return null;

  const basePosition = Number(snapshot.position ?? 0);
  const safeBasePosition = Number.isFinite(basePosition) && basePosition >= 0 ? basePosition : 0;
  const status = ['playing', 'paused', 'ended'].includes(snapshot.status) ? snapshot.status : 'paused';
  const updatedAtMs = Date.parse(snapshot.updatedAt ?? '');
  const elapsedSeconds = status === 'playing' && Number.isFinite(updatedAtMs)
    ? Math.max(0, (nowMs - updatedAtMs) / 1000)
    : 0;

  return {
    ...snapshot,
    position: safeBasePosition,
    basePosition: safeBasePosition,
    effectivePosition: safeBasePosition + elapsedSeconds,
    status,
    serverNow: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  setState:    (roomId, snapshot) => store.setState(roomId, snapshot),
  getState:    (roomId)          => store.getState(roomId),
  deleteState: (roomId)          => store.deleteState(roomId),
  buildPlaybackClock,
  StateStore,  // Export class for testing
};
