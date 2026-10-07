/**
 * CamWave — live video chat room server.
 *
 * - Serves the static client from ./public
 * - WebSocket signaling for WebRTC (mesh) inside rooms
 * - In-memory state: rooms, users, contacts, DMs.
 * - Bans + welcome banner persist via Upstash Redis REST when
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set;
 *   otherwise they are memory-only too.
 *   NOTE: Render's free tier sleeps after ~15 min idle and restarts lose
 *   all in-memory state. That's expected here.
 *
 * Run:  npm start          (reads PORT from env, required by Render)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */

let nextUserId = 1;
let nextRoomId = 1;

// userId -> { id, name, ip, ws, status, roomId, contacts:Set<userId>,
//              muted, videoOn, role (per current room), talking, talkTimer }
const users = new Map();
// roomId -> { id, name, ownerId, admins:Set, mods:Set,
//             bans:Map<userId,{name,ip,ts}>, ipBans:Set<ip>,
//             settings:{ openMic:boolean, talkLimitSec:number },
//             dj:{ active:boolean, mode:'file'|'url'|null, url:string|null, volume:number, by:string|null } }
const rooms = new Map();
// nickname (lowercased) -> userId, for unique nicks + contact lookup
const nameToId = new Map();
// userId -> [{from,to,text,ts}]  (kept in memory, last 100 per pair)
const dmHistory = new Map();

// ---- Persistent global bans (survive restarts) ----
// Backed by Upstash Redis REST when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// are set; otherwise bans live in memory only (lost on restart, like before).
const gIpBans = new Set();            // ip -> true
const gNameBans = new Map();          // lowerName -> {name, ip, by, ts}
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const persistOn = !!(UP_URL && UP_TOKEN);

async function upstash(...parts) {
  if (!persistOn) return null;
  const url = UP_URL + '/' + parts.map(p => encodeURIComponent(String(p))).join('/');
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + UP_TOKEN } });
  if (!r.ok) throw new Error('upstash http ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('upstash: ' + j.error);
  return j.result;
}
// fire-and-forget writer; logs instead of crashing the request path
function persistWrite(p) {
  if (p && typeof p.catch === 'function') p.catch(e => console.warn('ban persist:', e.message));
}
async function loadPersistedBans() {
  if (!persistOn) { console.log('ban persistence: not configured (memory only)'); return; }
  try {
    const ips = await upstash('SMEMBERS', 'camwave:ipbans');
    if (Array.isArray(ips)) ips.forEach(ip => { if (ip) gIpBans.add(ip); });
    const raw = await upstash('HGETALL', 'camwave:namebans');
    let entries = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) entries[raw[i]] = raw[i + 1];
    } else if (raw && typeof raw === 'object') entries = raw;
    for (const [k, v] of Object.entries(entries)) {
      try { const rec = JSON.parse(v); if (rec && rec.name) gNameBans.set(k, rec); } catch {}
    }
    console.log(`ban persistence: loaded ${gIpBans.size} ip bans, ${gNameBans.size} name bans`);
  } catch (e) { console.warn('ban persistence unavailable:', e.message); }
}

// ---- Site owner + welcome letterhead ----
const SITE_OWNER = process.env.SITE_OWNER || 'ShadRick';
let siteBanner = {
  title: '👑 Welcome to CamWave',
  body: `This is ${SITE_OWNER}'s house.\n\nBe cool: no mic hogging, no spam, no hate, no creeping.\nBreak the rules and you'll be warned — then muted, kicked, or banned.\nThe boss is always watching. 👀`,
  contact: `📬 Reach the boss: send ${SITE_OWNER} a message in chat.`
};
async function loadSiteBanner() {
  if (!persistOn) return;
  try {
    const raw = await upstash('GET', 'camwave:sitebanner');
    if (raw) { const b = JSON.parse(raw); if (b && b.title) siteBanner = b; }
  } catch (e) { console.warn('site banner load:', e.message); }
}
function persistBanner() {
  persistWrite(upstash('SET', 'camwave:sitebanner', JSON.stringify(siteBanner)));
}

/* ============================== bots ==============================
   TriviaBot: interactive trivia (!trivia, !score, !top)
   HypeBot: fresh content (!trending, !joke, !fact, !bots) */
const BOT_TRIVIA = '🎲 TriviaBot';
const BOT_HYPE = '🔥 HypeBot';

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal,
      headers: { 'User-Agent': 'CamWave/1.0', ...((opts && opts.headers) || {}) } });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function botSay(roomId, name, text) {
  broadcastRoom(roomId, { type: 'chat-msg', from: 'bot', name, role: 'member', text, ts: Date.now(), bot: true });
}

// ---- trivia ----
const triviaState = new Map(); // roomId -> {active, q, answers:Map, scores:Map, timer}
const FALLBACK_QS = [
  { question: 'What planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correct: 1, category: 'Science' },
  { question: 'How many players are on a soccer team (on the field)?', options: ['9', '10', '11', '12'], correct: 2, category: 'Sports' },
  { question: 'What does "www" stand for?', options: ['World Wide Web', 'World Web Wide', 'Web World Wide', 'Wide World Web'], correct: 0, category: 'Tech' },
  { question: 'Which ocean is the largest?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correct: 3, category: 'Geography' },
  { question: 'How many sides does a hexagon have?', options: ['5', '6', '7', '8'], correct: 1, category: 'Math' },
  { question: 'What year did the first iPhone come out?', options: ['2005', '2007', '2009', '2010'], correct: 1, category: 'Tech' },
];
const htmlUnesc = s => String(s).replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function getTriviaQuestion() {
  try {
    const j = await fetchJson('https://opentdb.com/api.php?amount=1&type=multiple&difficulty=easy');
    const q = j.results && j.results[0];
    if (q && q.correct_answer) {
      const correct = htmlUnesc(q.correct_answer);
      const options = [...q.incorrect_answers.map(htmlUnesc), correct];
      for (let i = options.length - 1; i > 0; i--) {
        const r = Math.floor(Math.random() * (i + 1));
        [options[i], options[r]] = [options[r], options[i]];
      }
      return { question: htmlUnesc(q.question), options, correct: options.indexOf(correct), category: htmlUnesc(q.category || 'General') };
    }
  } catch {}
  const f = FALLBACK_QS[Math.floor(Math.random() * FALLBACK_QS.length)];
  return { ...f, options: [...f.options] };
}

async function startTrivia(roomId) {
  const st = triviaState.get(roomId);
  if (st && st.active) { botSay(roomId, BOT_TRIVIA, 'A round is already going — answer with A, B, C or D!'); return; }
  const q = await getTriviaQuestion();
  const letters = ['A', 'B', 'C', 'D'];
  const prev = triviaState.get(roomId);
  const next = { active: true, q, answers: new Map(), scores: (prev && prev.scores) || new Map(), timer: null };
  triviaState.set(roomId, next);
  botSay(roomId, BOT_TRIVIA,
    `🎲 TRIVIA [${q.category}]\n${q.question}\n${q.options.map((o, i) => `${letters[i]}) ${o}`).join('\n')}\n\nType A, B, C or D — 2 minutes!`);
  next.timer = setTimeout(() => endTrivia(roomId), 120000);
  if (next.timer.unref) next.timer.unref();
}
function endTrivia(roomId) {
  const st = triviaState.get(roomId);
  if (!st || !st.active) return;
  st.active = false;
  const letters = ['A', 'B', 'C', 'D'];
  const winners = [];
  for (const [uid, choice] of st.answers) {
    if (choice === st.q.correct) {
      const usr = users.get(uid);
      const nm = usr ? usr.name : 'Someone';
      winners.push(nm);
      const s = st.scores.get(uid) || { name: nm, score: 0 };
      s.score++; s.name = nm;
      st.scores.set(uid, s);
      recordTriviaWin(nm);
    }
  }
  const top = [...st.scores.values()].sort((a, b) => b.score - a.score).slice(0, 3)
    .map((s, i) => `${i + 1}. ${s.name} (${s.score})`).join('   ');
  botSay(roomId, BOT_TRIVIA,
    `⏰ Time! Answer: ${letters[st.q.correct]}) ${st.q.options[st.q.correct]}\n` +
    (winners.length ? `🎉 ${winners.join(', ')} got it!` : 'Nobody got it 😅') +
    (top ? `\n🏆 Leaders: ${top}` : '') +
    `\nType !trivia for another round.`);
}
function handleTriviaAnswer(roomId, user, text) {
  const st = triviaState.get(roomId);
  if (!st || !st.active) return false;
  const t = text.trim().toUpperCase();
  const letters = ['A', 'B', 'C', 'D'];
  let idx = letters.indexOf(t);
  if (idx < 0) idx = st.q.options.findIndex(o => o.toUpperCase() === t);
  if (idx < 0 || idx > 3) return false;
  st.answers.set(user.id, idx); // last answer counts
  return true; // swallow letter answers so nobody copies
}

// ---- hype: trending / jokes / facts ----
async function hypeTrending(roomId) {
  try {
    const j = await fetchJson('https://www.reddit.com/r/popular/top.json?limit=8&t=day');
    const posts = ((j.data && j.data.children) || []).map(c => c.data).filter(p => p && p.title && !p.over_18);
    if (posts.length) {
      const p = posts[Math.floor(Math.random() * posts.length)];
      return botSay(roomId, BOT_HYPE,
        `🔥 Trending on Reddit  [r/${p.subreddit}]\n"${p.title}"\n⬆️ ${p.ups} upvotes · 💬 ${p.num_comments} comments`);
    }
  } catch {}
  try {
    const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
    const id = ids[Math.floor(Math.random() * Math.min(10, ids.length))];
    const s = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (s && s.title) return botSay(roomId, BOT_HYPE,
      `🔥 Trending on Hacker News\n"${s.title}"\n⬆️ ${s.score} points · 💬 ${s.descendants || 0} comments`);
  } catch {}
  botSay(roomId, BOT_HYPE, '🔥 Could not fetch trends right now — try again in a bit!');
}
async function hypeJoke(roomId) {
  try {
    const j = await fetchJson('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } });
    if (j.joke) return botSay(roomId, BOT_HYPE, `😂 ${j.joke}`);
  } catch {}
  botSay(roomId, BOT_HYPE, '😂 Why do programmers prefer dark mode? Because light attracts bugs!');
}
async function hypeFact(roomId) {
  try {
    const j = await fetchJson('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
    if (j.text) return botSay(roomId, BOT_HYPE, `🧠 Random fact: ${j.text}`);
  } catch {}
  botSay(roomId, BOT_HYPE, '🧠 Random fact: Honey never spoils — archaeologists have tasted 3,000-year-old honey!');
}
function handleBotCommand(u, text) {
  const roomId = u.roomId;
  const cmd = text.slice(1).split(' ')[0].toLowerCase();
  switch (cmd) {
    case 'trivia':
      startTrivia(roomId).catch(() => botSay(roomId, BOT_TRIVIA, 'Could not start trivia right now.'));
      return true;
    case 'score': {
      const st = triviaState.get(roomId);
      const scores = st ? [...st.scores.values()].sort((a, b) => b.score - a.score).slice(0, 5) : [];
      botSay(roomId, BOT_TRIVIA, scores.length
        ? '🏆 Trivia leaders:\n' + scores.map((s, i) => `${i + 1}. ${s.name} — ${s.score}`).join('\n')
        : 'No scores yet. Type !trivia to play!');
      return true;
    }
    case 'trending': hypeTrending(roomId); return true;
    case 'joke': hypeJoke(roomId); return true;
    case 'fact': hypeFact(roomId); return true;
    case 'bots':
      botSay(roomId, BOT_HYPE, '🤖 Bot commands:\n!trivia — start a trivia round\n!score — room leaderboard\n!top — all-time champions\n!trending — what\'s hot online\n!joke — dad joke\n!fact — random fact');
      return true;
    case 'top': {
      const top = triviaBoard();
      botSay(roomId, BOT_TRIVIA, top.length
        ? '🏆 All-time trivia champions:\n' + top.map((s, i) => `${i + 1}. ${s.name} — ${s.score}`).join('\n')
        : 'No champions yet. Type !trivia to play!');
      return true;
    }
  }
  return false;
}

// ---- global trivia scoreboard (all-time, persistent) ----
const gTriviaScores = new Map(); // lowerName -> {name, score}
async function loadTriviaScores() {
  if (!persistOn) return;
  try {
    const raw = await upstash('HGETALL', 'camwave:triviascores');
    let entries = {};
    if (Array.isArray(raw)) { for (let i = 0; i + 1 < raw.length; i += 2) entries[raw[i]] = raw[i + 1]; }
    else if (raw && typeof raw === 'object') entries = raw;
    for (const [k, v] of Object.entries(entries)) {
      try { const r = JSON.parse(v); if (r && r.name) gTriviaScores.set(k, r); } catch {}
    }
    console.log(`trivia scores: loaded ${gTriviaScores.size} players`);
  } catch (e) { console.warn('trivia scores load:', e.message); }
}
function triviaBoard() {
  return [...gTriviaScores.values()].sort((a, b) => b.score - a.score).slice(0, 10)
    .map(s => ({ name: s.name, score: s.score }));
}
function recordTriviaWin(name) {
  const lname = name.toLowerCase();
  const g = gTriviaScores.get(lname) || { name, score: 0 };
  g.score++; g.name = name;
  gTriviaScores.set(lname, g);
  persistWrite(upstash('HSET', 'camwave:triviascores', lname, JSON.stringify(g)));
  broadcastAll({ type: 'trivia-board', board: triviaBoard() });
}

// ---- ambient bots: keep rooms lively on their own ----
// Every minute, maybe drop something fresh in rooms with 2+ people.
function ambientBotTick() {
  for (const room of rooms.values()) {
    let n = 0;
    for (const u of users.values()) if (u.roomId === room.id) n++;
    if (n < 2) continue;
    const tst = triviaState.get(room.id);
    if ((!tst || !tst.active) && Math.random() < 1 / 15) {
      startTrivia(room.id).catch(() => {});
    }
    if (Math.random() < 1 / 25) {
      const pick = Math.random();
      if (pick < 0.45) hypeTrending(room.id).catch(() => {});
      else if (pick < 0.75) hypeJoke(room.id).catch(() => {});
      else hypeFact(room.id).catch(() => {});
    }
  }
}
const ambientTimer = setInterval(ambientBotTick, 60000);
if (ambientTimer.unref) ambientTimer.unref();

const ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };

function roleOf(room, userId) {
  if (!room || !userId) return 'member';
  if (room.ownerId === userId) return 'owner';
  if (room.admins.has(userId)) return 'admin';
  if (room.mods.has(userId)) return 'moderator';
  return 'member';
}
function rankOf(room, userId) { return ROLE_RANK[roleOf(room, userId)] ?? 0; }

function publicUser(u) {
  return { id: u.id, name: u.name, gender: u.gender, age: u.age, status: u.status, muted: !!u.muted,
           micLive: !!u.micLive, videoOn: !!u.videoOn, talking: !!u.talking, photo: u.photo || null,
           sharingScreen: !!u.sharingScreen };
}
function roomSummary(r) {
  let count = 0;
  for (const u of users.values()) if (u.roomId === r.id) count++;
  return { id: r.id, name: r.name, userCount: count,
           openMic: r.settings.openMic, djActive: r.dj.active };
}
function roomUsers(roomId) {
  const out = [];
  for (const u of users.values()) {
    if (u.roomId !== roomId) continue;
    const p = publicUser(u);
    p.role = roleOf(rooms.get(roomId), u.id);
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendToUser(userId, obj) {
  const u = users.get(userId);
  if (u) send(u.ws, obj);
}
function broadcastRoom(roomId, obj, exceptId) {
  for (const u of users.values()) {
    if (u.roomId === roomId && u.id !== exceptId) send(u.ws, obj);
  }
}
function broadcastAll(obj) {
  for (const u of users.values()) send(u.ws, obj);
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function sanitizeName(raw) {
  let n = String(raw || '').trim().slice(0, 24).replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 _.\-]{2,24}$/.test(n)) return null;
  return n;
}
function dmKey(a, b) { return [a, b].sort().join(':'); }

/* ------------------------------------------------------------------ */
/* Static file server                                                  */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* Room + user lifecycle                                               */
/* ------------------------------------------------------------------ */

function doLeaveRoom(u, reason) {
  const roomId = u.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  u.roomId = null;
  u.muted = false;
  u.talking = false;
  clearTalkTimer(u);
  if (room) {
    broadcastRoom(roomId, { type: 'user-left', id: u.id, name: u.name, reason: reason || null });
    broadcastAll({ type: 'room-list', rooms: [...rooms.values()].map(roomSummary) });
    // Owner left: transfer ownership to an admin, else oldest mod/member
    if (room.ownerId === u.id) {
      const members = roomUsers(roomId);
      const pick = members.find(m => room.admins.has(m.id)) ||
                   members.find(m => room.mods.has(m.id)) || members[0];
      if (pick) {
        room.ownerId = pick.id;
        room.admins.delete(pick.id); room.mods.delete(pick.id);
        broadcastRoom(roomId, { type: 'room-roles', users: roomUsers(roomId) });
        sendToUser(pick.id, { type: 'notice', text: 'You are now the room owner.' });
      }
    }
    // Delete empty rooms (except keep none persistent — free tier resets anyway)
    const still = roomUsers(roomId).length;
    if (still === 0) {
      rooms.delete(roomId);
      broadcastAll({ type: 'room-list', rooms: [...rooms.values()].map(roomSummary) });
    }
  }
}

function clearTalkTimer(u) {
  if (u.talkTimer) { clearTimeout(u.talkTimer); u.talkTimer = null; }
}

function startTalkTimer(u) {
  clearTalkTimer(u);
  const room = rooms.get(u.roomId);
  if (!room || !room.settings.openMic) return;
  const limit = room.settings.talkLimitSec | 0;
  if (limit > 0) {
    u.talkTimer = setTimeout(() => {
      u.talkTimer = null;
      u.muted = true;
      u.talking = false;
      send(u.ws, { type: 'talk-timeout', limitSec: limit });
      broadcastRoom(u.roomId, { type: 'user-muted', id: u.id, name: u.name, reason: 'talk-time-limit' }, u.id);
    }, limit * 1000);
    // Safety: never hold a timer ref that keeps process alive pointlessly
    if (u.talkTimer.unref) u.talkTimer.unref();
  }
}

function pushRoomList() {
  broadcastAll({ type: 'room-list', rooms: [...rooms.values()].map(roomSummary) });
}

/* ------------------------------------------------------------------ */
/* Moderation                                                          */
/* ------------------------------------------------------------------ */

// action: mute|unmute|kick|ban|ipban|unban|promote-mod|promote-admin|demote
function handleModAction(actor, msg) {
  const room = rooms.get(msg.roomId);
  if (!room) return send(actor.ws, { type: 'error', message: 'Room not found.' });
  if (actor.roomId !== room.id) return send(actor.ws, { type: 'error', message: 'You are not in that room.' });
  const target = users.get(msg.targetId);
  const actorRank = rankOf(room, actor.id);

  const needRank = { mute: 1, unmute: 1, kick: 1, warn: 1, ban: 2, ipban: 2, unban: 2,
                     'promote-mod': 3, 'promote-admin': 3, demote: 3 }[msg.action];
  if (needRank == null) return send(actor.ws, { type: 'error', message: 'Unknown mod action.' });
  if (actorRank < needRank)
    return send(actor.ws, { type: 'error', message: 'You do not have permission for that.' });

  if (msg.action === 'unban') {
    // targetId here is the banned user id, or g:<name> / gip:<ip> for persistent global bans
    const tid = String(msg.targetId || '');
    if (tid.startsWith('g:')) {
      const lname = tid.slice(2);
      const rec = gNameBans.get(lname);
      if (!rec) return send(actor.ws, { type: 'error', message: 'User is not banned.' });
      gNameBans.delete(lname);
      persistWrite(upstash('HDEL', 'camwave:namebans', lname));
      if (rec.ip) { gIpBans.delete(rec.ip); persistWrite(upstash('SREM', 'camwave:ipbans', rec.ip)); }
      broadcastRoom(room.id, { type: 'notice', text: `${rec.name} was unbanned by ${actor.name}.` });
      send(actor.ws, { type: 'ban-list', bans: banList(room) });
      return;
    }
    if (tid.startsWith('gip:')) {
      const ip = tid.slice(4);
      if (!gIpBans.has(ip)) return send(actor.ws, { type: 'error', message: 'IP is not banned.' });
      gIpBans.delete(ip);
      persistWrite(upstash('SREM', 'camwave:ipbans', ip));
      broadcastRoom(room.id, { type: 'notice', text: `IP ${ip} was unbanned by ${actor.name}.` });
      send(actor.ws, { type: 'ban-list', bans: banList(room) });
      return;
    }
    const rec = room.bans.get(msg.targetId);
    if (!rec) return send(actor.ws, { type: 'error', message: 'User is not banned.' });
    room.bans.delete(msg.targetId);
    room.ipBans.delete(rec.ip);
    // also clear the persistent global records
    if (rec.ip) { gIpBans.delete(rec.ip); persistWrite(upstash('SREM', 'camwave:ipbans', rec.ip)); }
    if (rec.name) {
      const lname = rec.name.toLowerCase();
      gNameBans.delete(lname);
      persistWrite(upstash('HDEL', 'camwave:namebans', lname));
    }
    broadcastRoom(room.id, { type: 'notice', text: `${rec.name} was unbanned by ${actor.name}.` });
    send(actor.ws, { type: 'ban-list', bans: banList(room) });
    return;
  }

  if (!target) return send(actor.ws, { type: 'error', message: 'User not found.' });
  if (target.id === actor.id) return send(actor.ws, { type: 'error', message: 'You cannot moderate yourself.' });
  const targetRank = rankOf(room, target.id);
  if (targetRank >= actorRank)
    return send(actor.ws, { type: 'error', message: 'You cannot moderate someone at or above your rank.' });

  switch (msg.action) {
    case 'mute':
      target.muted = true; target.talking = false; clearTalkTimer(target);
      send(target.ws, { type: 'force-mute', by: actor.name });
      broadcastRoom(room.id, { type: 'user-muted', id: target.id, name: target.name, by: actor.name });
      broadcastRoom(room.id, { type: 'mod-banner', icon: '🔇', text: `${target.name} was muted by ${actor.name}` });
      break;
    case 'warn': {
      const reason = String(msg.reason || '').slice(0, 200);
      target.warnCount = (target.warnCount | 0) + 1;
      const wtext = `⚠️ Official warning from ${actor.name} (strike ${target.warnCount})${reason ? ': ' + reason : ''}`;
      send(target.ws, { type: 'warned', by: actor.name, reason, count: target.warnCount });
      // private DM record of the warning
      const entry = { from: actor.id, fromName: actor.name, to: target.id, text: wtext, ts: Date.now() };
      const k = dmKey(actor.id, target.id);
      if (!dmHistory.has(k)) dmHistory.set(k, []);
      const arr = dmHistory.get(k);
      arr.push(entry); if (arr.length > 100) arr.shift();
      send(target.ws, { type: 'dm-msg', ...entry });
      send(actor.ws, { type: 'dm-sent', ...entry });
      break;
    }
    case 'unmute':
      target.muted = false;
      send(target.ws, { type: 'force-unmute', by: actor.name });
      broadcastRoom(room.id, { type: 'user-unmuted', id: target.id, name: target.name, by: actor.name });
      break;
    case 'kick': {
      send(target.ws, { type: 'kicked', by: actor.name, reason: msg.reason || '' });
      broadcastRoom(room.id, { type: 'notice', text: `${target.name} was kicked by ${actor.name}.` }, target.id);
      broadcastRoom(room.id, { type: 'mod-banner', icon: '👢', text: `${target.name} was kicked by ${actor.name}` }, target.id);
      doLeaveRoom(target, 'kicked');
      break;
    }
    case 'ban':
    case 'ipban': {
      room.bans.set(target.id, { name: target.name, ip: target.ip, ts: Date.now(), by: actor.name });
      if (msg.action === 'ipban' && target.ip && target.ip !== 'unknown') room.ipBans.add(target.ip);
      // persistent global bans — survive restarts
      const lname = target.name.toLowerCase();
      const grec = { name: target.name, ip: target.ip, by: actor.name, ts: Date.now() };
      gNameBans.set(lname, grec);
      persistWrite(upstash('HSET', 'camwave:namebans', lname, JSON.stringify(grec)));
      if (msg.action === 'ipban' && target.ip && target.ip !== 'unknown') {
        gIpBans.add(target.ip);
        persistWrite(upstash('SADD', 'camwave:ipbans', target.ip));
      }
      send(target.ws, { type: 'banned', by: actor.name,
        message: msg.action === 'ipban' ? 'You have been IP-banned from this room.' : 'You have been banned from this room.' });
      broadcastRoom(room.id, { type: 'notice',
        text: `${target.name} was ${msg.action === 'ipban' ? 'IP-banned' : 'banned'} by ${actor.name}.` }, target.id);
      broadcastRoom(room.id, { type: 'mod-banner', icon: '🚫',
        text: `${target.name} was ${msg.action === 'ipban' ? 'IP-banned' : 'banned'} by ${actor.name}` }, target.id);
      doLeaveRoom(target, 'banned');
      send(actor.ws, { type: 'ban-list', bans: banList(room) });
      break;
    }
    case 'promote-mod':
      room.mods.add(target.id); room.admins.delete(target.id);
      broadcastRoom(room.id, { type: 'notice', text: `${target.name} is now a moderator.` });
      broadcastRoom(room.id, { type: 'room-roles', users: roomUsers(room.id) });
      break;
    case 'promote-admin':
      room.admins.add(target.id); room.mods.delete(target.id);
      broadcastRoom(room.id, { type: 'notice', text: `${target.name} is now an admin.` });
      broadcastRoom(room.id, { type: 'room-roles', users: roomUsers(room.id) });
      break;
    case 'demote':
      room.admins.delete(target.id); room.mods.delete(target.id);
      broadcastRoom(room.id, { type: 'notice', text: `${target.name} was demoted by ${actor.name}.` });
      broadcastRoom(room.id, { type: 'room-roles', users: roomUsers(room.id) });
      break;
  }
}

function banList(room) {
  const out = [...room.bans.entries()].map(([id, r]) => ({ id, name: r.name, ip: r.ip, by: r.by, ts: r.ts }));
  const seenNames = new Set(out.map(b => (b.name || '').toLowerCase()));
  const seenIps = new Set(out.map(b => b.ip));
  // persistent global bans (visible even after a restart wiped the room list)
  for (const [lname, r] of gNameBans) {
    if (!seenNames.has(lname)) out.push({ id: 'g:' + lname, name: r.name, ip: r.ip || '', by: r.by, ts: r.ts });
  }
  for (const ip of gIpBans) {
    if (ip && !seenIps.has(ip)) out.push({ id: 'gip:' + ip, name: '(IP ban)', ip, by: '', ts: 0 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const u = ws._user;
  if (!u && msg.type !== 'hello') return;

  switch (msg.type) {

    case 'hello': {
      const name = sanitizeName(msg.name);
      if (!name) return send(ws, { type: 'error', message: 'Pick a nickname (2-24 chars, letters/numbers/spaces).' });
      if (nameToId.has(name.toLowerCase()))
        return send(ws, { type: 'error', message: 'That nickname is taken. Try another.' });
      const id = 'u' + (nextUserId++);
      const gender = msg.gender === 'f' ? 'f' : 'm';
      const age = parseInt(msg.age, 10);
      if (!Number.isFinite(age) || age < 13 || age > 120)
        return send(ws, { type: 'error', message: 'Enter your age (13–120).' });
      const user = { id, name, gender, age, ip: ws._ip, ws, status: 'online', roomId: null,
                     contacts: new Set(), muted: false, micLive: false, videoOn: false, talking: false, talkTimer: null,
                     siteOwner: name === SITE_OWNER, photo: null, sharingScreen: false };
      ws._user = user;
      users.set(id, user);
      nameToId.set(name.toLowerCase(), id);
      send(ws, { type: 'welcome', id, name, gender, age, siteOwner: user.siteOwner, siteBanner, triviaBoard: triviaBoard() });
      // Seed a default room so the directory is never empty.
      // System-owned until someone joins, then the first joiner owns it.
      if (rooms.size === 0) makeRoom('Lobby', null);
      pushRoomList();
      break;
    }

    case 'set-status': {
      if (!['online', 'away', 'busy'].includes(msg.status)) return;
      u.status = msg.status;
      if (u.roomId) broadcastRoom(u.roomId, { type: 'user-status', id: u.id, status: u.status });
      // notify contacts
      for (const other of users.values()) {
        if (other.contacts.has(u.id)) send(other.ws, { type: 'contact-status', id: u.id, name: u.name, status: u.status });
      }
      break;
    }

    case 'create-room': {
      const name = String(msg.name || '').trim().slice(0, 40);
      if (name.length < 2) return send(ws, { type: 'error', message: 'Room name needs at least 2 characters.' });
      const room = makeRoom(name, u.id);
      pushRoomList();
      joinRoom(u, room.id);
      break;
    }

    case 'join-room': {
      joinRoom(u, msg.roomId);
      break;
    }

    case 'leave-room':
      doLeaveRoom(u);
      send(ws, { type: 'left-room' });
      break;

    case 'signal': {
      // Relay WebRTC signaling only between members of the same room
      const peer = users.get(msg.to);
      if (!peer || peer.roomId !== u.roomId || !u.roomId)
        return send(ws, { type: 'error', message: 'Signal target not in your room.' });
      send(peer.ws, { type: 'signal', from: u.id, data: msg.data });
      break;
    }

    case 'media-state': {
      // videoOn / talking flags for UI
      if (typeof msg.videoOn === 'boolean') u.videoOn = msg.videoOn;
      broadcastRoom(u.roomId, { type: 'user-media', id: u.id, videoOn: u.videoOn }, u.id);
      break;
    }

    case 'mic-on': {
      if (u.muted) return; // server-muted users stay muted
      const room = rooms.get(u.roomId);
      if (!room) return;
      if (!room.settings.openMic && msg.mode !== 'ptt-ok') {
        // PTT mode: mic only live while holding talk button; client handles,
        // server just tracks for UI
      }
      u.talking = true;
      u.micLive = true;
      startTalkTimer(u);
      broadcastRoom(u.roomId, { type: 'user-talking', id: u.id, talking: true, micLive: true }, u.id);
      break;
    }

    case 'mic-off': {
      u.talking = false;
      u.micLive = false;
      clearTalkTimer(u);
      broadcastRoom(u.roomId, { type: 'user-talking', id: u.id, talking: false, micLive: false }, u.id);
      break;
    }

    case 'chat': {
      if (!u.roomId) return;
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!text) return;
      if (text.startsWith('!') && handleBotCommand(u, text)) break;
      if (handleTriviaAnswer(u.roomId, u, text)) break;
      const room = rooms.get(u.roomId);
      const payload = { type: 'chat-msg', from: u.id, name: u.name,
        role: roleOf(room, u.id), text, ts: Date.now() };
      broadcastRoom(u.roomId, payload);
      break;
    }

    case 'chat-media': {
      if (!u.roomId) return;
      const kind = msg.kind === 'video' ? 'video' : 'image';
      const dataUrl = String(msg.dataUrl || '');
      if (!dataUrl.startsWith('data:')) return;
      // ~20MB cap on the encoded string (≈15MB file)
      if (dataUrl.length > 20 * 1024 * 1024)
        return send(ws, { type: 'error', message: 'That file is too big (max ~15MB).' });
      if (kind === 'image' && !/^data:image\/(jpeg|png|gif|webp)/i.test(dataUrl)) return;
      if (kind === 'video' && !/^data:video\//i.test(dataUrl)) return;
      const room = rooms.get(u.roomId);
      broadcastRoom(u.roomId, { type: 'chat-media', from: u.id, name: u.name,
        role: roleOf(room, u.id), kind, dataUrl, ts: Date.now() });
      break;
    }

    case 'dm': {
      const peer = users.get(msg.to);
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!peer || !text) return;
      const entry = { from: u.id, fromName: u.name, to: peer.id, text, ts: Date.now() };
      const k = dmKey(u.id, peer.id);
      if (!dmHistory.has(k)) dmHistory.set(k, []);
      const arr = dmHistory.get(k);
      arr.push(entry);
      if (arr.length > 100) arr.shift();
      send(peer.ws, { type: 'dm-msg', ...entry });
      send(ws, { type: 'dm-sent', ...entry });
      break;
    }

    case 'dm-history': {
      const k = dmKey(u.id, msg.with);
      send(ws, { type: 'dm-history', with: msg.with, messages: dmHistory.get(k) || [] });
      break;
    }

    case 'cam-invite': {
      const target = users.get(msg.to);
      if (!target) return send(ws, { type: 'error', message: 'User is offline.' });
      if (target.id === u.id) return;
      const room = makeRoom(`🔒 ${u.name} & ${target.name}`, u.id);
      joinRoom(u, room.id);
      send(target.ws, { type: 'cam-invite', from: u.id, fromName: u.name, roomId: room.id, roomName: room.name });
      break;
    }
    case 'cam-invite-accept': {
      const room = rooms.get(msg.roomId);
      if (!room) return send(ws, { type: 'error', message: 'That invite expired.' });
      joinRoom(u, room.id);
      break;
    }
    case 'cam-invite-decline': {
      const from = users.get(msg.from);
      if (from && from.ws) send(from.ws, { type: 'notice', text: `${u.name} declined your video chat invite.` });
      const room = rooms.get(msg.roomId);
      if (room) {
        let n = 0;
        for (const x of users.values()) if (x.roomId === room.id) n++;
        if (n <= 1) { rooms.delete(room.id); pushRoomList(); }
      }
      break;
    }

    case 'add-contact': {
      const targetId = nameToId.get(String(msg.name || '').toLowerCase().trim());
      if (!targetId) return send(ws, { type: 'error', message: 'No user with that nickname is online.' });
      if (targetId === u.id) return send(ws, { type: 'error', message: 'That is you.' });
      u.contacts.add(targetId);
      const t = users.get(targetId);
      send(ws, { type: 'contacts', contacts: contactList(u) });
      if (t) send(t.ws, { type: 'contact-added', id: u.id, name: u.name });
      break;
    }

    case 'remove-contact':
      u.contacts.delete(msg.id);
      send(ws, { type: 'contacts', contacts: contactList(u) });
      break;

    case 'get-contacts':
      send(ws, { type: 'contacts', contacts: contactList(u) });
      break;

    case 'mod-action':
      handleModAction(u, msg);
      break;

    case 'get-ban-list': {
      const room = rooms.get(u.roomId);
      if (!room || rankOf(room, u.id) < 2)
        return send(ws, { type: 'error', message: 'No permission.' });
      send(ws, { type: 'ban-list', bans: banList(room) });
      break;
    }

    case 'site-banner': {
      if (msg.action === 'set') {
        if (!u.siteOwner) return send(ws, { type: 'error', message: 'Only the site owner can do that.' });
        if (typeof msg.title === 'string' && msg.title.trim()) siteBanner.title = msg.title.trim().slice(0, 80);
        if (typeof msg.body === 'string' && msg.body.trim()) siteBanner.body = msg.body.trim().slice(0, 1000);
        if (typeof msg.contact === 'string') siteBanner.contact = msg.contact.trim().slice(0, 200);
        persistBanner();
        broadcastAll({ type: 'site-banner', banner: siteBanner });
      } else {
        send(ws, { type: 'site-banner', banner: siteBanner });
      }
      break;
    }

    case 'set-photo': {
      const dataUrl = String(msg.dataUrl || '');
      if (!dataUrl) {
        u.photo = null;
      } else {
        if (!/^data:image\/(jpeg|png|gif|webp)/i.test(dataUrl)) return;
        if (dataUrl.length > 500 * 1024)
          return send(ws, { type: 'error', message: 'Photo too big.' });
        u.photo = dataUrl;
      }
      if (u.roomId) broadcastRoom(u.roomId, { type: 'user-photo', id: u.id, photo: u.photo });
      break;
    }

    case 'screen-share': {
      u.sharingScreen = !!msg.sharing;
      if (u.roomId) broadcastRoom(u.roomId, { type: 'user-screen', id: u.id, sharing: u.sharingScreen }, u.id);
      break;
    }

    case 'room-settings': {
      const room = rooms.get(msg.roomId);
      if (!room || rankOf(room, u.id) < 2)
        return send(ws, { type: 'error', message: 'Only admins can change room settings.' });
      if (typeof msg.openMic === 'boolean') room.settings.openMic = msg.openMic;
      if (Number.isFinite(msg.talkLimitSec))
        room.settings.talkLimitSec = Math.max(0, Math.min(600, Math.floor(msg.talkLimitSec)));
      broadcastRoom(room.id, { type: 'room-settings-updated', settings: room.settings });
      pushRoomList();
      break;
    }

    case 'dj': {
      // { action:'start-file'|'start-url'|'stop'|'volume', url?, volume? }
      const room = rooms.get(u.roomId);
      if (!room || rankOf(room, u.id) < 1)
        return send(ws, { type: 'error', message: 'Only moderators can DJ.' });
      if (msg.action === 'stop' || msg.action === 'cut') {
        room.dj = { active: false, mode: null, url: null, volume: 1, by: null };
        broadcastRoom(room.id, { type: 'dj', action: 'stop' });
      } else if (msg.action === 'start-url') {
        const url = String(msg.url || '').slice(0, 500);
        if (!/^https?:\/\//i.test(url)) return send(ws, { type: 'error', message: 'URL must start with http(s).' });
        room.dj = { active: true, mode: 'url', url, volume: 1, by: u.name };
        broadcastRoom(room.id, { type: 'dj', action: 'start-url', url, by: u.name });
      } else if (msg.action === 'start-file') {
        // File bytes stay client-side; admin streams the track over WebRTC.
        // Server just announces it so clients expect the DJ audio track.
        room.dj = { active: true, mode: 'file', url: null, volume: 1, by: u.name };
        broadcastRoom(room.id, { type: 'dj', action: 'start-file', by: u.name }, u.id);
        send(ws, { type: 'dj', action: 'you-are-dj' });
      } else if (msg.action === 'start-tab') {
        // Tab audio (e.g. Spotify web player) captured client-side via
        // getDisplayMedia; admin streams the track over WebRTC like file mode.
        room.dj = { active: true, mode: 'tab', url: null, volume: 1, by: u.name };
        broadcastRoom(room.id, { type: 'dj', action: 'start-tab', by: u.name }, u.id);
        send(ws, { type: 'dj', action: 'you-are-dj' });
      } else if (msg.action === 'volume') {
        const v = Math.max(0, Math.min(1, Number(msg.volume)));
        room.dj.volume = v;
        broadcastRoom(room.id, { type: 'dj', action: 'volume', volume: v }, u.id);
      }
      break;
    }
  }
}

function makeRoom(name, ownerId) {
  const id = 'r' + (nextRoomId++);
  const room = { id, name, ownerId, admins: new Set(), mods: new Set(),
    bans: new Map(), ipBans: new Set(),
    settings: { openMic: false, talkLimitSec: 0 },
    dj: { active: false, mode: null, url: null, volume: 1, by: null } };
  rooms.set(id, room);
  return room;
}

function joinRoom(u, roomId) {
  const room = rooms.get(roomId);
  if (!room) return send(u.ws, { type: 'error', message: 'Room not found.' });
  if (u.roomId === roomId) return;

  // Ban checks (per-room, this session)
  const banRec = room.bans.get(u.id);
  if (banRec) return send(u.ws, { type: 'error', message: `You are banned from "${room.name}".` });
  if (u.ip && u.ip !== 'unknown' && room.ipBans.has(u.ip))
    return send(u.ws, { type: 'error', message: `Your IP is banned from "${room.name}".` });
  // Persistent global bans (survive restarts)
  if (u.ip && u.ip !== 'unknown' && gIpBans.has(u.ip))
    return send(u.ws, { type: 'error', message: 'Your IP is banned from CamWave.' });
  if (u.name && gNameBans.has(u.name.toLowerCase()))
    return send(u.ws, { type: 'error', message: 'You are banned from CamWave.' });

  if (u.roomId) doLeaveRoom(u);
  u.roomId = roomId;
  // First person into an ownerless (system) room becomes its owner.
  if (!room.ownerId) {
    room.ownerId = u.id;
    send(u.ws, { type: 'notice', text: `You are now the owner of "${room.name}".` });
  }
  u.muted = !room.settings.openMic; // PTT rooms start muted
  u.videoOn = false;
  u.talking = false;
  u.micLive = false;

  const others = roomUsers(roomId).filter(m => m.id !== u.id);
  send(u.ws, { type: 'room-joined',
    room: { id: room.id, name: room.name, settings: room.settings,
            myRole: roleOf(room, u.id), dj: room.dj },
    users: others,
    selfMuted: u.muted });
  broadcastRoom(roomId, { type: 'user-joined',
    user: { ...publicUser(u), role: roleOf(room, u.id) } }, u.id);
  pushRoomList();
}

function contactList(u) {
  const out = [];
  for (const id of u.contacts) {
    const c = users.get(id);
    out.push(c ? { id: c.id, name: c.name, status: c.status, online: true }
               : { id, name: '(offline)', status: 'offline', online: false });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WebSocket lifecycle                                                 */
/* ------------------------------------------------------------------ */

wss.on('connection', (ws, req) => {
  ws._ip = clientIp(req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => handleMessage(ws, raw));

  ws.on('close', () => {
    const u = ws._user;
    if (!u) return;
    clearTalkTimer(u);
    const roomId = u.roomId;
    if (roomId) {
      u.roomId = null; // avoid double-broadcast inside doLeaveRoom ordering
      const room = rooms.get(roomId);
      users.delete(u.id);
      nameToId.delete(u.name.toLowerCase());
      if (room) {
        broadcastRoom(roomId, { type: 'user-left', id: u.id, name: u.name, reason: 'disconnect' });
        pushRoomList();
        if (room.ownerId === u.id) {
          const members = roomUsers(roomId);
          const pick = members.find(m => room.admins.has(m.id)) ||
                       members.find(m => room.mods.has(m.id)) || members[0];
          if (pick) {
            room.ownerId = pick.id;
            room.admins.delete(pick.id); room.mods.delete(pick.id);
            broadcastRoom(roomId, { type: 'room-roles', users: roomUsers(roomId) });
            sendToUser(pick.id, { type: 'notice', text: 'You are now the room owner.' });
          }
        }
        if (roomUsers(roomId).length === 0) {
          rooms.delete(roomId);
          pushRoomList();
        }
      }
    } else {
      users.delete(u.id);
      nameToId.delete(u.name.toLowerCase());
    }
  });

  ws.on('error', () => {});
});

// Prune dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`CamWave listening on port ${PORT}`);
  loadPersistedBans();
  loadSiteBanner();
  loadTriviaScores();
});
