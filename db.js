import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}

// Neon URLs say sslmode=require, which pg treats as verify-full today but warns will weaken in pg 9: ask for verify-full explicitly
const withStrictSsl = (url) => url?.replace(/sslmode=require\b/, 'sslmode=verify-full');

// Pooled connection for app traffic
const pool = new pg.Pool({ connectionString: withStrictSsl(process.env.DATABASE_URL), max: 5 });
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

export const query = (text, params) => pool.query(text, params);

/** Applies schema.sql over a direct (unpooled) connection, as Neon recommends for DDL */
export async function migrate() {
  const client = new pg.Client({
    connectionString: withStrictSsl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL),
  });
  await client.connect();
  try {
    await client.query(await readFile(join(import.meta.dirname, 'schema.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

// ---------- users ----------

const toUser = (row) => row && { id: row.id, name: row.username };

export async function createUser({ id, username, passwordHash }) {
  const { rows } = await query(
    'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
    [id, username, passwordHash],
  );
  return toUser(rows[0]);
}

/** Returns the user plus their password hash, for checking a login */
export async function findUserByUsername(username) {
  const { rows } = await query('SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)', [
    username,
  ]);
  return rows[0] ? { user: toUser(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function createSession(userId, tokenHash) {
  await query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [tokenHash, userId]);
}

export async function deleteSession(tokenHash) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function findUserByTokenHash(tokenHash) {
  const { rows } = await query(
    `WITH s AS (UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 RETURNING user_id)
     UPDATE users SET last_seen_at = now() FROM s WHERE users.id = s.user_id RETURNING users.id, users.username`,
    [tokenHash],
  );
  return toUser(rows[0]);
}

// ---------- rooms ----------

export async function insertRoom(room, host) {
  await query('INSERT INTO rooms (id, name, host_id, max_players) VALUES ($1, $2, $3, $4)', [
    room.id,
    room.name,
    room.hostId,
    room.maxPlayers,
  ]);
  await insertPlayer(room.id, host);
}

export async function loadRoom(id) {
  const [{ rows: roomRows }, { rows: players }, { rows: words }] = await Promise.all([
    query('SELECT id, name, host_id, max_players, status, turn FROM rooms WHERE id = $1', [id]),
    query('SELECT player_id, name, is_ai, seat FROM room_players WHERE room_id = $1 ORDER BY seat', [id]),
    query('SELECT word, player_id FROM words WHERE room_id = $1 ORDER BY position', [id]),
  ]);
  const row = roomRows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    maxPlayers: row.max_players,
    status: row.status,
    turn: row.turn,
    players: players.map((p) => ({ id: p.player_id, name: p.name, isAI: p.is_ai, seat: p.seat })),
    words: words.map((w) => ({ word: w.word, playerId: w.player_id })),
  };
}

export async function saveRoomState(room) {
  await query('UPDATE rooms SET host_id = $2, status = $3, turn = $4, updated_at = now() WHERE id = $1', [
    room.id,
    room.hostId,
    room.status,
    room.turn,
  ]);
}

export async function deleteRoom(id) {
  await query('DELETE FROM rooms WHERE id = $1', [id]);
}

export async function insertPlayer(roomId, player) {
  await query(
    'INSERT INTO room_players (room_id, player_id, user_id, seat, name, is_ai) VALUES ($1, $2, $3, $4, $5, $6)',
    [roomId, player.id, player.isAI ? null : player.id, player.seat, player.name, player.isAI],
  );
}

export async function deletePlayer(roomId, playerId) {
  await query('DELETE FROM room_players WHERE room_id = $1 AND player_id = $2', [roomId, playerId]);
}

export async function insertWord(roomId, position, { word, playerId }) {
  await query('INSERT INTO words (room_id, position, word, player_id) VALUES ($1, $2, $3, $4)', [
    roomId,
    position,
    word,
    playerId,
  ]);
}

export async function clearWords(roomId) {
  await query('DELETE FROM words WHERE room_id = $1', [roomId]);
}

/** The user's own games, plus other recently active rooms that still have a free seat */
export async function listRooms(userId) {
  const { rows } = await query(
    `SELECT r.id, r.name, r.status, r.max_players,
            count(*)::int AS players,
            bool_or(p.is_ai) AS has_ai,
            coalesce(bool_or(p.user_id = $1), false) AS mine,
            (array_agg(p.player_id ORDER BY p.seat))[r.turn + 1] = $1::text AND r.status = 'playing' AS my_turn
       FROM rooms r
       JOIN room_players p ON p.room_id = r.id
      GROUP BY r.id
     HAVING coalesce(bool_or(p.user_id = $1), false)
         OR (count(*) < r.max_players AND r.updated_at > now() - interval '2 days')
      ORDER BY r.updated_at DESC
      LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    players: r.players,
    maxPlayers: r.max_players,
    hasAI: r.has_ai,
    mine: r.mine,
    myTurn: Boolean(r.my_turn),
  }));
}
