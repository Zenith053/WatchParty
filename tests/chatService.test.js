/**
 * tests/chatService.test.js
 * Unit tests for the extracted ChatService class (Design Smell #3 + #5 fix)
 */
'use strict';

const ChatService = require('../server/ChatService');

describe('ChatService', () => {
  let chatService;

  beforeEach(() => {
    chatService = new ChatService();
  });

  describe('append()', () => {
    test('creates history array for new room', () => {
      chatService.append('room-1', { type: 'CHAT_MSG', text: 'hello' });
      expect(chatService.getHistory('room-1')).toHaveLength(1);
      expect(chatService.getHistory('room-1')[0].text).toBe('hello');
    });

    test('appends to existing room history', () => {
      chatService.append('room-1', { text: 'msg1' });
      chatService.append('room-1', { text: 'msg2' });
      chatService.append('room-1', { text: 'msg3' });
      expect(chatService.getHistory('room-1')).toHaveLength(3);
    });

    test('caps history at MAX_HISTORY (200)', () => {
      for (let i = 0; i < 210; i++) {
        chatService.append('room-1', { text: `msg-${i}` });
      }
      const history = chatService.getHistory('room-1');
      expect(history).toHaveLength(ChatService.MAX_HISTORY);
      // Oldest messages should have been shifted out
      expect(history[0].text).toBe('msg-10');
      expect(history[history.length - 1].text).toBe('msg-209');
    });

    test('maintains separate histories for different rooms', () => {
      chatService.append('room-a', { text: 'a-msg' });
      chatService.append('room-b', { text: 'b-msg' });
      expect(chatService.getHistory('room-a')).toHaveLength(1);
      expect(chatService.getHistory('room-b')).toHaveLength(1);
      expect(chatService.getHistory('room-a')[0].text).toBe('a-msg');
      expect(chatService.getHistory('room-b')[0].text).toBe('b-msg');
    });
  });

  describe('getHistory()', () => {
    test('returns empty array for unknown room', () => {
      expect(chatService.getHistory('nonexistent')).toEqual([]);
    });

    test('returns the correct messages', () => {
      chatService.append('room-1', { type: 'CHAT_MSG', text: 'hi' });
      chatService.append('room-1', { type: 'CHAT_REACTION', emoji: '🔥' });
      const history = chatService.getHistory('room-1');
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('CHAT_MSG');
      expect(history[1].type).toBe('CHAT_REACTION');
    });
  });

  describe('clear()', () => {
    test('removes history for a specific room', () => {
      chatService.append('room-1', { text: 'msg' });
      chatService.append('room-2', { text: 'msg' });
      chatService.clear('room-1');
      expect(chatService.getHistory('room-1')).toEqual([]);
      expect(chatService.getHistory('room-2')).toHaveLength(1);
    });

    test('no-op for unknown room', () => {
      expect(() => chatService.clear('nonexistent')).not.toThrow();
    });
  });

  describe('reset()', () => {
    test('clears all room histories', () => {
      chatService.append('room-1', { text: 'msg' });
      chatService.append('room-2', { text: 'msg' });
      chatService.reset();
      expect(chatService.getHistory('room-1')).toEqual([]);
      expect(chatService.getHistory('room-2')).toEqual([]);
    });
  });

  describe('MAX_HISTORY', () => {
    test('static constant is 200', () => {
      expect(ChatService.MAX_HISTORY).toBe(200);
    });
  });
});
