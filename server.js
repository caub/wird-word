import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { extname, join, normalize } from 'node:path';
import * as db from './db.js';

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
// Tried when the main model errors out (overloaded, rate limited, retired...)
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest';
const PUBLIC_DIR = join(import.meta.dirname, 'public');

const MAX_WORD_LENGTH = 30;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const AI_DELAY_MS = 900;
// A word made of letters/digits with optional inner apostrophes or hyphens, plus one optional trailing punctuation mark
const WORD_RE = /^[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*[.,!?;:]?$/u;

// Postgres is the source of truth; these are caches of what's been loaded.
/** token hash -> { id, name } */
const users = new Map();
/** roomId -> live room (adds SSE clients and AI state on top of the stored data) */
const rooms = new Map();
/** roomId -> in-flight load, so concurrent requests share one DB read */
const loadingRooms = new Map();

// ---------- helpers ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'Body too large');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

async function authUser(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  if (!token) throw new HttpError(401, 'Not logged in');
  const tokenHash = hashToken(token);
  let user = users.get(tokenHash);
  if (!user) {
    user = await db.findUserByTokenHash(tokenHash);
    if (!user) throw new HttpError(401, 'Not logged in');
    users.set(tokenHash, user);
  }
  return user;
}

/** Starts a session for the user on this device and returns its token */
async function startSession(user) {
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  await db.createSession(user.id, tokenHash);
  users.set(tokenHash, user);
  return token;
}

// ---------- passwords ----------

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;
const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}
// Checked against unknown usernames too, so a login takes the same time whether or not the account exists
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

// Slow down password guessing: at most LOGIN_MAX_FAILURES wrong passwords per username per window
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** lowercased username -> timestamps of recent failures */
const loginFailures = new Map();

function recentFailures(key) {
  const recent = (loginFailures.get(key) ?? []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
  if (recent.length) loginFailures.set(key, recent);
  else loginFailures.delete(key);
  return recent;
}

function readCredentials(body) {
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!username || !password) throw new HttpError(400, 'Enter a username and a password');
  if (password.length > 200) throw new HttpError(400, 'That password is too long');
  return { username, password };
}

function liveRoom(stored) {
  return { ...stored, aiThinking: false, notice: null, clients: new Set(), saving: Promise.resolve() };
}

async function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    if (!loadingRooms.has(id)) {
      loadingRooms.set(id, db.loadRoom(id).finally(() => loadingRooms.delete(id)));
    }
    const stored = await loadingRooms.get(id);
    if (!stored) throw new HttpError(404, 'Room not found');
    room = rooms.get(id);
    if (!room) {
      room = liveRoom(stored);
      rooms.set(id, room);
      // Resume a game that was waiting on Gemini when the server stopped
      maybeAiTurn(room);
    }
  }
  return room;
}

/** Queues a DB write for the room, so writes land in the same order as the in-memory changes */
function persist(room, write) {
  room.saving = room.saving.then(write).catch((err) => console.error(`Saving room ${room.id} failed:`, err.message));
  return room.saving;
}

function nextSeat(room) {
  return Math.max(-1, ...room.players.map((p) => p.seat)) + 1;
}

function cleanName(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeWord(input) {
  const word = String(input ?? '').trim();
  if (!word) throw new HttpError(400, 'Say or type a word');
  if (/\s/.test(word)) throw new HttpError(400, 'Only one word at a time');
  if (word.length > MAX_WORD_LENGTH) throw new HttpError(400, 'That word is too long');
  if (!WORD_RE.test(word)) throw new HttpError(400, 'That is not a single word');
  return word;
}

// ---------- rooms ----------

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    status: room.status,
    players: room.players.map(({ id, name, isAI }) => ({ id, name, isAI })),
    turn: room.turn,
    words: room.words,
    aiThinking: room.aiThinking,
    notice: room.notice,
  };
}

function broadcast(room) {
  const data = `data: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const res of room.clients) res.write(data);
}

function currentPlayer(room) {
  return room.players[room.turn];
}

function removePlayer(room, playerId) {
  const index = room.players.findIndex((p) => p.id === playerId);
  if (index === -1) return;
  room.players.splice(index, 1);

  // Closing the app keeps your seat; only an explicit leave frees it. The last human leaving ends the room.
  if (!room.players.some((p) => !p.isAI)) {
    for (const res of room.clients) res.end();
    rooms.delete(room.id);
    return persist(room, () => db.deleteRoom(room.id));
  }
  if (room.hostId === playerId) room.hostId = room.players.find((p) => !p.isAI).id;
  if (index < room.turn) room.turn--;
  if (room.turn >= room.players.length) room.turn = 0;
  if (room.status === 'playing' && room.players.length < MIN_PLAYERS) {
    room.status = 'waiting';
    room.notice = 'Not enough players left, game paused';
  }
  broadcast(room);
  maybeAiTurn(room);
  return persist(room, async () => {
    await db.deletePlayer(room.id, playerId);
    await db.saveRoomState(room);
  });
}

function addWord(room, player, word) {
  const entry = { word, playerId: player.id };
  const position = room.words.push(entry) - 1;
  room.turn = (room.turn + 1) % room.players.length;
  room.notice = null;
  broadcast(room);
  maybeAiTurn(room);
  return persist(room, async () => {
    await db.insertWord(room.id, position, entry);
    await db.saveRoomState(room);
  });
}

// ---------- Gemini ----------

async function askGemini(room) {
  try {
    return await askGeminiModel(room, GEMINI_MODEL);
  } catch (err) {
    if (!GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL === GEMINI_MODEL) throw err;
    console.warn(`${GEMINI_MODEL} failed (${err.message.split('\n')[0]}), trying ${GEMINI_FALLBACK_MODEL}`);
    return askGeminiModel(room, GEMINI_FALLBACK_MODEL);
  }
}

async function askGeminiModel(room, model) {
  const story = room.words.map((w) => w.word).join(' ');
  const prompt = [
    'We are playing a word-by-word storytelling game. Players take turns adding exactly ONE word to a shared story.',
    'Keep the story grammatical, fun and a little surprising. You may end a sentence with punctuation attached to your word (e.g. "night.").',
    story ? `Story so far: "${story}"` : 'The story is empty: pick a good first word.',
    'Reply with ONLY your next single word, nothing else.',
  ].join('\n');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1 },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const first = text.trim().split(/\s+/)[0]?.replace(/^["'“”*_]+|["'“”*_]+$/g, '');
  return normalizeWord(first);
}

function maybeAiTurn(room) {
  if (room.status !== 'playing' || room.aiThinking) return;
  const player = currentPlayer(room);
  if (!player?.isAI) return;

  room.aiThinking = true;
  broadcast(room);
  setTimeout(async () => {
    let word;
    try {
      word = await askGemini(room);
    } catch (err) {
      console.error('AI turn failed:', err.message);
      room.notice = `${player.name} got stuck, skipping its turn`;
    }
    room.aiThinking = false;
    // The room may have changed while we waited (player left, game paused)
    if (!rooms.has(room.id) || room.status !== 'playing' || currentPlayer(room) !== player) {
      if (rooms.has(room.id)) broadcast(room);
      return;
    }
    if (word) {
      addWord(room, player, word);
    } else {
      room.turn = (room.turn + 1) % room.players.length;
      broadcast(room);
      maybeAiTurn(room);
      persist(room, () => db.saveRoomState(room));
    }
  }, AI_DELAY_MS);
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (method === 'GET' && parts[1] === 'config') {
    return send(res, 200, { aiAvailable: Boolean(GEMINI_API_KEY), maxPlayers: MAX_PLAYERS });
  }

  if (method === 'POST' && parts[1] === 'signup') {
    const { username, password } = readCredentials(await readJson(req));
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Usernames are 3 to 20 letters, digits, dots, dashes or underscores');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    let user;
    try {
      user = await db.createUser({ id: randomUUID(), username, passwordHash: await hashPassword(password) });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'That username is taken');
      throw err;
    }
    return send(res, 201, { token: await startSession(user), user });
  }

  if (method === 'POST' && parts[1] === 'login') {
    const { username, password } = readCredentials(await readJson(req));
    const key = username.toLowerCase();
    if (recentFailures(key).length >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'Too many wrong passwords, try again in a few minutes');
    }
    const found = await db.findUserByUsername(username);
    const ok = await checkPassword(password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) {
      loginFailures.set(key, [...recentFailures(key), Date.now()]);
      throw new HttpError(401, 'Wrong username or password');
    }
    loginFailures.delete(key);
    return send(res, 200, { token: await startSession(found.user), user: found.user });
  }

  if (method === 'POST' && parts[1] === 'logout') {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      const tokenHash = hashToken(header.slice(7));
      users.delete(tokenHash);
      await db.deleteSession(tokenHash);
    }
    return send(res, 200, { ok: true });
  }

  const user = await authUser(req, url);

  if (method === 'GET' && parts[1] === 'me') return send(res, 200, { user });

  if (parts[1] !== 'rooms') throw new HttpError(404, 'Not found');

  if (parts.length === 2) {
    if (method === 'GET') return send(res, 200, { rooms: await db.listRooms(user.id) });
    if (method === 'POST') {
      const body = await readJson(req);
      const maxPlayers = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Number(body.maxPlayers) || 2));
      const host = { id: user.id, name: user.name, isAI: false, seat: 0 };
      const room = liveRoom({
        id: randomBytes(3).toString('hex').toUpperCase(),
        name: cleanName(body.name, 40) || `${user.name}'s room`,
        hostId: user.id,
        maxPlayers,
        status: 'waiting',
        players: [host],
        turn: 0,
        words: [],
      });
      await db.insertRoom(room, host);
      rooms.set(room.id, room);
      return send(res, 201, { room: publicRoom(room) });
    }
  }

  const room = await getRoom(parts[2].toUpperCase());
  const action = parts[3];
  const inRoom = room.players.some((p) => p.id === user.id);
  const isHost = room.hostId === user.id;

  if (method === 'GET' && action === 'events') {
    if (!inRoom) throw new HttpError(403, 'Join the room first');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
    room.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(res);
    });
    return;
  }

  if (method !== 'POST') throw new HttpError(405, 'Method not allowed');

  switch (action) {
    case 'join': {
      if (!inRoom) {
        if (room.players.length >= room.maxPlayers) throw new HttpError(409, 'Room is full');
        const player = { id: user.id, name: user.name, isAI: false, seat: nextSeat(room) };
        room.players.push(player);
        broadcast(room);
        await persist(room, () => db.insertPlayer(room.id, player));
      }
      return send(res, 200, { room: publicRoom(room) });
    }
    case 'leave': {
      await removePlayer(room, user.id);
      return send(res, 200, { ok: true });
    }
    case 'add-ai': {
      if (!isHost) throw new HttpError(403, 'Only the host can add an AI player');
      if (!GEMINI_API_KEY) throw new HttpError(400, 'No GEMINI_API_KEY configured on the server');
      if (room.players.length >= room.maxPlayers) throw new HttpError(409, 'Room is full');
      const count = room.players.filter((p) => p.isAI).length;
      const ai = { id: `ai-${randomUUID()}`, name: count ? `Gemini ${count + 1}` : 'Gemini', isAI: true, seat: nextSeat(room) };
      room.players.push(ai);
      broadcast(room);
      maybeAiTurn(room);
      await persist(room, () => db.insertPlayer(room.id, ai));
      return send(res, 200, { ok: true });
    }
    case 'remove-ai': {
      if (!isHost) throw new HttpError(403, 'Only the host can remove an AI player');
      const ai = room.players.findLast((p) => p.isAI);
      if (ai) await removePlayer(room, ai.id);
      return send(res, 200, { ok: true });
    }
    case 'start': {
      if (!isHost) throw new HttpError(403, 'Only the host can start');
      if (room.players.length < MIN_PLAYERS) throw new HttpError(400, 'Need at least 2 players');
      if (room.status === 'playing') return send(res, 200, { ok: true });
      room.status = 'playing';
      room.notice = null;
      broadcast(room);
      maybeAiTurn(room);
      await persist(room, () => db.saveRoomState(room));
      return send(res, 200, { ok: true });
    }
    case 'restart': {
      if (!isHost) throw new HttpError(403, 'Only the host can restart');
      room.words = [];
      room.turn = 0;
      room.status = room.players.length >= MIN_PLAYERS ? 'playing' : 'waiting';
      room.notice = null;
      broadcast(room);
      maybeAiTurn(room);
      await persist(room, async () => {
        await db.clearWords(room.id);
        await db.saveRoomState(room);
      });
      return send(res, 200, { ok: true });
    }
    case 'word': {
      // Read the body before checking the turn, so no other move can slip in between the check and the update
      const { word } = await readJson(req);
      if (!inRoom) throw new HttpError(403, 'Join the room first');
      if (room.status !== 'playing') throw new HttpError(400, 'The game has not started');
      if (currentPlayer(room)?.id !== user.id) throw new HttpError(409, 'Not your turn');
      await addWord(room, currentPlayer(room), normalizeWord(word));
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA fallback so /room/ABC123 deep links work
    const body = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

await db.migrate();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`wird-word running on http://localhost:${PORT}`);
  console.log(GEMINI_API_KEY ? `Gemini player enabled (${GEMINI_MODEL})` : 'No GEMINI_API_KEY: AI player disabled');
});
