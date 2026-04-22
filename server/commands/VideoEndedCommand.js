/**
 * VideoEndedCommand.js — FR-05 Auto-play next from queue
 * Client signals video finished; host triggers next queue entry.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

class VideoEndedCommand extends BaseCommand {
  async execute(msg) {
    // Only process from host to avoid duplicates
    if (this.isAuthorised()) {
      await this.ctx.playNextFromQueue();
      this.emitEvent('playback:ended');
    }
  }
}

module.exports = VideoEndedCommand;
