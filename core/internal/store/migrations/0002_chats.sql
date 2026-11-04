-- Chats and their messages (SPEC-chat.md, Storage). Times are Unix milliseconds (integers sort and compare safely).
CREATE TABLE chats (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
    model        TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    web_search   INTEGER NOT NULL DEFAULT 0,
    settings     TEXT NOT NULL DEFAULT '{}'
);

-- The chat list is shown newest first.
CREATE INDEX chats_updated ON chats (updated_at DESC);

CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL DEFAULT '',
    reasoning  TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'stopped', 'error')),
    error      TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    stats      TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX messages_chat ON messages (chat_id, created_at);
