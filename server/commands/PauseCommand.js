/**
 * PauseCommand.js — FR-02 Playback Sync (PAUSE)
 * Host sends PAUSE → server updates state → broadcasts to all guests.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { setState } = require('../stateStore');

class PauseCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host/co-host can control playback' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const position = parseFloat(msg.position ?? 0);
    await setState(this.roomId, { position, status: 'paused' });
    this.broadcast({ type: 'PAUSE', position });
    this.emitEvent('playback:pause', { position });
    console.log(`[sync] PAUSE room=${this.roomId} user=${this.userId} position=${position}`);
  }
}

module.exports = PauseCommand;
