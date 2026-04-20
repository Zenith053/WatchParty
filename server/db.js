/**
 * db.js — PostgreSQL connection pool (NFR-08: isolated module)
 * Uses pg Pool; connection string from WP_DATABASE_URL env var.
 * Falls back to in-memory store if PostgreSQL is unavailable.
 * Exports { pool, query, initDb }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DATABASE_URL = 'postgresql://127.0.0.1:5432/watchparty';

let pool = null;
let useMemory = false;
let memoryDb = null;

// Try to use PostgreSQL; fall back to in-memory if unavailable
try {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.WP_DATABASE_URL || DEFAULT_DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
  });
} catch (err) {
  console.warn('[db] pg module error, will use in-memory fallback:', err.message);
  useMemory = true;
  memoryDb = require('./memoryDb');
}

/**
 * Shorthand parameterised query.
 * @param {string} text  SQL with $1, $2 … placeholders
 * @param {any[]}  params
 */
async function query(text, params) {
  if (useMemory) {
    return memoryDb.query(text, params);
  }

  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.WP_NODE_ENV !== 'test') {
    console.debug(`[db] query took ${Date.now() - start}ms — ${text.slice(0, 60)}`);
  }
  return res;
}

/**
 * Run the schema DDL once at startup.
 * Idempotent (CREATE TABLE IF NOT EXISTS).
 */
async function initDb() {
  if (useMemory) {
    return memoryDb.initDb();
  }

  // Try PostgreSQL; if it fails, switch to in-memory
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[db] Schema initialised (PostgreSQL)');
  } catch (err) {
    console.warn('[db] PostgreSQL unavailable, switching to in-memory mode:', err.message);
    useMemory = true;
    memoryDb = require('./memoryDb');
    await memoryDb.initDb();
  }
}

module.exports = { pool, query, initDb };
