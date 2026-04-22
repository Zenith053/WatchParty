/**
 * ChatReactionCommand.js — FR-10 Live Chat (CHAT_REACTION)
 * Any room member can send an emoji reaction.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

const MAX_CHAT_HISTORY = 200;

class ChatReactionCommand extends BaseCommand {
  validate(msg) {
    const emoji = (msg.emoji ?? '').trim().slice(0, 8);
    if (!emoji) {
      return { valid: false, error: 'Emoji is required' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const emoji = (msg.emoji ?? '').trim().slice(0, 8);
    const member = this.ctx.rooms.get(this.roomId)?.get(this.userId);

    const reactionMsg = {
      type: 'CHAT_REACTION',
      userId: this.userId,
      displayName: member?.displayName ?? 'Guest',
      emoji,
      timestamp: new Date().toISOString(),
    };

    // Store in history
    if (!this.ctx.chatHistory.has(this.roomId)) {
      this.ctx.chatHistory.set(this.roomId, []);
    }
    const history = this.ctx.chatHistory.get(this.roomId);
    history.push(reactionMsg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Broadcast to all
    this.broadcast(reactionMsg);
    this.emitEvent('chat:reaction', { emoji });
  }
}

module.exports = ChatReactionCommand;
