/**
 * LoadCommand.js — Host loads a new video URL
 * Validates URL, normalises YouTube links, updates state, broadcasts LOAD.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { setState } = require('../stateStore');
const { clearSkipVotes } = require('../queueService');
const { normaliseUrl } = require('../urlUtils');

class LoadCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host can load videos' };
    }
    const url = normaliseUrl(msg.url ?? '');
    if (!url) {
      return { valid: false, error: 'Invalid video URL' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const url = normaliseUrl(msg.url ?? '');
    await setState(this.roomId, { url, position: 0, status: 'paused' });
    await clearSkipVotes(this.roomId);
    this.broadcast({ type: 'LOAD', url });
    this.ctx.broadcastSkipStatus(0);
    this.emitEvent('playback:load', { url });
    console.log(`[sync] LOAD room=${this.roomId} user=${this.userId}`);
  }
}

module.exports = LoadCommand;
