/**
 * SyncRequestCommand.js - A room member requests the canonical playback clock.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { getState, buildPlaybackClock } = require('../stateStore');

class SyncRequestCommand extends BaseCommand {
  validate() {
    return { valid: true };
  }

  async execute() {
    const snap = await getState(this.roomId);
    const clock = buildPlaybackClock(snap ?? { position: 0, status: 'paused', updatedAt: new Date().toISOString() });

    this.send({
      type: 'SYNC_RESPONSE',
      source: 'server',
      requestedBy: this.userId,
      ...clock,
      position: clock.effectivePosition,
    });

    this.emitEvent('sync:request');
    console.log(
      `[sync] SYNC_REQUEST room=${this.roomId} user=${this.userId} ` +
      `position=${clock.effectivePosition} status=${clock.status}`
    );
  }
}

module.exports = SyncRequestCommand;
