const $ = (id) => document.getElementById(id);
const PLAYER_COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)'];
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  token: localStorage.getItem('ww.token'),
  user: JSON.parse(localStorage.getItem('ww.user') || 'null'),
  config: { aiAvailable: false },
  room: null,
  events: null,
  lobbyTimer: null,
  seenWords: 0,
  wasMyTurn: false,
};

// ---------- api ----------

function saveLogin({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('ww.token', token);
  localStorage.setItem('ww.user', JSON.stringify(user));
}

function clearLogin() {
  state.token = state.user = null;
  localStorage.removeItem('ww.token');
  localStorage.removeItem('ww.user');
}

async function post(path, body, token = state.token) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session ended (logged out elsewhere): back to the login screen
    closeRoom();
    clearLogin();
    route();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2500);
}

// ---------- routing ----------

function show(view) {
  for (const name of ['login', 'lobby', 'room']) $(`view-${name}`).hidden = name !== view;
  $('whoami').hidden = view === 'login';
  $('whoami-name').textContent = state.user?.name ?? '';
}

async function route() {
  clearInterval(state.lobbyTimer);
  if (!state.token) return show('login');

  const match = location.hash.match(/^#\/room\/([A-Za-z0-9]+)/);
  if (match) return enterRoom(match[1].toUpperCase());

  closeRoom();
  show('lobby');
  $('create-ai-wrap').hidden = !state.config.aiAvailable;
  refreshRooms();
  state.lobbyTimer = setInterval(refreshRooms, 3000);
}

// ---------- login ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const action = e.submitter?.value === 'signup' ? 'signup' : 'login';
  const buttons = $('login-form').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    saveLogin(await post(action, { username: $('login-username').value, password: $('login-password').value }, null));
    $('login-password').value = '';
    route();
  } catch (err) {
    toast(err.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

$('logout').addEventListener('click', async () => {
  if (!confirm('Log out? Log back in any time to continue your games.')) return;
  closeRoom();
  await post('logout', {}).catch(() => {});
  clearLogin();
  location.hash = '#/';
  route();
});

// ---------- lobby ----------

async function refreshRooms() {
  try {
    const { rooms } = await api('rooms');
    const mine = rooms.filter((r) => r.mine);
    const open = rooms.filter((r) => !r.mine);
    $('my-room-list').replaceChildren(...mine.map(roomItem));
    $('my-games').hidden = mine.length === 0;
    $('room-list').replaceChildren(...open.map(roomItem));
    $('room-empty').hidden = open.length > 0;
  } catch (err) {
    toast(err.message);
  }
}

function roomItem(room) {
  const li = document.createElement('li');
  li.classList.toggle('my-turn', room.myTurn);
  const info = document.createElement('div');
  info.innerHTML = `<strong></strong><div class="meta"></div>`;
  info.querySelector('strong').textContent = room.name;
  info.querySelector('.meta').textContent = [
    room.myTurn && 'Your turn!',
    `${room.players}/${room.maxPlayers} players`,
    room.status === 'playing' ? 'playing' : 'waiting',
    room.hasAI && 'Gemini',
  ]
    .filter(Boolean)
    .join(' · ');
  const btn = document.createElement('button');
  btn.textContent = room.mine ? 'Open' : 'Join';
  btn.className = room.myTurn ? 'primary' : '';
  btn.disabled = !room.mine && room.players >= room.maxPlayers;
  btn.onclick = () => (location.hash = `#/room/${room.id}`);
  li.append(info, btn);
  return li;
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { room } = await api('rooms', { name: $('create-name').value, maxPlayers: $('create-max').value });
    if ($('create-ai').checked) await api(`rooms/${room.id}/add-ai`, {});
    $('create-name').value = '';
    location.hash = `#/room/${room.id}`;
  } catch (err) {
    toast(err.message);
  }
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code) location.hash = `#/room/${code}`;
});

// ---------- room ----------

async function enterRoom(id) {
  if (state.room?.id === id && state.events) return show('room');
  closeRoom();
  try {
    const { room } = await api(`rooms/${id}/join`, {});
    state.seenWords = room.words.length; // don't read out the backlog
    state.wasMyTurn = false;
    renderRoom(room);
    show('room');
    openEvents(id);
  } catch (err) {
    toast(err.message);
    location.hash = '#/';
  }
}

function openEvents(id) {
  const events = new EventSource(`/api/rooms/${id}/events?token=${encodeURIComponent(state.token)}`);
  events.onmessage = (e) => renderRoom(JSON.parse(e.data));
  events.onerror = async () => {
    // EventSource retries on its own; if the room is gone (server restart, everyone left), go back to the lobby
    if (events.readyState === EventSource.CLOSED || !(await api(`rooms/${id}/join`, {}).catch(() => null))) {
      if (state.events === events) {
        toast('Room closed');
        closeRoom();
        location.hash = '#/';
      }
    }
  };
  state.events = events;
}

function closeRoom() {
  state.events?.close();
  state.events = null;
  state.room = null;
  stopListening();
}

$('room-leave').addEventListener('click', async () => {
  const id = state.room?.id;
  closeRoom();
  if (id) await api(`rooms/${id}/leave`, {}).catch(() => {});
  location.hash = '#/';
});

$('room-code').addEventListener('click', async () => {
  const link = `${location.origin}/#/room/${state.room.id}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Play Wird Word with me', url: link });
    else {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    }
  } catch {}
});

for (const [btn, action] of [['add-ai', 'add-ai'], ['remove-ai', 'remove-ai'], ['start', 'start'], ['restart', 'restart']]) {
  $(btn).addEventListener('click', () => api(`rooms/${state.room.id}/${action}`, {}).catch((err) => toast(err.message)));
}

function renderRoom(room) {
  state.room = room;
  const me = state.user.id;
  const isHost = room.hostId === me;
  const colorOf = new Map(room.players.map((p, i) => [p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]]));
  const current = room.status === 'playing' ? room.players[room.turn] : null;
  const myTurn = current?.id === me;

  $('room-name').textContent = room.name;
  $('room-code').textContent = room.id;

  $('players').replaceChildren(
    ...room.players.map((p) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', colorOf.get(p.id));
      li.classList.toggle('active', p === current);
      li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="tag"></span>`;
      li.querySelector('.name').textContent = p.name;
      li.querySelector('.tag').textContent = [p.id === me && 'you', p.id === room.hostId && 'host', p.isAI && 'AI']
        .filter(Boolean)
        .join(' · ');
      return li;
    }),
  );

  // Waiting / host controls
  const waiting = room.status === 'waiting';
  $('room-waiting').hidden = !waiting;
  const open = room.maxPlayers - room.players.length;
  $('waiting-text').textContent = isHost
    ? `Share the code ${room.id} with friends${open ? `, or add a Gemini player` : ''}. Start when ready.`
    : 'Waiting for the host to start the game…';
  $('host-controls').hidden = !isHost;
  $('add-ai').hidden = !state.config.aiAvailable;
  $('add-ai').disabled = open <= 0;
  $('remove-ai').hidden = !room.players.some((p) => p.isAI);
  $('start').disabled = room.players.length < 2;
  $('restart').hidden = !isHost || room.words.length === 0;

  // Story
  const story = $('story');
  story.replaceChildren();
  room.words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    if (i >= state.seenWords) span.classList.add('new');
    span.style.setProperty('--c', colorOf.get(w.playerId) ?? 'var(--muted)');
    span.title = room.players.find((p) => p.id === w.playerId)?.name ?? '';
    span.textContent = w.word;
    story.append(span, ' ');
  });
  if (room.aiThinking) {
    const dots = document.createElement('span');
    dots.className = 'typing';
    dots.textContent = '…';
    story.append(dots);
  }
  $('story-empty').hidden = room.words.length > 0 || room.aiThinking;

  // Read new words from others aloud
  const fresh = room.words.slice(state.seenWords);
  if (fresh.length && $('tts').checked && 'speechSynthesis' in window) {
    for (const w of fresh) {
      if (w.playerId === me) continue;
      const utterance = new SpeechSynthesisUtterance(w.word);
      // Remember when we last spoke so the open mic doesn't pick up our own voice as the next word
      utterance.onend = () => (mic.ttsEndedAt = Date.now());
      speechSynthesis.speak(utterance);
    }
  }
  state.seenWords = room.words.length;

  $('notice').hidden = !room.notice;
  $('notice').textContent = room.notice ?? '';

  // Turn input
  $('word-form').hidden = room.status !== 'playing';
  $('turn-text').textContent = myTurn ? 'Your turn: add one word' : current ? `${current.name}'s turn…` : '';
  for (const id of ['word', 'send']) $(id).disabled = !myTurn;
  $('mic').hidden = !SpeechRecognition;
  $('mic').classList.toggle('hot', myTurn);
  $('mic').title = mic.enabled ? 'Mic on: click to turn off' : 'Turn mic on';
  if (myTurn && !state.wasMyTurn) {
    navigator.vibrate?.(80);
    if (!mic.enabled && !matchMedia('(pointer: coarse)').matches) $('word').focus();
  }
  state.wasMyTurn = myTurn;
}

// ---------- playing a word ----------

async function sendWord(word) {
  word = word.trim();
  if (!word) return;
  $('send').disabled = true;
  try {
    await api(`rooms/${state.room.id}/word`, { word });
    $('word').value = '';
  } catch (err) {
    toast(err.message);
    $('send').disabled = false;
  }
}

$('word-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendWord($('word').value);
});

// Block spaces: the whole point is one word at a time
$('word').addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    toast('One word only!');
  }
});
$('word').addEventListener('input', (e) => {
  if (/\s/.test(e.target.value)) e.target.value = e.target.value.split(/\s+/).filter(Boolean)[0] ?? '';
});

// ---------- microphone (Web Speech API) ----------

// The mic is a sticky toggle: once on, it keeps listening across turns until clicked off (or the room is left).
// Speech is only turned into a word when it's our turn; anything heard otherwise is ignored.
const TTS_ECHO_MS = 700;
const mic = { enabled: false, recognition: null, ttsEndedAt: 0 };

function isMyTurn() {
  const room = state.room;
  return room?.status === 'playing' && room.players[room.turn]?.id === state.user?.id;
}

function stopListening() {
  mic.enabled = false;
  const recognition = mic.recognition;
  mic.recognition = null;
  recognition?.abort();
  $('mic').classList.remove('listening');
}

function startRecognition() {
  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    if (!result.isFinal || !isMyTurn() || $('send').disabled) return;
    if (speechSynthesis.speaking || Date.now() - mic.ttsEndedAt < TTS_ECHO_MS) return;
    const said = result[0].transcript.trim();
    const words = said.split(/\s+/).filter(Boolean);
    const word = (words[0] ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.,!?;:]+$/gu, '');
    if (!word) return;
    if (words.length > 1) toast(`Heard "${said}", using "${word}"`);
    $('word').value = word;
    sendWord(word);
  };
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Microphone access denied (the page needs HTTPS or localhost)');
      stopListening();
    } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
      toast(`Mic error: ${e.error}`);
    }
  };
  // Browsers end recognition on their own after silence or a time limit: restart while the toggle is on
  recognition.onend = () => {
    if (mic.enabled && mic.recognition === recognition) setTimeout(() => mic.enabled && startRecognition(), 250);
  };
  mic.recognition = recognition;
  try {
    recognition.start();
  } catch (err) {
    toast(`Mic error: ${err.message}`);
    stopListening();
  }
}

$('mic').addEventListener('click', () => {
  if (mic.enabled) return stopListening();
  mic.enabled = true;
  $('mic').classList.add('listening');
  startRecognition();
});

// ---------- boot ----------

window.addEventListener('hashchange', route);
async function boot() {
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {}
  if (state.token) {
    // Refresh the saved profile, or drop a login that has ended
    const me = await api('me').catch(() => null);
    if (me) saveLogin({ token: state.token, user: me.user });
  }
  route();
}
boot();
