/**
 * QueueRemoveCommand.js — FR-05 Vote-to-Watch Queue (QUEUE_REMOVE)
 * Host-only: remove a specific entry from the queue.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { removeFromQueue } = require('../queueService');

class QueueRemoveCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host can remove queue entries' };
    }
    const queueId = parseInt(msg.queueId, 10);
    if (!queueId) {
      return { valid: false, error: 'Invalid queueId' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const queueId = parseInt(msg.queueId, 10);
    await removeFromQueue(queueId);
    await this.ctx.broadcastQueue();
    this.emitEvent('queue:remove', { queueId });
  }
}

module.exports = QueueRemoveCommand;
