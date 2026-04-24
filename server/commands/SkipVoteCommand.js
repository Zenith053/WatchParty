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

    // Use ctx.getMemberCount() instead of raw Map access (Smell #6 fix)
    const totalMembers = this.ctx.getMemberCount();
    this.ctx.broadcastSkipStatus(result.count);

    // Check majority → auto-play next
    if (checkSkipMajority(result.count, totalMembers)) {
      await this.ctx.playNextFromQueue();
    }

    this.emitEvent('skip:vote', { count: result.count, totalMembers });
  }
}

module.exports = SkipVoteCommand;
