-- Settings sections (SPEC-core-config.md). One row per section; rev is the compare-and-set counter.
CREATE TABLE config (
  section TEXT PRIMARY KEY,
  rev     INTEGER NOT NULL CHECK (rev > 0),
  value   TEXT NOT NULL            -- JSON of the section, as validated
) STRICT;
