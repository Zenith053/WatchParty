/**
 * eventBus.js — Observer / Pub-Sub Pattern (Design Pattern #3 from Architecture)
 *
 * Provides a room-scoped event emitter that decouples event production
 * (commands, services) from consumption (broadcasting, logging, analytics).
 *
 * Usage:
 *   eventBus.emitRoom(roomId, 'playback:play', { position, userId });
 *   eventBus.on('playback:play', ({ roomId, ...data }) => { ... });
 */
'use strict';

const EventEmitter = require('events');

class RoomEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // rooms × event types
  }

  /**
   * Emit a room-scoped event.
   * Fires both `room:<roomId>:<event>` (for per-room listeners)
   * and `<event>` (for global listeners like logging/analytics).
   *
   * @param {string} roomId
   * @param {string} event   e.g. 'playback:play', 'queue:add', 'chat:message'
   * @param {object} data    Event payload
   */
  emitRoom(roomId, event, data = {}) {
    const payload = { roomId, ...data, timestamp: new Date().toISOString() };
    this.emit(`room:${roomId}:${event}`, payload);
    this.emit(event, payload);
  }

  /**
   * Subscribe to a room-scoped event.
   * @param {string} roomId
   * @param {string} event
   * @param {Function} handler
   */
  onRoom(roomId, event, handler) {
    this.on(`room:${roomId}:${event}`, handler);
    return this; // chainable
  }

  /**
   * Remove all listeners for a specific room (cleanup on room destroy).
   * @param {string} roomId
   */
  teardownRoom(roomId) {
    this.eventNames()
      .filter(name => typeof name === 'string' && name.startsWith(`room:${roomId}:`))
      .forEach(name => this.removeAllListeners(name));
  }
}

// Singleton instance — shared across the application
const eventBus = new RoomEventBus();

module.exports = { eventBus, RoomEventBus };
