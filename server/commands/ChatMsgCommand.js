/**
 * ChatMsgCommand.js — FR-10 Live Chat (CHAT_MSG)
 * Any room member can send a text message.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

class ChatMsgCommand extends BaseCommand {
  validate(msg) {
    const text = (msg.text ?? '').trim().slice(0, 500);
    if (!text) {
      return { valid: false, error: 'Chat message cannot be empty' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const text = (msg.text ?? '').trim().slice(0, 500);
    const member = this.ctx.getMember(this.userId);

    const chatMsg = {
      type: 'CHAT_MSG',
      userId: this.userId,
      displayName: member?.displayName ?? 'Guest',
      text,
      timestamp: new Date().toISOString(),
    };

    // Store in history (delegated to ChatService — Smell #3 fix)
    this.ctx.chatService.append(this.roomId, chatMsg);

    // Broadcast to all room members
    this.broadcast(chatMsg);
    this.emitEvent('chat:message', { text });
  }
}

module.exports = ChatMsgCommand;
