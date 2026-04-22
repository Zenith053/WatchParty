/**
 * SkipVoteCommand.js — FR-06 Skip Vote (SKIP_VOTE)
 * Any member can vote to skip; majority triggers auto-play next from queue.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { voteSkip, checkSkipMajority } = require('../queueService');

class SkipVoteCommand extends BaseCommand {
  async execute(msg) {
    const result = await voteSkip(this.roomId, this.userId);
    if (!result.success) {
      this.send({ type: 'ERROR', message: result.error });
      return;
    }

    const totalMembers = this.ctx.rooms.get(this.roomId)?.size ?? 0;
    this.ctx.broadcastSkipStatus(result.count);

    // Check majority → auto-play next
    if (checkSkipMajority(result.count, totalMembers)) {
      await this.ctx.playNextFromQueue();
    }

    this.emitEvent('skip:vote', { count: result.count, totalMembers });
  }
}

module.exports = SkipVoteCommand;
