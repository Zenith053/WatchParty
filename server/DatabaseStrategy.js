/**
 * DatabaseStrategy.js — Strategy Pattern interface for database access
 *
 * Defines the contract that both PostgresStrategy (db.js) and
 * MemoryStrategy (memoryDb.js) must satisfy.
 *
 * This replaces the runtime boolean flag (useMemory) with a proper
 * Strategy selection at startup.
 */
'use strict';

class DatabaseStrategy {
  /**
   * Execute a parameterised SQL query.
   * @param {string} text   SQL with $1, $2 … placeholders
   * @param {any[]}  params
   * @returns {Promise<{ rows: any[], rowCount?: number }>}
   * @abstract
   */
  async query(text, params = []) {
    throw new Error(`${this.constructor.name}.query() not implemented`);
  }

  /**
   * Initialise the database schema (idempotent).
   * @returns {Promise<void>}
   * @abstract
   */
  async initDb() {
    throw new Error(`${this.constructor.name}.initDb() not implemented`);
  }

  /**
   * Return the underlying connection pool (or null for in-memory).
   * @returns {object|null}
   */
  get pool() {
    return null;
  }
}

module.exports = DatabaseStrategy;
