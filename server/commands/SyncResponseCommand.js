/**
 * SyncResponseCommand.js - Legacy host response path.
 * The server ignores host-supplied time and replies with the canonical room clock.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { getState, buildPlaybackClock } = require('../stateStore');

class SyncResponseCommand extends BaseCommand {
  validate(msg) {
    if (!this.isAuthorised()) {
      return { valid: false, error: 'Only host/co-host can respond to sync requests' };
    }

    if (typeof msg.requestedBy !== 'string' || msg.requestedBy.trim() === '') {
      return { valid: false, error: 'Missing sync request target' };
    }

    return { valid: true };
  }

  async execute(msg) {
    const requestedBy = msg.requestedBy.trim();
    const snap = await getState(this.roomId);
    const clock = buildPlaybackClock(snap ?? { position: 0, status: 'paused', updatedAt: new Date().toISOString() });

    this.ctx.roomManager.sendToMember(this.roomId, requestedBy, {
      type: 'SYNC_RESPONSE',
      source: 'server',
      requestedBy,
      ...clock,
      position: clock.effectivePosition,
    });

    this.emitEvent('sync:response', {
      requestedBy,
      position: clock.effectivePosition,
      status: clock.status,
    });
    console.log(
      `[sync] SYNC_RESPONSE room=${this.roomId} host=${this.userId} ` +
      `guest=${requestedBy} position=${clock.effectivePosition} status=${clock.status}`
    );
  }
}

module.exports = SyncResponseCommand;
