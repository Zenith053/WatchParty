/**
 * stateStore.js — Two-layer playback state store (NFR-03)
 *
 * Layer 1: In-memory Map  (µs reads, lives with process)
 * Layer 2: Redis hash      (persistence across restarts / crashes)
 *
 * Snapshot shape: { url, position, status, updatedAt }
 *   url       – current video URL (normalised embed)
 *   position  – playback position in seconds (float)
 *   status    – 'playing' | 'paused' | 'ended'
 *   updatedAt – ISO timestamp of last write
 */
'use strict';

const Redis = require('ioredis');

const redis = new Redis(process.env.WP_REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  console.error('[stateStore] Redis error (falling back to memory):', err.message);
});

// In-memory layer
const memStore = new Map(); // roomId → snapshot object

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

  try {
    await redis.hset(REDIS_KEY(roomId), next);
    await redis.expire(REDIS_KEY(roomId), REDIS_TTL);
  } catch {
    // Redis unavailable — memory-only is degraded but functional
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
  return null;
}

/**
 * Remove state for a room (called when room is deleted / expired).
 */
async function deleteState(roomId) {
  memStore.delete(roomId);
  try {
    await redis.del(REDIS_KEY(roomId));
  } catch {
    // ignore
  }
}

module.exports = { setState, getState, deleteState };
