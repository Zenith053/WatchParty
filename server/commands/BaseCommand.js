/**
 * BaseCommand.js — Command Pattern base class (Design Pattern #3 from Architecture)
 *
 * All WebSocket message handlers extend this class.
 * Each command encapsulates validation and execution logic for one message type.
 *
 * Architecture reference: "Command: Play/Pause/Seek are discrete objects — easy
 * to validate, log, and replay for late-join catch-up."
 *
 * @abstract
 */
'use strict';

class BaseCommand {
  /**
   * @param {object} context  Per-message execution context
   * @param {string}      context.roomId
   * @param {string}      context.userId
   * @param {string}      context.userRole
   * @param {WebSocket}   context.ws
   * @param {RoomManager} context.roomManager   Room member registry
   * @param {ChatService} context.chatService   Chat history store
   * @param {object}      context.eventBus      RoomEventBus singleton
   * @param {Function}    context.getMember      getMember(userId?) → RoomMember
   * @param {Function}    context.getMemberCount getMemberCount() → number
   * @param {Function}    context.send           send(obj) → send to this client
   * @param {Function}    context.broadcast      broadcast(obj, excludeUserId?) → send to room
   * @param {Function}    context.broadcastMemberList → refresh member list for room
   */
  constructor(context) {
    this.ctx = context;
  }

  // ── Convenience accessors ──────────────────────────────────────────────

  get roomId()   { return this.ctx.roomId; }
  get userId()   { return this.ctx.userId; }
  get userRole() { return this.ctx.userRole; }

  /** Check if the current user has host/co-host privileges. */
  isAuthorised() {
    return this.userRole === 'host' || this.userRole === 'co-host';
  }

  /** Send a message to the current client only. */
  send(obj) {
    this.ctx.send(obj);
  }

  /** Broadcast a message to all room members (optionally excluding one). */
  broadcast(obj, excludeUserId = null) {
    this.ctx.broadcast(obj, excludeUserId);
  }

  /** Refresh the member list for all room members. */
  broadcastMemberList() {
    this.ctx.broadcastMemberList();
  }

  /** Emit a room-scoped event on the event bus. */
  emitEvent(event, data = {}) {
    this.ctx.eventBus?.emitRoom(this.roomId, event, {
      userId: this.userId,
      userRole: this.userRole,
      ...data,
    });
  }

  // ── Abstract methods (override in subclasses) ──────────────────────────

  /**
   * Validate the incoming message before execution.
   * @param {object} msg  The parsed WebSocket message
   * @returns {{ valid: boolean, error?: string }}
   */
  validate(msg) {
    return { valid: true };
  }

  /**
   * Execute the command logic.
   * @param {object} msg  The parsed WebSocket message
   * @returns {Promise<void>}
   * @abstract
   */
  async execute(msg) {
    throw new Error(`${this.constructor.name}.execute() not implemented`);
  }
}

module.exports = BaseCommand;
