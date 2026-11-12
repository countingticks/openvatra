-- Event log (SPEC-core-events.md). seq is AUTOINCREMENT so a deleted seq is never reused and order is commit order.
CREATE TABLE events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  time   INTEGER NOT NULL,
  stream TEXT NOT NULL,
  type   TEXT NOT NULL,
  v      INTEGER NOT NULL CHECK (v > 0),
  data   TEXT NOT NULL                       -- JSON
) STRICT;
CREATE INDEX events_stream ON events (stream, seq);

CREATE TABLE log_info (
  id TEXT NOT NULL                            -- random; new only when the database is new
) STRICT;
INSERT INTO log_info (id) VALUES (lower(hex(randomblob(16))));
