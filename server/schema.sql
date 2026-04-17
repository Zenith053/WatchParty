-- WatchParty PostgreSQL Schema
-- Run once: psql $WP_DATABASE_URL -f server/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT        PRIMARY KEY,        -- UUIDv7
  invite_token  TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id      TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,            -- UUIDv7 per session
  display_name TEXT        NOT NULL DEFAULT 'Guest',
  role         TEXT        NOT NULL DEFAULT 'guest' CHECK (role IN ('host','co-host','guest')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS queue (
  id         SERIAL      PRIMARY KEY,
  room_id    TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  url        TEXT        NOT NULL,
  added_by   TEXT        NOT NULL DEFAULT 'unknown',
  upvotes    INT         NOT NULL DEFAULT 0,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queue_room ON queue(room_id, upvotes DESC);

-- FR-05: Prevent duplicate upvotes per user per queue entry
CREATE TABLE IF NOT EXISTS queue_votes (
  queue_id   INT         NOT NULL REFERENCES queue(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL,
  PRIMARY KEY (queue_id, user_id)
);

-- FR-06: Track skip votes per room (reset when video changes)
CREATE TABLE IF NOT EXISTS skip_votes (
  room_id    TEXT        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
