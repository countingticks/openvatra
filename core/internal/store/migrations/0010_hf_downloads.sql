-- Hugging Face downloads the user started, pinned at a revision, so a restart can list them as Paused and Remove can
-- find their folder. files is the JSON of the pick's files; created is Unix milliseconds.
CREATE TABLE hf_picks (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  revision TEXT NOT NULL,
  quant TEXT NOT NULL,
  files TEXT NOT NULL,
  created INTEGER NOT NULL
);
