/**
 * tests/roomManager.test.js
 * Unit tests for the extracted RoomManager class (Design Smells #1 + #6 fix)
 * Tests RoomManager independently without WebSocket mocking.
 */
'use strict';

const RoomManager = require('../server/RoomManager');
const RoomMember = require('../server/RoomMember');

// Minimal WebSocket mock — just needs readyState and send()
function mockWs() {
  return {
    readyState: 1, // OPEN
    send: jest.fn(),
  };
}

describe('RoomManager', () => {
  let rm;

  beforeEach(() => {
    rm = new RoomManager();
  });

  // ── Member Lifecycle ──────────────────────────────────────────────────

  describe('addMember / getMember', () => {
    test('adds a member and retrieves it', () => {
      const member = new RoomMember({ ws: mockWs(), userId: 'u1', role: 'host', displayName: 'Alice' });
      rm.addMember('room-1', member);
      expect(rm.getMember('room-1', 'u1')).toBe(member);
    });

    test('creates room Map on first addMember', () => {
      expect(rm.hasRoom('room-1')).toBe(false);
      const member = new RoomMember({ ws: mockWs(), userId: 'u1' });
      rm.addMember('room-1', member);
      expect(rm.hasRoom('room-1')).toBe(true);
    });
  });

  describe('removeMember', () => {
    test('removes a member and returns it', () => {
      const member = new RoomMember({ ws: mockWs(), userId: 'u1' });
      rm.addMember('room-1', member);
      const departed = rm.removeMember('room-1', 'u1');
      expect(departed).toBe(member);
      expect(rm.getMember('room-1', 'u1')).toBeUndefined();
    });

    test('returns undefined for non-existent member', () => {
      expect(rm.removeMember('room-1', 'u999')).toBeUndefined();
    });

    test('returns undefined for non-existent room', () => {
      expect(rm.removeMember('room-999', 'u1')).toBeUndefined();
    });
  });

  describe('getMemberCount', () => {
    test('returns correct count', () => {
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u1' }));
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u2' }));
      expect(rm.getMemberCount('room-1')).toBe(2);
    });

    test('returns 0 for non-existent room', () => {
      expect(rm.getMemberCount('room-999')).toBe(0);
    });
  });

  describe('getMembers', () => {
    test('returns the inner Map', () => {
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u1' }));
      const members = rm.getMembers('room-1');
      expect(members).toBeInstanceOf(Map);
      expect(members.size).toBe(1);
    });

    test('returns undefined for non-existent room', () => {
      expect(rm.getMembers('room-999')).toBeUndefined();
    });
  });

  describe('setRole', () => {
    test('updates member role via RoomMember.promote()', () => {
      const member = new RoomMember({ ws: mockWs(), userId: 'u1', role: 'guest' });
      rm.addMember('room-1', member);
      rm.setRole('room-1', 'u1', 'co-host');
      expect(rm.getMember('room-1', 'u1').role).toBe('co-host');
    });

    test('no-op for non-existent member', () => {
      expect(() => rm.setRole('room-1', 'u999', 'host')).not.toThrow();
    });
  });

  // ── Communication ─────────────────────────────────────────────────────

  describe('send', () => {
    test('sends JSON to open WebSocket', () => {
      const ws = mockWs();
      rm.send(ws, { type: 'HELLO' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'HELLO' }));
    });

    test('does not send to closed WebSocket', () => {
      const ws = mockWs();
      ws.readyState = 3; // CLOSED
      rm.send(ws, { type: 'HELLO' });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    test('sends to all room members', () => {
      const ws1 = mockWs(), ws2 = mockWs();
      rm.addMember('room-1', new RoomMember({ ws: ws1, userId: 'u1' }));
      rm.addMember('room-1', new RoomMember({ ws: ws2, userId: 'u2' }));
      rm.broadcast('room-1', { type: 'TEST' });
      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST' }));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST' }));
    });

    test('excludes specified userId', () => {
      const ws1 = mockWs(), ws2 = mockWs();
      rm.addMember('room-1', new RoomMember({ ws: ws1, userId: 'u1' }));
      rm.addMember('room-1', new RoomMember({ ws: ws2, userId: 'u2' }));
      rm.broadcast('room-1', { type: 'TEST' }, 'u1');
      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
    });

    test('no-op for non-existent room', () => {
      expect(() => rm.broadcast('room-999', { type: 'TEST' })).not.toThrow();
    });
  });

  describe('broadcastMemberList', () => {
    test('broadcasts MEMBER_LIST with toJSON() serialisation', () => {
      const ws1 = mockWs(), ws2 = mockWs();
      rm.addMember('room-1', new RoomMember({ ws: ws1, userId: 'u1', role: 'host', displayName: 'Alice' }));
      rm.addMember('room-1', new RoomMember({ ws: ws2, userId: 'u2', role: 'guest', displayName: 'Bob' }));
      rm.broadcastMemberList('room-1');

      const sent = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(sent.type).toBe('MEMBER_LIST');
      expect(sent.members).toHaveLength(2);
      // RoomMember.toJSON() should NOT include ws or joinedAt
      expect(sent.members[0]).toEqual(expect.objectContaining({
        userId: 'u1', displayName: 'Alice', role: 'host',
      }));
      expect(sent.members[0].ws).toBeUndefined();
      expect(sent.members[0].joinedAt).toBeUndefined();
    });
  });

  describe('sendToMember', () => {
    test('sends to a specific member', () => {
      const ws = mockWs();
      rm.addMember('room-1', new RoomMember({ ws, userId: 'u1' }));
      rm.sendToMember('room-1', 'u1', { type: 'HELLO' });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'HELLO' }));
    });
  });

  // ── Room Lifecycle ────────────────────────────────────────────────────

  describe('isEmpty / deleteRoom / hasRoom', () => {
    test('isEmpty returns true when room has no members', () => {
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u1' }));
      rm.removeMember('room-1', 'u1');
      expect(rm.isEmpty('room-1')).toBe(true);
    });

    test('isEmpty returns true for non-existent room', () => {
      expect(rm.isEmpty('room-999')).toBe(true);
    });

    test('deleteRoom removes the room entirely', () => {
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u1' }));
      rm.deleteRoom('room-1');
      expect(rm.hasRoom('room-1')).toBe(false);
    });
  });

  describe('reset', () => {
    test('clears all rooms', () => {
      rm.addMember('room-1', new RoomMember({ ws: mockWs(), userId: 'u1' }));
      rm.addMember('room-2', new RoomMember({ ws: mockWs(), userId: 'u2' }));
      rm.reset();
      expect(rm.hasRoom('room-1')).toBe(false);
      expect(rm.hasRoom('room-2')).toBe(false);
    });
  });
});
