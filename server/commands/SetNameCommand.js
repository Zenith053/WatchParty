/**
 * SetNameCommand.js — FR-08 Display Names (SET_NAME)
 * Guest can change display name mid-session.
 */
'use strict';

const BaseCommand = require('./BaseCommand');

class SetNameCommand extends BaseCommand {
  validate(msg) {
    const newName = (msg.displayName ?? '').trim().slice(0, 32);
    if (!newName) {
      return { valid: false, error: 'Display name cannot be empty' };
    }
    return { valid: true };
  }

  async execute(msg) {
    const newName = (msg.displayName ?? '').trim().slice(0, 32);
    const member = this.ctx.rooms.get(this.roomId)?.get(this.userId);

    if (member) {
      const oldName = member.displayName;
      member.displayName = newName;

      // Persist to DB
      try {
        const { query: dbQuery } = require('../db');
        await dbQuery(
          `UPDATE room_members SET display_name = $1 WHERE room_id = $2 AND user_id = $3`,
          [newName, this.roomId, this.userId]
        );
      } catch { /* DB unavailable */ }

      this.broadcastMemberList();

      // Notify everyone about the name change
      this.broadcast({
        type: 'CHAT_MSG',
        userId: 'system',
        displayName: 'System',
        text: `${oldName} is now known as ${newName}`,
        timestamp: new Date().toISOString(),
        isSystem: true,
      });

      this.emitEvent('room:set_name', { oldName, newName });
      console.log(`[sync] ${this.userId} changed name to "${newName}" in room ${this.roomId}`);
    }
  }
}

module.exports = SetNameCommand;
