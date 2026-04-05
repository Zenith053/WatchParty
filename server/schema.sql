-- WatchParty PostgreSQL Schema
-- Run once: psql $DATABASE_URL -f server/schema.sql

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
  upvotes    INT         NOT NULL DEFAULT 0,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queue_room ON queue(room_id, upvotes DESC);
