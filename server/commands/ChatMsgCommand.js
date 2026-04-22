/**
 * ChatMsgCommand.js — FR-10 Live Chat (CHAT_MSG)
 * Any room member can send a text message.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

const MAX_CHAT_HISTORY = 200;

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
    const member = this.ctx.rooms.get(this.roomId)?.get(this.userId);

    const chatMsg = {
      type: 'CHAT_MSG',
      userId: this.userId,
      displayName: member?.displayName ?? 'Guest',
      text,
      timestamp: new Date().toISOString(),
    };

    // Store in history
    if (!this.ctx.chatHistory.has(this.roomId)) {
      this.ctx.chatHistory.set(this.roomId, []);
    }
    const history = this.ctx.chatHistory.get(this.roomId);
    history.push(chatMsg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Broadcast to all room members
    this.broadcast(chatMsg);
    this.emitEvent('chat:message', { text });
  }
}

module.exports = ChatMsgCommand;
