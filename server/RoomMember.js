/**
 * RoomMember.js — Value class for room member state (Design Smell #9)
 *
 * Replaces plain object literals ({ ws, userId, role, displayName, joinedAt })
 * with a proper domain model that enforces invariants and encapsulates mutations.
 *
 * Previously, member objects were built as ad-hoc literals in syncService.js
 * and mutated directly across 5+ files with no validation.
 */
'use strict';

class RoomMember {
  /**
   * @param {object} opts
   * @param {WebSocket} opts.ws         WebSocket connection
   * @param {string}    opts.userId     Unique user identifier
   * @param {string}   [opts.role]      'host' | 'co-host' | 'guest'
   * @param {string}   [opts.displayName]  Display name (max 32 chars)
   */
  constructor({ ws, userId, role = 'guest', displayName = 'Guest' }) {
    this.ws = ws;
    this.userId = userId;
    this.role = role;
    this.displayName = displayName.slice(0, 32);
    this.joinedAt = Date.now();
  }

  /**
   * Check if this member has host or co-host privileges.
   * @returns {boolean}
   */
  isHost() {
    return this.role === 'host' || this.role === 'co-host';
  }

  /**
   * Promote this member to a new role.
   * @param {string} role  'host' | 'co-host' | 'guest'
   */
  promote(role) {
    this.role = role;
  }

  /**
   * Change this member's display name.
   * @param {string} name  New display name (truncated to 32 chars)
   */
  rename(name) {
    this.displayName = name.slice(0, 32);
  }

  /**
   * Serialise for MEMBER_LIST broadcast (excludes ws and joinedAt).
   * @returns {{ userId: string, displayName: string, role: string }}
   */
  toJSON() {
    return {
      userId: this.userId,
      displayName: this.displayName,
      role: this.role,
    };
  }
}

module.exports = RoomMember;
