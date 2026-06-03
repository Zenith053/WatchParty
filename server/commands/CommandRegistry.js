/**
 * CommandRegistry.js — Maps message type strings to Command classes
 *
 * Central registry for the Command Pattern. Adding a new message type
 * requires only: (1) create a new Command class, (2) register it here.
 * Zero changes to the WebSocket hub (syncService.js).
 */
'use strict';

const PlayCommand          = require('./PlayCommand');
const PauseCommand         = require('./PauseCommand');
const SeekCommand          = require('./SeekCommand');
const LoadCommand          = require('./LoadCommand');
const GrantCohostCommand   = require('./GrantCohostCommand');
const QueueAddCommand      = require('./QueueAddCommand');
const QueueUpvoteCommand   = require('./QueueUpvoteCommand');
const QueueRemoveCommand   = require('./QueueRemoveCommand');
const SkipVoteCommand      = require('./SkipVoteCommand');
const VideoEndedCommand    = require('./VideoEndedCommand');
const ChatMsgCommand       = require('./ChatMsgCommand');
const ChatReactionCommand  = require('./ChatReactionCommand');
const SetNameCommand       = require('./SetNameCommand');
const SyncCheckCommand     = require('./SyncCheckCommand');
const SyncRequestCommand   = require('./SyncRequestCommand');
const SyncResponseCommand  = require('./SyncResponseCommand');

/**
 * Registry: message type → Command class constructor.
 * @type {Map<string, typeof import('./BaseCommand')>}
 */
const registry = new Map([
  // FR-02: Playback Sync
  ['PLAY',           PlayCommand],
  ['PAUSE',          PauseCommand],
  ['SEEK',           SeekCommand],
  ['LOAD',           LoadCommand],

  // FR-04: Host/Guest Roles
  ['GRANT_COHOST',   GrantCohostCommand],

  // FR-05: Vote-to-Watch Queue
  ['QUEUE_ADD',      QueueAddCommand],
  ['QUEUE_UPVOTE',   QueueUpvoteCommand],
  ['QUEUE_REMOVE',   QueueRemoveCommand],

  // FR-06: Skip Vote
  ['SKIP_VOTE',      SkipVoteCommand],

  // FR-05: Auto-play next
  ['VIDEO_ENDED',    VideoEndedCommand],

  // FR-10: Live Chat
  ['CHAT_MSG',       ChatMsgCommand],
  ['CHAT_REACTION',  ChatReactionCommand],

  // FR-08: Display Names
  ['SET_NAME',       SetNameCommand],

  // Sync verification
  ['SYNC_CHECK',     SyncCheckCommand],
  ['SYNC_REQUEST',   SyncRequestCommand],
  ['SYNC_RESPONSE',  SyncResponseCommand],
]);

module.exports = registry;
