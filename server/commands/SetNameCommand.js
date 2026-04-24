/**
 * SetNameCommand.js — FR-08 Display Names (SET_NAME)
 * Guest can change display name mid-session.
 */
'use strict';

const BaseCommand = require('./BaseCommand');
const { query } = require('../db');

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
    const member = this.ctx.getMember(this.userId);

    if (member) {
      const oldName = member.displayName;
      // Use RoomMember.rename() instead of direct mutation (Smell #9 fix)
      member.rename(newName);

      // Persist to DB (module-level import — Smell #7 fix)
      try {
        await query(
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
