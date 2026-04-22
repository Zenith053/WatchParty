/**
 * QueueUpvoteCommand.js — FR-05 Vote-to-Watch Queue (QUEUE_UPVOTE)
 * Any member can upvote a queue entry (1 vote per user).
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { upvoteQueue } = require('../queueService');

class QueueUpvoteCommand extends BaseCommand {
  validate(msg) {
    const queueId = parseInt(msg.queueId, 10);
    if (!queueId) {
      return { valid: false, error: 'Invalid queueId' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const queueId = parseInt(msg.queueId, 10);
    const result = await upvoteQueue(queueId, this.userId);
    if (!result.success) {
      this.send({ type: 'ERROR', message: result.error });
      return;
    }
    await this.ctx.broadcastQueue();
    this.emitEvent('queue:upvote', { queueId });
  }
}

module.exports = QueueUpvoteCommand;
