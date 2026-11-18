-- What a real load and its answers measured, per model, user args and place (SPEC-core-seams.md, slice 5). A row holds
-- only the file it was measured on: a changed file size or time makes it stale, and the next write replaces it.
CREATE TABLE model_fit (
  model_id          TEXT    NOT NULL,
  projector         INTEGER NOT NULL,   -- 1 when the projector loads
  args              TEXT    NOT NULL,   -- the user's args, config.JoinArgs
  context           INTEGER NOT NULL,
  placement         TEXT    NOT NULL,   -- gpu, experts, layers, cpu
  layers            INTEGER NOT NULL,   -- 0 unless placement is layers
  file_bytes        INTEGER NOT NULL,
  file_mtime        INTEGER NOT NULL,   -- unix nanoseconds
  vram_bytes        INTEGER,            -- NULL: no load measured yet
  ram_bytes         INTEGER,
  tokens_per_second REAL,               -- NULL: no answer measured yet
  measured_at       INTEGER NOT NULL,   -- unix milliseconds
  PRIMARY KEY (model_id, projector, args, context, placement, layers)
) STRICT;
