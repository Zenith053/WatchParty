/**
 * tests/security.test.js
 * Integration tests for NFR-06 WebSocket upgrade hardening.
 */
'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { validateInviteToken } = require('../server/roomService');

// Mock roomService to control validation outcomes
jest.mock('../server/roomService', () => ({
  validateInviteToken: jest.fn(),
}));

/**
 * Minimal server that replicates index.js upgrade logic
 */
function createTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (!url.pathname.startsWith('/ws')) {
        socket.destroy();
        return;
      }

      const roomId = url.searchParams.get('roomId');
      const token = url.searchParams.get('token');

      const { valid, error } = await validateInviteToken(roomId, token);

      if (!valid) {
        socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${error}`);
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, wss, port });
    });
  });
}

describe('WebSocket Upgrade Security (NFR-06)', () => {
  let server, wss, port;

  beforeAll(async () => {
    ({ server, wss, port } = await createTestServer());
  });

  afterAll((done) => {
    server.close(done);
  });

  test('rejects connection without roomId or token', (done) => {
    validateInviteToken.mockResolvedValueOnce({ valid: false, error: 'roomId and token are required' });
    
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('error', (err) => {
      expect(err.message).toMatch(/403/);
      done();
    });
    ws.on('open', () => {
      ws.close();
      done(new Error('Should not have opened'));
    });
  });

  test('rejects connection with invalid token', (done) => {
    validateInviteToken.mockResolvedValueOnce({ valid: false, error: 'Invalid invite token' });
    
    const ws = new WebSocket(`ws://localhost:${port}/ws?roomId=abc&token=123`);
    ws.on('error', (err) => {
      expect(err.message).toMatch(/403/);
      done();
    });
  });

  test('rejects connection with expired token', (done) => {
    validateInviteToken.mockResolvedValueOnce({ valid: false, error: 'Invite link has expired' });
    
    const ws = new WebSocket(`ws://localhost:${port}/ws?roomId=abc&token=expired`);
    ws.on('error', (err) => {
      expect(err.message).toMatch(/403/);
      done();
    });
  });

  test('accepts connection with valid credentials', (done) => {
    validateInviteToken.mockResolvedValueOnce({ valid: true });
    
    const ws = new WebSocket(`ws://localhost:${port}/ws?roomId=valid-room&token=valid-token`);
    ws.on('open', () => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      done();
    });
    ws.on('error', (err) => {
      done(err);
    });
  });

  test('destroys socket for non-ws paths', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/invalid-path`);
    ws.on('error', () => {
      // Socket destroyed without HTTP response usually emits error
      done();
    });
    ws.on('open', () => {
      ws.close();
      done(new Error('Should not have opened'));
    });
  });
});
