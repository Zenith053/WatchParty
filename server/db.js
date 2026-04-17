/**
 * db.js — PostgreSQL connection pool (NFR-08: isolated module)
 * Uses pg Pool; connection string from DATABASE_URL env var.
 * Exports { pool, query, initDb }
 */
'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.WP_DATABASE_URL || 'postgresql://localhost:5432/watchparty',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

/**
 * Shorthand parameterised query.
 * @param {string} text  SQL with $1, $2 … placeholders
 * @param {any[]}  params
 */
async function query(text, params) {
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
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] Schema initialised');
}

module.exports = { pool, query, initDb };
