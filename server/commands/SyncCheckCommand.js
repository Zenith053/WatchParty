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

    // Only host processes and acts on sync checks
    if (this.isAuthorised()) {
      console.log(
        `[sync] SYNC_CHECK from guest ${this.userId}: ` +
        `pos=${guestPos.toFixed(1)}s, expected=${guestExpected.toFixed(1)}s, ` +
        `drift=${guestDrift.toFixed(1)}s`
      );
    }
    // Guest just reports, no broadcast needed
  }
}

module.exports = SyncCheckCommand;
