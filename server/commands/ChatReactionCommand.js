/**
 * ChatReactionCommand.js — FR-10 Live Chat (CHAT_REACTION)
 * Any room member can send an emoji reaction.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

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
    const member = this.ctx.getMember(this.userId);

    const reactionMsg = {
      type: 'CHAT_REACTION',
      userId: this.userId,
      displayName: member?.displayName ?? 'Guest',
      emoji,
      timestamp: new Date().toISOString(),
    };

    // Store in history (delegated to ChatService — Smell #3 fix)
    this.ctx.chatService.append(this.roomId, reactionMsg);

    // Broadcast to all
    this.broadcast(reactionMsg);
    this.emitEvent('chat:reaction', { emoji });
  }
}

module.exports = ChatReactionCommand;
