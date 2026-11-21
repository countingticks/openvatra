-- Chats on runs (SPEC-chat.md, Views). The request-bound chats and messages of 0002 go with no import: no chat UI
-- was ever released. Every table below is a view of the event log, kept by store's chatViews projector inside the
-- append's transaction. Times are Unix milliseconds.
DROP TABLE messages;
DROP TABLE chats;

CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  model        TEXT NOT NULL,
  profile      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  active_run   TEXT,
  active_state TEXT,
  last_seq     INTEGER NOT NULL
) STRICT;
CREATE INDEX chats_updated ON chats (updated_at DESC);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL REFERENCES chats ON DELETE CASCADE,
  profile       TEXT NOT NULL,
  model         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'interrupted', 'done', 'stopped', 'failed')),
  origin        TEXT NOT NULL,
  first_seq     INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  error_code    TEXT,
  error_message TEXT
) STRICT;
CREATE INDEX runs_chat ON runs (chat_id, first_seq);

-- A message's id is the seq of the event that made it, so the transcript orders and pages by seq.
CREATE TABLE messages (
  seq        INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats ON DELETE CASCADE,
  run_id     TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'summary')),
  parts      TEXT NOT NULL,                  -- JSON: [{kind, text}]
  stats      TEXT NOT NULL DEFAULT '{}',     -- JSON
  partial    INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  retracted  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_chat ON messages (chat_id, seq);

-- Each client request id maps to its run, so a repeated send writes nothing (SPEC-chat decision 13).
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  chat_id    TEXT NOT NULL REFERENCES chats ON DELETE CASCADE
) STRICT;
