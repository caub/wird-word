-- Applied on server start. Keep every statement idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  -- scrypt$<salt>$<hash>, see server.js
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));

-- One row per logged-in device. The app hands out a random token and stores only its hash.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  name text NOT NULL,
  host_id uuid NOT NULL REFERENCES users (id),
  max_players int NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  turn int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_players (
  room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- The user's id for humans, 'ai-<uuid>' for Gemini players
  player_id text NOT NULL,
  user_id uuid REFERENCES users (id),
  seat int NOT NULL,
  name text NOT NULL,
  is_ai boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, player_id)
);
CREATE INDEX IF NOT EXISTS room_players_user_id_idx ON room_players (user_id);

CREATE TABLE IF NOT EXISTS words (
  room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  position int NOT NULL,
  word text NOT NULL,
  player_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, position)
);
