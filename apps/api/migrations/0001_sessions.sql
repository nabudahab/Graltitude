CREATE TABLE sessions (
  id TEXT PRIMARY KEY, athlete TEXT UNIQUE NOT NULL, credentials TEXT NOT NULL,
  expires INTEGER NOT NULL, session_until INTEGER NOT NULL
);
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, session TEXT NOT NULL, expires INTEGER NOT NULL
);
