/**
 * PlayCommand.js — FR-02 Playback Sync (PLAY)
 * Host sends PLAY → server updates state → broadcasts to all guests.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { setState } = require('../stateStore');

class PlayCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host/co-host can control playback' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const position = parseFloat(msg.position ?? 0);
    await setState(this.roomId, { position, status: 'playing' });
    this.broadcast({ type: 'PLAY', position });
    this.emitEvent('playback:play', { position });
    console.log(`[sync] PLAY room=${this.roomId} user=${this.userId} position=${position}`);
  }
}

module.exports = PlayCommand;
