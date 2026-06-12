CREATE TABLE IF NOT EXISTS archetypes (
  name     TEXT PRIMARY KEY,
  count    INTEGER DEFAULT 0,
  mutations TEXT DEFAULT '[]',
  lastSeen TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id        TEXT PRIMARY KEY,
  project   TEXT,
  timestamp TEXT,
  turns     TEXT,
  note_ids  TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  project     TEXT,
  timestamp   TEXT,
  signal_type TEXT,
  note        TEXT,
  tags        TEXT
);
