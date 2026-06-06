/**
 * SeekCommand.js — FR-02 Playback Sync (SEEK)
 * Host sends SEEK → server updates position (preserving current status) → broadcasts.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { setState, getState, buildPlaybackClock } = require('../stateStore');

class SeekCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host/co-host can control playback' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const position = parseFloat(msg.position ?? 0);
    const currentState = await getState(this.roomId);
    const status = ['playing', 'paused', 'ended'].includes(msg.status)
      ? msg.status
      : currentState?.status ?? 'paused';

    const snap = await setState(this.roomId, { position, status });
    this.broadcast({ type: 'SEEK', ...buildPlaybackClock(snap) });
    this.emitEvent('playback:seek', { position, status });
    console.log(`[sync] SEEK room=${this.roomId} user=${this.userId} position=${position} status=${status}`);
  }
}

module.exports = SeekCommand;
