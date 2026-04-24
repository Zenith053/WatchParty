/**
 * RoomManager.js — Extracted from syncService.js God Class (Design Smells #1 + #6)
 *
 * Single owner of the per-room member registry (rooms Map).
 * Encapsulates member lifecycle, communication helpers, and room cleanup.
 *
 * Previously, these responsibilities were scattered across syncService.js
 * (the Mediator), and commands accessed raw Maps via ctx.rooms.
 *
 * Now independently testable without WebSocket mocking.
 */
'use strict';

const RoomMember = require('./RoomMember');

class RoomManager {
  constructor() {
    /** @type {Map<string, Map<string, RoomMember>>} roomId → Map<userId, RoomMember> */
    this.rooms = new Map();
  }

  // ── Member Lifecycle ──────────────────────────────────────────────────

  /**
   * Add a member to a room. Creates the room Map if it doesn't exist.
   * @param {string} roomId
   * @param {RoomMember} member  A RoomMember instance
   */
  addMember(roomId, member) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
    }
    this.rooms.get(roomId).set(member.userId, member);
  }

  /**
   * Remove a member from a room.
   * @param {string} roomId
   * @param {string} userId
   * @returns {RoomMember|undefined}  The departed member, or undefined
   */
  removeMember(roomId, userId) {
    const members = this.rooms.get(roomId);
    if (!members) return undefined;
    const member = members.get(userId);
    members.delete(userId);
    return member;
  }

  /**
   * Get a single member.
   * @param {string} roomId
   * @param {string} userId
   * @returns {RoomMember|undefined}
   */
  getMember(roomId, userId) {
    return this.rooms.get(roomId)?.get(userId);
  }

  /**
   * Get the inner Map of members for a room.
   * @param {string} roomId
   * @returns {Map<string, RoomMember>|undefined}
   */
  getMembers(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Get member count for a room.
   * @param {string} roomId
   * @returns {number}
   */
  getMemberCount(roomId) {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /**
   * Update a member's role.
   * @param {string} roomId
   * @param {string} userId
   * @param {string} role  'host' | 'co-host' | 'guest'
   */
  setRole(roomId, userId, role) {
    const member = this.getMember(roomId, userId);
    if (member) member.promote(role);
  }

  // ── Communication ─────────────────────────────────────────────────────

  /**
   * Safe JSON send to a single WebSocket.
   * @param {WebSocket} ws
   * @param {object} obj  Message to send
   */
  send(ws, obj) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(obj));
    }
  }

  /**
   * Broadcast a message to all room members, optionally excluding one.
   * @param {string} roomId
   * @param {object} obj  Message to broadcast
   * @param {string|null} [excludeUserId]  UserId to exclude
   */
  broadcast(roomId, obj, excludeUserId = null) {
    const members = this.rooms.get(roomId);
    if (!members) return;
    for (const [uid, member] of members) {
      if (uid !== excludeUserId) this.send(member.ws, obj);
    }
  }

  /**
   * Broadcast the current member list (MEMBER_LIST) to all room members.
   * Uses RoomMember.toJSON() for serialisation.
   * @param {string} roomId
   */
  broadcastMemberList(roomId) {
    const members = this.rooms.get(roomId);
    if (!members) return;
    const list = [...members.values()].map(m => m.toJSON());
    this.broadcast(roomId, { type: 'MEMBER_LIST', members: list });
  }

  /**
   * Send a message to a specific member in a room.
   * @param {string} roomId
   * @param {string} userId
   * @param {object} obj  Message to send
   */
  sendToMember(roomId, userId, obj) {
    const member = this.getMember(roomId, userId);
    if (member) this.send(member.ws, obj);
  }

  // ── Room Lifecycle ────────────────────────────────────────────────────

  /**
   * Check if a room exists in the registry.
   * @param {string} roomId
   * @returns {boolean}
   */
  hasRoom(roomId) {
    return this.rooms.has(roomId);
  }

  /**
   * Check if a room is empty (no members).
   * @param {string} roomId
   * @returns {boolean}
   */
  isEmpty(roomId) {
    return this.getMemberCount(roomId) === 0;
  }

  /**
   * Delete a room from the registry entirely.
   * @param {string} roomId
   */
  deleteRoom(roomId) {
    this.rooms.delete(roomId);
  }

  /**
   * Reset all rooms (testing only).
   */
  reset() {
    this.rooms.clear();
  }
}

module.exports = RoomManager;
