/**
 * GrantCohostCommand.js — FR-04 Host/Guest Roles
 * Host grants co-host rights to a guest.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

class GrantCohostCommand extends BaseCommand {
  validate(msg) {
    if (this.userRole !== 'host') {
      return { valid: false, error: 'Only host can grant co-host' };
    }
    if (!msg.targetUserId) {
      return { valid: false, error: 'targetUserId is required' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const members = this.ctx.rooms.get(this.roomId);
    const target = members?.get(msg.targetUserId);
    if (!target) {
      this.send({ type: 'ERROR', message: 'Target user not in room' });
      return;
    }

    target.role = 'co-host';

    // Notify the promoted user directly
    if (target.ws.readyState === 1) {
      target.ws.send(JSON.stringify({
        type: 'HOST_PROMOTED', role: 'co-host', userId: msg.targetUserId,
      }));
    }

    this.broadcastMemberList();
    this.emitEvent('room:grant_cohost', { targetUserId: msg.targetUserId });
  }
}

module.exports = GrantCohostCommand;
