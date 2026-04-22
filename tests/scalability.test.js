/**
 * tests/scalability.test.js
 * Verification of NFR-04 scalability enforcement (caps and limits).
 */
'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { handleConnection, _resetSyncService } = require('../server/syncService');
const { createRoom } = require('../server/roomService');
const { _resetMemoryDb } = require('../server/memoryDb');

// Mock DB to use memoryDb fallback for testing
jest.mock('../server/db', () => require('../server/memoryDb'));

// ── Test Helpers ──────────────────────────────────────────────────────────

function startWsServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
    wss.on('connection', handleConnection);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, wss, port });
    });
  });
}

/**
 * Mocking Express Response for createRoom tests
 */
function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('NFR-04 Scalability Enforcement', () => {

  beforeEach(() => {
    _resetMemoryDb();
    _resetSyncService();
  });

  describe('Room Capacity (Max 20)', () => {
    test('allows creating 20 rooms but rejects the 21st', async () => {
      // 1. Create 20 rooms successfully
      for (let i = 0; i < 20; i++) {
        const res = mockRes();
        await createRoom({}, res);
        expect(res.status).toHaveBeenCalledWith(201);
      }

      // 2. Attempt the 21st
      const res21 = mockRes();
      await createRoom({}, res21);
      expect(res21.status).toHaveBeenCalledWith(403);
      expect(res21.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Server capacity reached')
      }));
    });
  });

  describe('Member Capacity (Max 10 per room)', () => {
    let server, port;

    beforeAll(async () => {
      ({ server, port } = await startWsServer());
    });

    afterAll((done) => {
      server.close(done);
    });

    test('allows 10 users to join but rejects the 11th', (done) => {
      const roomId = 'room-101';
      const sockets = [];
      let connectedCount = 0;

      // Helper to join
      const join = (userId) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'JOIN', roomId, userId }));
        });
        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.type === 'MEMBER_LIST') {
            // First time we get member list, mark as connected
            if (ws._verified) return;
            ws._verified = true;
            connectedCount++;
            if (connectedCount === 10) {
              // Now try the 11th
              tryJoin11();
            }
          }
        });
        sockets.push(ws);
      };

      const tryJoin11 = () => {
        const ws11 = new WebSocket(`ws://localhost:${port}/ws`);
        ws11.on('open', () => {
          ws11.send(JSON.stringify({ type: 'JOIN', roomId, userId: 'user-11' }));
        });
        ws11.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.type === 'ERROR' && msg.message.includes('Room is full')) {
            // Success: 11th user rejected
            cleanup();
          }
        });
        ws11.on('close', () => {
           // Might close immediately after error
        });
        sockets.push(ws11);
      };

      const cleanup = () => {
        sockets.forEach(s => s.close());
        done();
      };

      // Join 10 users
      for (let i = 1; i <= 10; i++) {
        join(`user-${i}`);
      }
    }, 10000); // 10s timeout for many connections
  });
});
