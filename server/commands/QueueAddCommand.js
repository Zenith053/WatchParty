/**
 * QueueAddCommand.js — FR-05 Vote-to-Watch Queue (QUEUE_ADD)
 * Any member can nominate a video URL to the room queue.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { addToQueue } = require('../queueService');

class QueueAddCommand extends BaseCommand {
  validate(msg) {
    const rawUrl = (msg.url ?? '').trim();
    if (!rawUrl) {
      return { valid: false, error: 'URL is required' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const rawUrl = (msg.url ?? '').trim();
    await addToQueue(this.roomId, rawUrl, this.userId);
    await this.ctx.broadcastQueue();
    this.emitEvent('queue:add', { url: rawUrl });
  }
}

module.exports = QueueAddCommand;
