/**
 * stateStore.js — Two-layer playback state store (NFR-03)
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

// In-memory layer (always available)
const memStore = new Map(); // roomId → snapshot object

// Redis layer (optional)
let redis = null;
let redisAvailable = false;

try {
  const Redis = require('ioredis');
  redis = new Redis(process.env.WP_REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 2) {
        console.warn('[stateStore] Redis unavailable — running memory-only mode');
        redisAvailable = false;
        return null; // stop retrying
      }
      return Math.min(times * 200, 1000);
    },
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });

  redis.on('connect', () => {
    redisAvailable = true;
    console.log('[stateStore] Redis connected');
  });

  redis.on('error', (err) => {
    if (redisAvailable) {
      console.warn('[stateStore] Redis error (falling back to memory):', err.message);
    }
    redisAvailable = false;
  });

  redis.on('close', () => {
    redisAvailable = false;
  });

  // Attempt connection but don't block startup
  redis.connect().catch(() => {
    console.warn('[stateStore] Redis not available — using memory-only mode');
    redisAvailable = false;
  });
} catch {
  console.warn('[stateStore] ioredis not available — using memory-only mode');
}

const REDIS_KEY = (roomId) => `room:${roomId}:state`;
const REDIS_TTL = 86_400; // 24 h — mirrors NFR-06 token expiry

/**
 * Write snapshot to both layers.
 * @param {string} roomId
 * @param {object} snapshot  Partial or full snapshot; merged with existing.
 */
async function setState(roomId, snapshot) {
  const existing = memStore.get(roomId) ?? {};
  const next = { ...existing, ...snapshot, updatedAt: new Date().toISOString() };
  memStore.set(roomId, next);

  if (redisAvailable && redis) {
    try {
      await redis.hset(REDIS_KEY(roomId), next);
      await redis.expire(REDIS_KEY(roomId), REDIS_TTL);
    } catch {
      // Redis unavailable — memory-only is degraded but functional
    }
  }
}

/**
 * Read snapshot — memory first, Redis fallback.
 * @param {string} roomId
 * @returns {object|null}
 */
async function getState(roomId) {
  const mem = memStore.get(roomId);
  if (mem) return mem;

  if (redisAvailable && redis) {
    try {
      const raw = await redis.hgetall(REDIS_KEY(roomId));
      if (raw && raw.url) {
        // Rehydrate memory from Redis
        const snap = {
          url: raw.url,
          position: parseFloat(raw.position ?? 0),
          status: raw.status ?? 'paused',
          updatedAt: raw.updatedAt,
        };
        memStore.set(roomId, snap);
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
async function deleteState(roomId) {
  memStore.delete(roomId);
  if (redisAvailable && redis) {
    try {
      await redis.del(REDIS_KEY(roomId));
    } catch {
      // ignore
    }
  }
}

module.exports = { setState, getState, deleteState };
