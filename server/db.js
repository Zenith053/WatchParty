/**
 * db.js — Database access layer using Strategy Pattern (NFR-08: isolated module)
 *
 * Design Pattern: Strategy
 *   - DatabaseStrategy interface defines the contract (query, initDb)
 *   - PostgresStrategy uses pg Pool for production
 *   - MemoryStrategy (memoryDb.js) provides in-memory fallback for dev/demo
 *   - Strategy is selected once at startup, not checked on every call
 *
 * Exports { pool, query, initDb } for backward compatibility.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DatabaseStrategy = require('./DatabaseStrategy');

const DEFAULT_DATABASE_URL = 'postgresql://127.0.0.1:5432/watchparty';

// ── PostgresStrategy ──────────────────────────────────────────────────────

class PostgresStrategy extends DatabaseStrategy {
  constructor(connectionString) {
    super();
    const { Pool } = require('pg');
    this._pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this._pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err.message);
    });
  }

  get pool() {
    return this._pool;
  }

  async query(text, params = []) {
    const start = Date.now();
    const res = await this._pool.query(text, params);
    if (process.env.WP_NODE_ENV !== 'test') {
      console.debug(`[db] query took ${Date.now() - start}ms — ${text.slice(0, 60)}`);
    }
    return res;
  }

  async initDb() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await this._pool.query(sql);
    console.log('[db] Schema initialised (PostgreSQL)');
  }
}

// ── Strategy Selection (decided once at startup) ──────────────────────────

let strategy;

try {
  strategy = new PostgresStrategy(process.env.WP_DATABASE_URL || DEFAULT_DATABASE_URL);
} catch (err) {
  console.warn('[db] pg module error, will use in-memory fallback:', err.message);
  // MemoryStrategy is loaded from memoryDb.js which implements DatabaseStrategy
  strategy = require('./memoryDb');

}

// ── Exported interface (backward-compatible) ──────────────────────────────

async function query(text, params) {
  return strategy.query(text, params);
}

async function initDb() {
  try {
    await strategy.initDb();
  } catch (err) {
    console.warn('[db] PostgreSQL unavailable, switching to in-memory mode:', err.message);
    strategy = require('./memoryDb');
    await strategy.initDb();
  }
  return undefined;
}

function _resetMemoryDb() {
  if (strategy._resetMemoryDb) strategy._resetMemoryDb();
}

module.exports = { pool: strategy.pool, query, initDb, _resetMemoryDb };
