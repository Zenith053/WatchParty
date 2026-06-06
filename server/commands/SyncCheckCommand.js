/**
 * SyncCheckCommand.js — Guest drift verification (SYNC_CHECK)
 * Guest reports drift; host can verify and correct.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

class SyncCheckCommand extends BaseCommand {
  async execute(msg) {
    const guestPos = parseFloat(msg.position ?? 0);
    const guestExpected = parseFloat(msg.expected ?? 0);
    const guestDrift = parseFloat(msg.drift ?? 0);
    const guestStatus = ['playing', 'paused', 'ended'].includes(msg.status)
      ? msg.status
      : 'unknown';

    if (this.isAuthorised()) {
      console.log(
        `[sync] SYNC_CHECK from host ${this.userId}: ` +
        `pos=${guestPos.toFixed(1)}s, expected=${guestExpected.toFixed(1)}s, ` +
        `drift=${guestDrift.toFixed(1)}s status=${guestStatus}`
      );
      return;
    }

    const members = this.ctx.roomManager.getMembers(this.roomId);
    if (!members) return;

    const syncCheck = {
      type: 'SYNC_CHECK',
      userId: this.userId,
      position: guestPos,
      expected: guestExpected,
      drift: guestDrift,
      status: guestStatus,
    };

    for (const member of members.values()) {
      if (member.isHost()) {
        this.ctx.roomManager.send(member.ws, syncCheck);
      }
    }

    console.log(
      `[sync] SYNC_CHECK from guest ${this.userId}: ` +
      `pos=${guestPos.toFixed(1)}s, expected=${guestExpected.toFixed(1)}s, ` +
      `drift=${guestDrift.toFixed(1)}s status=${guestStatus}`
    );
  }
}

module.exports = SyncCheckCommand;
