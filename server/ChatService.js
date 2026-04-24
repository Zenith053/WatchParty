/**
 * ChatService.js — Single owner of per-room chat history (FR-10)
 *
 * Extracted from ChatMsgCommand / ChatReactionCommand to eliminate
 * duplicated chat history management logic (Design Smell #3 + #5).
 *
 * Encapsulates the chatHistory Map with behavioral methods,
 * replacing direct Map manipulation in command classes.
 */
'use strict';

class ChatService {
  /** Maximum messages retained per room. */
  static MAX_HISTORY = 200;

  constructor() {
    /** @type {Map<string, object[]>} roomId → chat messages */
    this.history = new Map();
  }

  /**
   * Append a chat message or reaction to room history.
   * Automatically initialises the room array and caps at MAX_HISTORY.
   *
   * @param {string} roomId
   * @param {object} message  Chat message or reaction object
   */
  append(roomId, message) {
    if (!this.history.has(roomId)) {
      this.history.set(roomId, []);
    }
    const list = this.history.get(roomId);
    list.push(message);
    if (list.length > ChatService.MAX_HISTORY) {
      list.shift();
    }
  }

  /**
   * Get chat history for a room.
   * @param {string} roomId
   * @returns {object[]}  Array of chat messages (empty if no history)
   */
  getHistory(roomId) {
    return this.history.get(roomId) ?? [];
  }

  /**
   * Clear chat history for a room (called on room cleanup).
   * @param {string} roomId
   */
  clear(roomId) {
    this.history.delete(roomId);
  }

  /**
   * Reset all history (testing only).
   */
  reset() {
    this.history.clear();
  }
}

module.exports = ChatService;
