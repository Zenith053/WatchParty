/**
 * LoadCommand.js — Host loads a new video URL
 * Validates URL, normalises YouTube links, updates state, broadcasts LOAD.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { setState } = require('../stateStore');
const { clearSkipVotes } = require('../queueService');

class LoadCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host can load videos' };
    }
    const url = this._normaliseUrl(msg.url ?? '');
    if (!url) {
      return { valid: false, error: 'Invalid video URL' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const url = this._normaliseUrl(msg.url ?? '');
    await setState(this.roomId, { url, position: 0, status: 'paused' });
    await clearSkipVotes(this.roomId);
    this.broadcast({ type: 'LOAD', url });
    this.ctx.broadcastSkipStatus(0);
    this.emitEvent('playback:load', { url });
    console.log(`[sync] LOAD room=${this.roomId} user=${this.userId}`);
  }

  /**
   * Normalise a raw URL to a YouTube nocookie embed URL.
   * @param {string} raw
   * @returns {string|null}
   */
  _normaliseUrl(raw) {
    try {
      const url = new URL(raw);
      let videoId = url.searchParams.get('v');
      if (!videoId && url.hostname === 'youtu.be') {
        videoId = url.pathname.slice(1);
      }
      if (videoId) {
        return `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&rel=0`;
      }
      return raw;
    } catch {
      return null;
    }
  }
}

module.exports = LoadCommand;
