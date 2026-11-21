-- Chat search (SPEC-chat.md decision 28). One FTS5 table over message text and chat titles, kept by store's
-- chatViews projector: rowid = the message's seq for its text (user and assistant text parts; reasoning, summaries
-- and retracted messages left out), and -chats.rowid for a chat's title.
CREATE VIRTUAL TABLE messages_fts USING fts5(chat_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');

INSERT INTO messages_fts (rowid, chat_id, body)
SELECT seq, chat_id, body FROM (
  SELECT m.seq, m.chat_id,
    (SELECT group_concat(p.value ->> '$.text', '') FROM json_each(m.parts) p WHERE p.value ->> '$.kind' = 'text') AS body
  FROM messages m
  WHERE m.role IN ('user', 'assistant') AND m.retracted = 0
)
WHERE body IS NOT NULL AND body != '';

INSERT INTO messages_fts (rowid, chat_id, body)
SELECT -rowid, id, title FROM chats WHERE title != '';
