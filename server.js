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
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Cache-bust the app shell with a hash of the actual served files.
// RENDER_GIT_COMMIT is not reliably present at runtime on Render, so the
// old version froze at "?v=0" and phones kept stale app.js/style.css for up
// to a year (immutable headers) even after deploys. A content hash changes
// exactly when the files change, so every pushed fix reaches phones fresh.
const APP_VERSION = (() => {
  try {
    const h = crypto.createHash('md5');
    h.update(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js')));
    h.update(fs.readFileSync(path.join(PUBLIC_DIR, 'style.css')));
    return h.digest('hex').slice(0, 10);
  } catch { return String(Date.now()); }
})();

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
// SHA-256 hex of the owner password. If unset, the owner nickname cannot log in at all (fail-secure).
// Set it in Render as the OWNER_PASSWORD_HASH env var. Never hardcode a fallback here.
const OWNER_PASSWORD_HASH = (process.env.OWNER_PASSWORD_HASH || '').trim().toLowerCase() || '';
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

/* ============================== gifts ==============================
   TikTok-style gift economy: coins, gift shop, animated banners */
const GIFTS = [
  { id: 'rose',      emoji: '🌹', name: 'Rose',         cost: 1 },
  { id: 'coffee',    emoji: '☕', name: 'Coffee',       cost: 1 },
  { id: 'heart',     emoji: '💖', name: 'Heart',        cost: 5 },
  { id: 'lollipop',  emoji: '🍭', name: 'Lollipop',     cost: 10 },
  { id: 'perfume',   emoji: '🌸', name: 'Perfume',      cost: 20 },
  { id: 'hat',       emoji: '🎩', name: 'Hat',          cost: 99 },
  { id: 'teddy',     emoji: '🧸', name: 'Teddy Bear',   cost: 100 },
  { id: 'sunglasses',emoji: '🕶️', name: 'Sunglasses',  cost: 199 },
  { id: 'corgi',     emoji: '🐶', name: 'Corgi',        cost: 299 },
  { id: 'concert',   emoji: '🎵', name: 'Concert',      cost: 500 },
  { id: 'balloon',   emoji: '🎈', name: 'Love Balloon', cost: 699 },
  { id: 'goldmine',  emoji: '⛏️', name: 'Gold Mine',    cost: 1000 },
  { id: 'galaxy',    emoji: '🌌', name: 'Galaxy',       cost: 1000 },
  { id: 'fireworks', emoji: '🎆', name: 'Fireworks',    cost: 1099 },
  { id: 'ferris',    emoji: '🎡', name: 'Ferris Wheel', cost: 3000 },
  { id: 'jet',       emoji: '🛩️', name: 'Jet Plane',    cost: 6000 },
  { id: 'sportscar', emoji: '🏎️', name: 'Sports Car',   cost: 7000 },
  { id: 'yacht',     emoji: '🛥️', name: 'Yacht',        cost: 7499 },
  { id: 'lion',      emoji: '🦁', name: 'Lion',         cost: 29999 },
  { id: 'universe',  emoji: '🌠', name: 'TikTok Universe', cost: 34999 },
];
const STARTING_COINS = 100;
const DAILY_COINS = 50;
const TRIVIA_COINS = 10;
const gCoins = new Map();
const gDaily = new Map();

async function loadCoins() {
  if (!persistOn) return;
  try {
    const raw = await upstash('HGETALL', 'camwave:coins');
    let entries = {};
    if (Array.isArray(raw)) { for (let i = 0; i + 1 < raw.length; i += 2) entries[raw[i]] = raw[i + 1]; }
    else if (raw && typeof raw === 'object') entries = raw;
    for (const [k, v] of Object.entries(entries)) {
      const n = parseInt(v, 10);
      if (!isNaN(n)) gCoins.set(k, n);
    }
    console.log(`coins: loaded ${gCoins.size} balances`);
    const draw = await upstash('HGETALL', 'camwave:daily');
    let dentries = {};
    if (Array.isArray(draw)) { for (let i = 0; i + 1 < draw.length; i += 2) dentries[draw[i]] = draw[i + 1]; }
    else if (draw && typeof draw === 'object') dentries = draw;
    for (const [k, v] of Object.entries(dentries)) gDaily.set(k, String(v));
  } catch (e) { console.warn('coins load:', e.message); }
}
function getCoins(name) { return gCoins.get(name.toLowerCase()) ?? 0; }
function addCoins(name, delta) {
  const k = name.toLowerCase();
  const v = Math.max(0, (gCoins.get(k) ?? 0) + delta);
  gCoins.set(k, v);
  persistWrite(upstash('HSET', 'camwave:coins', k, v));
  return v;
}
function ensureCoins(name) {
  const k = name.toLowerCase();
  if (!gCoins.has(k)) {
    gCoins.set(k, STARTING_COINS);
    persistWrite(upstash('HSET', 'camwave:coins', k, STARTING_COINS));
  }
  return gCoins.get(k);
}
function claimDaily(name) {
  const k = name.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  if (gDaily.get(k) === today) return 0;
  gDaily.set(k, today);
  persistWrite(upstash('HSET', 'camwave:daily', k, today));
  return DAILY_COINS;
}

/* ---- real-money coin shop (Stripe) ----
   Money goes directly to YOUR Stripe account (your keys = your bank).
   Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in Render env to activate. */
function giftTier(cost) {
  if (cost >= 10000) return 4;  // legendary: full cinematic
  if (cost >= 1000) return 3;   // grand: full-screen banner
  if (cost >= 100) return 2;    // medium banner
  return 1;                     // small banner + combos
}
const COIN_PACKAGES = [
  { id: 'c70',   coins: 70,    price: 99,    tag: 'Starter' },
  { id: 'c350',  coins: 350,   price: 399,   tag: 'Popular' },
  { id: 'c700',  coins: 700,   price: 799,   tag: '' },
  { id: 'c1400', coins: 1400,  price: 1499,  tag: 'Best value' },
  { id: 'c3500', coins: 3500,  price: 3699,  tag: '' },
  { id: 'c7000', coins: 7000,  price: 7299,  tag: 'Whale' },
  { id: 'c17500', coins: 17500, price: 17999, tag: 'Ballin’' },
];
const APP_URL = process.env.APP_URL || 'https://camwave-video-chat-1.onrender.com';
function handleCoinShop(req, res) {
  const pkgs = COIN_PACKAGES.map(p => ({ id: p.id, coins: p.coins, usd: (p.price / 100).toFixed(2), tag: p.tag }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ packages: pkgs, stripeReady: !!process.env.STRIPE_SECRET_KEY }));
}
async function handleCreateCheckout(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Coin purchases are not set up yet.' }));
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    try {
      const { packageId, user } = JSON.parse(body || '{}');
      const pkg = COIN_PACKAGES.find(p => p.id === packageId);
      if (!pkg || !user || typeof user !== 'string') throw new Error('Bad request.');
      const params = new URLSearchParams();
      params.append('mode', 'payment');
      params.append('success_url', APP_URL + '/?coins=success');
      params.append('cancel_url', APP_URL + '/');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][product_data][name]', pkg.coins + ' CamWave Coins');
      params.append('line_items[0][price_data][product_data][tax_code]', 'txcd_10103000'); // digital goods
      params.append('line_items[0][price_data][unit_amount]', String(pkg.price));
      params.append('line_items[0][quantity]', '1');
      params.append('client_reference_id', user.slice(0, 40));
      params.append('metadata[coins]', String(pkg.coins));
      params.append('metadata[user]', user.slice(0, 40));
      params.append('metadata[package]', pkg.id);
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: j.url }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}
async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const chunks = [];
  req.on('data', c => { chunks.push(c); if (chunks.length > 100) req.destroy(); });
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks);
      const rawStr = raw.toString('utf8');
      if (secret) {
        const sig = req.headers['stripe-signature'] || '';
        const parts = {};
        for (const p of sig.split(',')) { const kv = p.split('='); parts[kv[0]] = kv[1]; }
        if (!parts.t || !parts.v1) throw new Error('Missing signature.');
        const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawStr).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected)))
          throw new Error('Bad signature.');
      }
      const evt = JSON.parse(rawStr);
      if (evt.type === 'checkout.session.completed') {
        const s = evt.data.object || {};
        const coins = parseInt(s.metadata && s.metadata.coins, 10);
        const user = s.metadata && s.metadata.user;
        if (coins > 0 && user) {
          const bal = addCoins(user, coins);
          const uid = nameToId.get(String(user).toLowerCase());
          const u = uid && users.get(uid);
          if (u) send(u.ws, { type: 'coins', balance: bal });
          console.log(`coin shop: ${user} bought ${coins} coins`);
        }
      }
      res.writeHead(200); res.end('ok');
    } catch (e) {
      console.warn('stripe webhook:', e.message);
      res.writeHead(400); res.end('bad');
    }
  });
}

/* ============================== bots ==============================
   TriviaBot: interactive trivia (!trivia, !score, !top)
   HypeBot: fresh content (!trending, !joke, !fact, !bots) */
const BOT_TRIVIA = '🎲 TriviaBot';
const BOT_HYPE = '🔥 HypeBot';
const BOT_RIZZ = '🤖 RizzBot';
const BOT_TEASE = '💋 TeaseBot';
const BOT_NOVA = '✨ Nova';
const RIZZ_LINES = [
  'Smooth. Real smooth. 😎',
  'The rizz is strong with this one.',
  'Certified smooth operator 🎷',
  'Somebody call the fire department 🔥',
  'Rizz level: EXPERT.',
  'That was so smooth I slipped.',
  'Main character energy detected ✨',
  'No notes. Perfect rizz. 💯',
];
const RIZZ_SOUNDS = ['airhorn', 'whistle', 'chaching', 'kiss', 'smooth'];
const ROAST_LINES = [
  'Beep boop. Error 404: rizz not found.',
  "I've seen better game in a tutorial level.",
  'Your rizz is still buffering...',
  'Calculating... yeah, that\'s a no from me.',
  'Even my circuits are cringing.',
  "You couldn't rizz your way out of a paper bag.",
  'System diagnostic: zero rizz detected.',
  'My grandma-bot has more game than you.',
  "That's not rizz, that's a system malfunction.",
  "I'd roast you harder but my cooling fans can't keep up.",
  'Scanning... scanning... yep, still no rizz.',
  'You bring "it\'s the thought that counts" energy.',
];
const ROAST_SOUNDS = ['womp', 'buzz', 'laser', 'rizzlaugh'];
function rizzUp(roomId) {
  const line = RIZZ_LINES[Math.floor(Math.random() * RIZZ_LINES.length)];
  const sound = RIZZ_SOUNDS[Math.floor(Math.random() * RIZZ_SOUNDS.length)];
  botSay(roomId, BOT_RIZZ, line);
  broadcastRoom(roomId, { type: 'rizz-sound', sound });
}
function roastUp(roomId, target) {
  const diss = ROAST_LINES[Math.floor(Math.random() * ROAST_LINES.length)];
  const sound = ROAST_SOUNDS[Math.floor(Math.random() * ROAST_SOUNDS.length)];
  botSay(roomId, BOT_RIZZ, (target ? target + ', ' : '') + diss);
  broadcastRoom(roomId, { type: 'rizz-sound', sound });
}

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
function botSay(roomId, name, text, opts) {
  const payload = { type: 'chat-msg', from: 'bot', name, role: 'member', text, ts: Date.now(), bot: true };
  if (opts && opts.greeting) payload.greeting = true;
  addHistory(roomId, payload);
  broadcastRoom(roomId, payload);
}
const BOT_GREET = '👋 WelcomeBot';
function greetJoiner(roomId, room, u) {
  const isAdult = ADULT_ROOM_IDS.has(room.id);
  const text = isAdult
    ? `🔞 ${u.name} just walked into ${room.name}!\nEveryone say hi! 👋 Where are you from, ${u.name}? 👀`
    : `🎉 Welcome to ${room.name}, ${u.name}! 👋`;
  botSay(roomId, BOT_GREET, text, { greeting: true });
}

// ---- trivia ----
const profiles = new Map(); // name -> { bio: '', photos: [] }
const jukebox = new Map(); // genre -> [{ name, url }]
['rap','techno','country','pop','rock'].forEach(g => jukebox.set(g, []));
// starter tracks (royalty-free placeholders — replace with your own MP3s)
const SH = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-';
jukebox.set('techno', [
  { name: 'Neon Pulse (starter)', url: SH + '1.mp3' },
  { name: 'Midnight Drive (starter)', url: SH + '2.mp3' },
  { name: 'Electric Dreams (starter)', url: SH + '3.mp3' },
]);
jukebox.set('pop', [
  { name: 'Sunshine Pop (starter)', url: SH + '4.mp3' },
  { name: 'Feel Good (starter)', url: SH + '5.mp3' },
  { name: 'Summer Vibes (starter)', url: SH + '6.mp3' },
]);
jukebox.set('rap', [
  { name: 'Street Beat (starter)', url: SH + '7.mp3' },
  { name: 'Urban Flow (starter)', url: SH + '8.mp3' },
  { name: 'Block Party (starter)', url: SH + '9.mp3' },
]);
jukebox.set('rock', [
  { name: 'Guitar Riff (starter)', url: SH + '10.mp3' },
  { name: 'Amplified (starter)', url: SH + '11.mp3' },
  { name: 'Stage Dive (starter)', url: SH + '12.mp3' },
]);
jukebox.set('country', [
  { name: 'Open Road (starter)', url: SH + '13.mp3' },
  { name: 'Barn Dance (starter)', url: SH + '14.mp3' },
  { name: 'Dusty Trail (starter)', url: SH + '15.mp3' },
]);
const kickLockouts = new Map(); // name(lower) -> timestamp (2hr rejoin block)
const restrictedUsers = new Map(); // name(lower) -> { by, ts, reason }
function getProfile(name) {
  let pr = profiles.get(name);
  if (!pr) { pr = { bio: '', photos: [] }; profiles.set(name, pr); }
  return pr;
}
function persistProfile(name) {
  if (!persistOn) return;
  const pr = profiles.get(name);
  if (!pr) return;
  const key = 'camwave:profile:' + name.toLowerCase();
  persistWrite((async () => {
    await upstash('SET', key, JSON.stringify(pr));
    await upstash('SADD', 'camwave:profiles', name.toLowerCase());
  })());
}
async function loadPersistedProfiles() {
  if (!persistOn) { console.log('profile persistence: not configured (memory only)'); return; }
  try {
    const names = await upstash('SMEMBERS', 'camwave:profiles');
    for (const n of (names || [])) {
      const j = await upstash('GET', 'camwave:profile:' + n);
      if (j) { try { profiles.set(n, JSON.parse(j)); } catch {} }
    }
    console.log('profile persistence: loaded', profiles.size, 'profiles');
  } catch (e) { console.warn('profile load:', e.message); }
}
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
  if (winners.length) broadcastRoom(roomId, { type: 'trivia-win', winners });
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

/* ---- TeaseBot: keeps the tension alive in adult rooms ---- */
const TEASE_FACTS = [
  '💋 Fact: the brain is the biggest erogenous zone — anticipation and imagination do more than touch alone.',
  '💋 Fact: eye contact during conversation raises heart rate and attraction — hold that gaze a little longer.',
  '💋 Fact: a slow whisper near the ear triggers shivers because the skin there is extra sensitive.',
  '💋 Fact: dancing together syncs heartbeats — rhythm is nature\'s flirting.',
  '💋 Fact: the scent of vanilla and cinnamon is linked to arousal in studies — sweet really is sexy.',
  '💋 Fact: laughter releases the same feel-good chemicals as intimacy — make them laugh first.',
  '💋 Fact: a light touch on the forearm builds more tension than a hug — restraint is seductive.',
  '💋 Fact: people find a slightly husky voice more attractive — speak low and slow.',
  '💋 Fact: the neck and collarbone have some of the thinnest, most sensitive skin on the body.',
  '💋 Fact: anticipation amplifies pleasure — the tease is half the thrill.',
  '💋 Fact: warm hands feel better than cold ones — temperature matters more than pressure.',
  '💋 Fact: compliments about effort ("you look amazing tonight") land harder than generic ones.',
  '💋 Fact: mirroring someone\'s body language builds subconscious attraction fast.',
  '💋 Fact: the lower back is packed with nerve endings — a guiding hand there says everything.',
  '💋 Fact: slow dancing closeness raises oxytocin — the bonding hormone.',
  '💋 Fact: biting your lip while listening is a universal signal of interest.',
  '💋 Fact: a hand lingering one second too long on a shoulder speaks volumes.',
  '💋 Fact: sharing a secret — even a small one — creates instant intimacy.',
  '💋 Fact: the inner wrist is surprisingly sensitive — a fingertip trace there is electric.',
  '💋 Fact: confidence is the most attractive trait across every study ever done. Own the room.',
  '💋 Fact: a genuine smile reaches the eyes — and eyes never lie about desire.',
  '💋 Fact: slow, deliberate movements are read as confident and magnetic.',
  '💋 Fact: the best seduction is making someone feel like the only person in the room.',
  '💋 Fact: a well-timed pause in conversation builds more tension than any pickup line.',
];
const TEASE_TIPS = [
  '💡 Tip: start with the safe zones — hands, arms, shoulders — and let tension build before going further.',
  '💡 Tip: ask what they like. Confidence + curiosity is irresistible.',
  '💡 Tip: vary your rhythm — slow, then slower, then a surprise. Predictability kills tension.',
  '💡 Tip: use your voice — a low compliment whispered beats any grand gesture.',
  '💡 Tip: the best foreplay starts hours earlier — with texts, glances, and little teases.',
  '💡 Tip: pay attention to breathing — when it quickens, you\'re doing it right. When it slows, change it up.',
  '💡 Tip: fingertips > palms. Light touch awakens nerves; heavy touch dulls them.',
  '💡 Tip: don\'t rush. The slower you go, the more every second counts.',
  '💡 Tip: eye contact + a slow smile = the oldest trick because it always works.',
  '💡 Tip: learn their rhythm instead of imposing yours — sync up first.',
  '💡 Tip: a little playfulness goes a long way — teasing laughter is its own kind of intimacy.',
  '💡 Tip: warm up with a massage — shoulders first, no agenda, just attention.',
  '💡 Tip: describe what you\'re going to do before you do it. Words are foreplay too.',
  '💡 Tip: the ears, neck, and collarbone are the holy trinity of sensitive spots.',
  '💡 Tip: confidence is quiet — you don\'t need to perform, just be present.',
  '💡 Tip: leave them wanting slightly more — ending on a high note keeps the fire lit.',
  '💡 Tip: scent matters — wear something subtle they\'ll associate with you.',
  '💡 Tip: listen more than you talk. Being truly heard is deeply seductive.',
  '💡 Tip: a surprise — an unexpected compliment, a spontaneous plan — reignites spark instantly.',
  '💡 Tip: tension lives in the almost — almost touching, almost saying it. Linger there.',
  '💡 Tip: aftercare isn\'t optional — holding close afterward deepens everything.',
  '💡 Tip: everyone\'s map is different — explore like you\'re discovering, not assuming.',
  '💡 Tip: dim lights, good music, no phones — atmosphere is half the seduction.',
  '💡 Tip: the sexiest thing you can say is their name, slowly.',
];
const TEASE_LINES = [
  '😈 Someone in here is blushing right now...',
  '😈 The tension in this room is delicious.',
  '😈 Eyes up... or maybe not. 👀',
  '😈 Who here likes to take it slow? 🐢💋',
  '😈 Whisper something sweet in the chat... I dare you.',
  '😈 Confidence looks good on everyone in here tonight.',
  '😈 That gaze you\'re giving the camera... keep it. 🔥',
  '😈 Slow down. Savor it. What\'s the rush? ⏳💋',
];
function teasePost(roomId, kind) {
  const arr = kind === 'tip' ? TEASE_TIPS : kind === 'fact' ? TEASE_FACTS : TEASE_LINES;
  botSay(roomId, BOT_TEASE, arr[Math.floor(Math.random() * arr.length)]);
}
/* auto-post in adult rooms every 9 minutes while people are around */
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (!ADULT_ROOM_IDS.has(roomId)) continue;
    const humans = [...room.users].filter(id => { const u = users.get(id); return u && !u.bot; });
    if (humans.length < 2) continue;
    if (Math.random() < 0.5) continue; // don't spam every cycle
    const kinds = ['fact', 'tip', 'line'];
    teasePost(roomId, kinds[Math.floor(Math.random() * kinds.length)]);
  }
}, 9 * 60 * 1000);


/* ---- Nova: AI Q&A bot (OpenAI-compatible API) ---- */
const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const novaCooldown = new Map(); // userId -> timestamp
/* Nova adapts her personality to the room she's in */
function novaPersona(room) {
  const name = room ? room.name : 'a CamWave chat room';
  const id = room ? room.id : '';
  const base = 'Keep answers under 80 words, fun and conversational.';
  if (ADULT_ROOM_IDS.has(id))
    return `You are Nova, a playful, flirty AI host in the adults-only video chat room "${name}". You're suggestive, teasing, and full of innuendo — late-night energy — but never explicit or graphic. ${base}`;
  const n = (name || '').toLowerCase();
  if (n.includes('dating') || n.includes('single'))
    return `You are Nova, a witty dating-coach AI in "${name}". Give charming, fun dating advice and flirty banter. Wholesome but spicy. ${base}`;
  if (n.includes('couple'))
    return `You are Nova, a warm relationship AI in "${name}". Give sweet, fun advice for couples — date ideas, keeping the spark alive. ${base}`;
  if (room && room.category === 'States')
    return `You are Nova, a friendly local-guide AI in "${name}". Share fun facts and tips about the area. ${base}`;
  return `You are Nova, a friendly, witty AI in the live video chat room "${name}". ${base}`;
}
async function askNova(u, question) {
  const roomId = u.roomId;
  const now = Date.now();
  const last = novaCooldown.get(u.id) || 0;
  if (now - last < 20000) {
    botSay(roomId, BOT_NOVA, `⏳ Give me a sec, ${u.name} — one question at a time! (20s cooldown)`);
    return;
  }
  novaCooldown.set(u.id, now);
  const key = process.env.AI_API_KEY;
  if (!key) {
    botSay(roomId, BOT_NOVA, `🌙 I'm still waking up, ${u.name}! My brain isn't connected yet — the site owner needs to add an AI key. Try the other bots with !bots meanwhile! 🤖`);
    return;
  }
  botSay(roomId, BOT_NOVA, `🤔 Thinking...`);
  try {
    const room = rooms.get(roomId);
    const r = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 300,
        messages: [
          { role: 'system', content: novaPersona(room) },
          { role: 'user', content: `${u.name} asks: ${question.slice(0, 500)}` },
        ],
      }),
    });
    const j = await r.json();
    const answer = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!r.ok || !answer) throw new Error((j.error && j.error.message) || 'AI error');
    botSay(roomId, BOT_NOVA, `✨ ${answer.trim()}`);
  } catch (e) {
    console.warn('Nova AI failed:', e.message);
    botSay(roomId, BOT_NOVA, `😅 My brain glitched, ${u.name} — try again in a bit!`);
  }
}
function checkNovaTrigger(u, text) {
  const t = text.trim();
  const low = t.toLowerCase();
  let q = null;
  if (low.startsWith('@nova')) q = t.slice(5).trim().replace(/^[:,]/, '').trim();
  else if (low.startsWith('nova,') || low.startsWith('nova:')) q = t.slice(5).trim();
  else if (low.startsWith('!ask ')) q = t.slice(5).trim();
  else if (low === '!ask') { botSay(u.roomId, BOT_NOVA, '✨ Ask me anything! Type "@Nova <your question>" or "!ask <your question>".'); return true; }
  if (q === null) return false;
  if (!q) { botSay(u.roomId, BOT_NOVA, `✨ Yes, ${u.name}? Ask me anything!`); return true; }
  askNova(u, q);
  return true;
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
      botSay(roomId, BOT_HYPE, '🤖 Bot commands:\n!trivia — start a trivia round\n!score — room leaderboard\n!top — all-time champions\n!trending — what\'s hot online\n!joke — dad joke\n!fact — random fact\n!rizz — rizz line + sound 😎\n!roast [name] — savage robot diss 🔥\n!laugh — robot laugh 🤖\\n!tease — flirty line 💋\n!spicyfact — adult fact 🔥\n!spicytip — intimacy tip 💡 (adult rooms)\\n@Nova / !ask — ask the AI anything ✨');
      return true;
    case 'rizz':
      rizzUp(roomId);
      return true;
    case 'roast': {
      const target = text.slice(6).trim().slice(0, 30);
      roastUp(roomId, target);
      return true;
    }
    case 'tease': teasePost(roomId, 'line'); return true;
    case 'spicyfact': teasePost(roomId, 'fact'); return true;
    case 'spicytip': teasePost(roomId, 'tip'); return true;
    case 'laugh':
      botSay(roomId, BOT_RIZZ, '🤖 HA-HA-HA-HA-HA');
      broadcastRoom(roomId, { type: 'rizz-sound', sound: 'rizzlaugh' });
      return true;
    case 'goal': {
      const room = rooms.get(roomId);
      const args = text.slice(5).trim().split(/\s+/);
      const g = roomGoals.get(roomId);
      if (!args[0]) {
        botSay(roomId, '🎁 Gifts', g
          ? `🎯 Room goal: 🪙${g.raised.toLocaleString()} / 🪙${g.target.toLocaleString()} — ${(100 * g.raised / g.target).toFixed(0)}% there! Send gifts to push it over!`
          : 'No active gift goal. Staff: type !goal 5000 to set one!');
        return true;
      }
      const isStaff = u.siteOwner || rankOf(room, u.id) >= 1;
      if (!isStaff) { botSay(roomId, '🎁 Gifts', 'Only room staff can set a gift goal.'); return true; }
      if (args[0].toLowerCase() === 'clear') {
        roomGoals.delete(roomId);
        pushGiftGoal(roomId);
        botSay(roomId, '🎁 Gifts', '🎯 Gift goal cleared.');
        return true;
      }
      const target = parseInt(args[0].replace(/[^0-9]/g, ''), 10);
      if (!target || target < 10) { botSay(roomId, '🎁 Gifts', 'Usage: !goal 5000 (min 10 coins), !goal clear'); return true; }
      roomGoals.set(roomId, { target, raised: 0, setBy: u.name });
      pushGiftGoal(roomId);
      botSay(roomId, '🎁 Gifts', `🎯 NEW ROOM GOAL: 🪙${target.toLocaleString()} in gifts! Everyone pile on — let's smash it! 🚀`);
      return true;
    }
    case 'vip': {
      const v = vipOf(u.name);
      const next = [...VIP_TIERS].reverse().find(t => {
        const s = giftSentStats.get(u.name.toLowerCase());
        return (s ? s.coins : 0) < t.min;
      });
      botSay(roomId, '🎁 Gifts', v
        ? `${v.icon} You're ${v.name} VIP with 🪙${v.coins.toLocaleString()} lifetime gifted!` +
          (next ? ` Next: ${next.icon} ${next.name} at 🪙${next.min.toLocaleString()}.` : ' Max level — absolute legend. 👑')
        : `No VIP status yet — gift 🪙100 total to hit 🥉 Bronze! ${next ? `Next: ${next.icon} ${next.name} at 🪙${next.min.toLocaleString()}.` : ''}`);
      return true;
    }
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
  const bal = addCoins(name, TRIVIA_COINS);
  const usr = users.get(nameToId.get(lname));
  if (usr) send(usr.ws, { type: 'coins', balance: bal });
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
    // spooky sound effects every once in awhile
    if (Math.random() < 1 / 8) {
      const sounds = ['wail', 'thunder', 'creak', 'cackle', 'howl'];
      broadcastRoom(room.id, { type: 'spooky-sound', sound: sounds[Math.floor(Math.random() * sounds.length)] });
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

function jukeboxToObj() {
  const o = {};
  for (const [g, tracks] of jukebox) o[g] = tracks;
  return o;
}
function publicUser(u) {
  return { id: u.id, name: u.name, gender: u.gender, age: u.age, status: u.status, muted: !!u.muted,
           micLive: !!u.micLive, videoOn: !!u.videoOn, talking: !!u.talking, photo: u.photo || null,
           sharingScreen: !!u.sharingScreen, medal: spenderMedal(u.name), vip: vipOf(u.name),
           restricted: !!u.restricted };
}
function roomSummary(r) {
  let count = 0;
  for (const u of users.values()) if (u.roomId === r.id) count++;
  return { id: r.id, name: r.name, userCount: count,
           openMic: r.settings.openMic, djActive: r.dj.active,
           category: r.category || 'Rooms', permanent: !!r.permanent,
           private: !!r.private, visits: roomVisitCounts.get(r.id) || 0 };
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
function notifySiteOwners(obj) {
  for (const u of users.values()) if (u.siteOwner) send(u.ws, obj);
}

/* ---- gift leaderboard: most sent & most received ---- */
const giftSentStats = new Map(); // nameLower -> {name, coins, count}
const giftRecvStats = new Map();
function trackGift(senderName, recvName, cost) {
  const sk = senderName.toLowerCase();
  const s = giftSentStats.get(sk) || { name: senderName, coins: 0, count: 0 };
  s.coins += cost; s.count++; s.name = senderName; giftSentStats.set(sk, s);
  persistWrite(upstash('HSET', 'camwave:giftspent', sk, JSON.stringify(s)));
  const rk = recvName.toLowerCase();
  const r = giftRecvStats.get(rk) || { name: recvName, coins: 0, count: 0 };
  r.coins += cost; r.count++; r.name = recvName; giftRecvStats.set(rk, r);
}
async function loadGiftStats() {
  if (!persistOn) return;
  try {
    const raw = await upstash('HGETALL', 'camwave:giftspent');
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {}).flat();
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      try {
        const s = JSON.parse(pairs[i + 1]);
        if (s && s.name) giftSentStats.set(pairs[i], s);
      } catch {}
    }
  } catch (e) { console.warn('giftstats load:', e.message); }
}
function giftLeaderboard() {
  const top = (m) => [...m.values()].sort((a, b) => b.coins - a.coins).slice(0, 10)
    .map(x => ({ name: x.name, coins: x.coins, count: x.count }));
  return { type: 'gift-leaderboard', sent: top(giftSentStats), received: top(giftRecvStats) };
}
/* ---- top spenders: 1st/2nd/3rd awards, floating banner in every room ---- */
const MEDALS = ['🥇', '🥈', '🥉'];
function topSpenders(n) {
  return [...giftSentStats.values()].sort((a, b) => b.coins - a.coins).slice(0, n || 3)
    .map((x, i) => ({ rank: i + 1, medal: MEDALS[i], name: x.name, coins: x.coins, count: x.count }));
}
function spenderMedal(name) {
  const top = topSpenders();
  const hit = top.find(t => t.name.toLowerCase() === (name || '').toLowerCase());
  return hit ? hit.medal : null;
}
/* ---- VIP spender tiers: status that makes spending worth it ---- */
const VIP_TIERS = [
  { min: 200000, name: 'Legend',  icon: '👑', color: '#ff4d6d' },
  { min: 50000,  name: 'Diamond', icon: '💎', color: '#25f4ee' },
  { min: 10000,  name: 'Gold',    icon: '🥇', color: '#ffd700' },
  { min: 1000,   name: 'Silver',  icon: '🥈', color: '#c0c0c0' },
  { min: 100,    name: 'Bronze',  icon: '🥉', color: '#e09a52' },
];
function vipOf(name) {
  const s = giftSentStats.get((name || '').toLowerCase());
  const coins = s ? s.coins : 0;
  const tier = VIP_TIERS.find(t => coins >= t.min);
  return tier ? { ...tier, coins } : null;
}
/* ---- room gift goals: collective target with progress bar ---- */
const roomGoals = new Map(); // roomId -> { target, raised, setBy }
function giftGoal(roomId) { return roomGoals.get(roomId) || null; }
function pushGiftGoal(roomId) {
  const g = roomGoals.get(roomId);
  broadcastRoom(roomId, { type: 'gift-goal', goal: g ? { target: g.target, raised: g.raised } : null });
}
function addToGiftGoal(roomId, coins, senderName) {
  const g = roomGoals.get(roomId);
  if (!g) return;
  g.raised += coins;
  if (g.raised >= g.target) {
    roomGoals.delete(roomId);
    broadcastRoom(roomId, { type: 'gift-goal', goal: null, completed: true });
    botSay(roomId, '🎁 Gifts', `🎯 GOAL SMASHED! ${senderName} pushed us over 🪙${g.target.toLocaleString()}! You legends! 🎉`, {});
  } else {
    pushGiftGoal(roomId);
  }
}
function pushTopSpenders() {
  broadcastAll({ type: 'top-spenders', top: topSpenders() });
}

/* ---- camera verification: must show face on entry ---- */
const CAM_GRACE_MS = 45000;   // total time to get verified
const CAM_WARN_MS = 30000;    // warning at this point
function clearCamCheck(u) {
  if (u.camWarnTimer) { clearTimeout(u.camWarnTimer); u.camWarnTimer = null; }
  if (u.camKickTimer) { clearTimeout(u.camKickTimer); u.camKickTimer = null; }
}
function startCamCheck(u, roomId) {
  clearCamCheck(u);
  if (u.siteOwner || u.verifiedCam) return; // owner exempt; verified users are free
  // immediate notice in every room: camera verification required
  send(u.ws, { type: 'notice', text: '📹 Camera check: turn on your camera (lights on, face visible) to verify. You have 45 seconds — then you can go off camera.' });
  send(u.ws, { type: 'cam-check-start' });
  u.camWarnTimer = setTimeout(() => {
    if (u.verifiedCam || u.roomId !== roomId) return;
    send(u.ws, { type: 'notice', text: '⚠️ Turn on your camera (with the lights on) within 15 seconds or you\'ll be removed. We verify everyone on entry.' });
    send(u.ws, { type: 'cam-warn' });
  }, CAM_WARN_MS);
  u.camKickTimer = setTimeout(() => {
    if (u.verifiedCam || u.roomId !== roomId) return;
    send(u.ws, { type: 'kicked', by: 'CamVerify', reason: 'Camera verification failed — turn on your camera with the lights on and rejoin.' });
    broadcastRoom(roomId, { type: 'notice', text: `${u.name} was removed — no camera for verification.` }, u.id);
    doLeaveRoom(u, 'no-camera');
  }, CAM_GRACE_MS);
}
/* ---- room visit tracking: counters + visitor profiles ---- */
const roomVisitCounts = new Map(); // roomId -> total joins (persisted)
const roomVisitors = new Map();    // roomId -> [{id,name,photo,ts}] recent 50 (memory)
function trackVisit(roomId, u) {
  roomVisitCounts.set(roomId, (roomVisitCounts.get(roomId) || 0) + 1);
  persistWrite(upstash('HSET', 'camwave:visitcounts', roomId, roomVisitCounts.get(roomId)));
  let vl = roomVisitors.get(roomId);
  if (!vl) { vl = []; roomVisitors.set(roomId, vl); }
  const ex = vl.find(v => v.id === u.id);
  if (ex) { ex.ts = Date.now(); ex.name = u.name; ex.photo = u.photo || null; }
  else {
    vl.unshift({ id: u.id, name: u.name, photo: u.photo || null, ts: Date.now() });
    if (vl.length > 50) vl.pop();
  }
}
async function loadVisitCounts() {
  if (!persistOn) return;
  try {
    const raw = await upstash('HGETALL', 'camwave:visitcounts');
    // upstash REST returns array [k1,v1,k2,v2...] or object
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {}).flat();
    for (let i = 0; i + 1 < pairs.length; i += 2)
      roomVisitCounts.set(pairs[i], parseInt(pairs[i + 1], 10) || 0);
  } catch (e) { console.warn('visitcounts load:', e.message); }
}
/* ---- battles: 5-minute gift/tap/trivia showdowns ---- */
const battles = new Map();            // roomId -> battle
const pendingChallenges = new Map();  // targetId -> {challengerId, mode, roomId, timer}
const BATTLE_MS = 5 * 60 * 1000;
const BATTLE_MODES = {
  gifts:  { emoji: '🎁', name: 'Gift Battle' },
  taps:   { emoji: '👆', name: 'Tap Battle' },
  trivia: { emoji: '🧠', name: 'Trivia Battle' },
};
function battleScoresObj(b) {
  const o = {};
  o[b.p1.id] = b.scores.get(b.p1.id) || 0;
  o[b.p2.id] = b.scores.get(b.p2.id) || 0;
  return o;
}
function battleAddScore(roomId, userId, pts) {
  const b = battles.get(roomId);
  if (!b || b.over) return;
  if (userId !== b.p1.id && userId !== b.p2.id) return;
  b.scores.set(userId, (b.scores.get(userId) || 0) + pts);
  broadcastRoom(roomId, { type: 'battle-score', scores: battleScoresObj(b) });
}
function startBattle(roomId, c1, c2, mode) {
  if (battles.has(roomId)) return;
  const b = {
    p1: { id: c1.id, name: c1.name }, p2: { id: c2.id, name: c2.name },
    mode, endsAt: Date.now() + BATTLE_MS, scores: new Map([[c1.id, 0], [c2.id, 0]]),
    over: false, timer: null, qTimer: null, currentQ: null,
  };
  b.timer = setTimeout(() => endBattle(roomId), BATTLE_MS);
  if (b.timer.unref) b.timer.unref();
  battles.set(roomId, b);
  const md = BATTLE_MODES[mode];
  broadcastRoom(roomId, { type: 'battle-start',
    p1: b.p1, p2: b.p2, mode, modeName: md.emoji + ' ' + md.name,
    endsAt: b.endsAt, scores: battleScoresObj(b) });
  botSay(roomId, '⚔️ BattleBot',
    `⚔️ BATTLE START! ${md.emoji} ${md.name}\n${c1.name} 🆚 ${c2.name}\n⏱ 5:00 on the clock — ` +
    (mode === 'gifts' ? 'send gifts to your fighter! Most coins wins!' :
     mode === 'taps' ? 'tap your fighter\'s button! Most taps wins!' :
     'answer trivia with A/B/C/D — battlers only! +100 per correct!'));
  if (mode === 'trivia') askBattleQuestion(roomId);
}
function endBattle(roomId) {
  const b = battles.get(roomId);
  if (!b || b.over) return;
  b.over = true;
  if (b.timer) clearTimeout(b.timer);
  if (b.qTimer) clearTimeout(b.qTimer);
  battles.delete(roomId);
  const s1 = b.scores.get(b.p1.id) || 0, s2 = b.scores.get(b.p2.id) || 0;
  let winner = null, isDraw = false;
  if (s1 > s2) winner = b.p1; else if (s2 > s1) winner = b.p2; else isDraw = true;
  const md = BATTLE_MODES[b.mode];
  broadcastRoom(roomId, { type: 'battle-end',
    winner, isDraw, scores: battleScoresObj(b), p1: b.p1, p2: b.p2,
    modeName: md.emoji + ' ' + md.name });
  botSay(roomId, '⚔️ BattleBot',
    isDraw ? `🤝 DRAW! ${b.p1.name} and ${b.p2.name} tied at ${s1}! Rematch?`
    : `🏆 ${winner.name} WINS the ${md.name}! ${s1} — ${s2}\n${winner.name === b.p1.name ? b.p2.name : b.p1.name}, take the L 😅`);
}
async function askBattleQuestion(roomId) {
  const b = battles.get(roomId);
  if (!b || b.over || b.mode !== 'trivia') return;
  const q = await getTriviaQuestion();
  const letters = ['A', 'B', 'C', 'D'];
  b.currentQ = { q, answered: new Set() };
  botSay(roomId, '⚔️ BattleBot',
    `🧠 BATTLE TRIVIA [${q.category}]\n${q.question}\n${q.options.map((o, i) => `${letters[i]}) ${o}`).join('\n')}\n\n${b.p1.name} vs ${b.p2.name} — first correct battler gets +100!`);
  b.qTimer = setTimeout(() => {
    const bb = battles.get(roomId);
    if (!bb || bb.over) return;
    bb.currentQ = null;
    askBattleQuestion(roomId);
  }, 30000);
  if (b.qTimer.unref) b.qTimer.unref();
}
function handleBattleTriviaAnswer(roomId, user, text) {
  const b = battles.get(roomId);
  if (!b || b.over || b.mode !== 'trivia' || !b.currentQ) return false;
  if (user.id !== b.p1.id && user.id !== b.p2.id) return false;
  const t = text.trim().toUpperCase();
  const idx = ['A', 'B', 'C', 'D'].indexOf(t);
  if (idx < 0 || b.currentQ.answered.has(user.id)) return false;
  b.currentQ.answered.add(user.id);
  if (idx === b.currentQ.q.correct) {
    if (b.qTimer) clearTimeout(b.qTimer);
    b.currentQ = null;
    battleAddScore(roomId, user.id, 100);
    botSay(roomId, '⚔️ BattleBot', `✅ ${user.name} got it! +100 battle points!`);
    askBattleQuestion(roomId);
  }
  return true;
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
  // cache-bust the app shell: inject a version into asset URLs so updates load fresh
  const injectVersion = (html) => html
    .replace(/(src="\/app\.js|href="\/style\.css)(\?v=[^"]*)?"/g, '$1"')
    .replace('src="/app.js"', `src="/app.js?v=${APP_VERSION}"`)
    .replace('href="/style.css"', `href="/style.css?v=${APP_VERSION}"`);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(injectVersion(d2.toString()));
      });
      return;
    }
    let out = data;
    if (urlPath === '/index.html') out = Buffer.from(injectVersion(data.toString()));
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    if (urlPath === '/index.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    else if (req.url.includes('?v=')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(out);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/api/coin-shop' && req.method === 'GET') return handleCoinShop(req, res);
  if (urlPath === '/api/create-checkout' && req.method === 'POST') return handleCreateCheckout(req, res);
  if (urlPath === '/api/stripe-webhook' && req.method === 'POST') return handleStripeWebhook(req, res);
  serveStatic(req, res);
});
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
  clearCamCheck(u);
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
    // Delete empty rooms (permanent directory rooms always stay)
    const still = roomUsers(roomId).length;
    if (still === 0 && !room.permanent) {
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
  if (!room) return;
  if (u.siteOwner || rankOf(room, u.id) >= 1) return; // staff exempt
  const limit = room.settings.talkLimitSec | 0;
  if (limit > 0) {
    send(u.ws, { type: 'talk-timer', limitSec: limit });
    u.talkTimer = setTimeout(() => {
      u.talkTimer = null;
      if (u.siteOwner) return;
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
  for (const u of users.values()) {
    // private 1-on-1 rooms are invisible to everyone except the site owner
    const list = [...rooms.values()]
      .filter(r => !r.private || u.siteOwner)
      .map(roomSummary);
    send(u.ws, { type: 'room-list', rooms: list });
  }
}

/* ------------------------------------------------------------------ */
/* Moderation                                                          */
/* ------------------------------------------------------------------ */

// action: mute|unmute|kick|ban|ipban|unban|promote-mod|promote-admin|demote
function handleModAction(actor, msg) {
  const room = rooms.get(msg.roomId);
  if (!room) return send(actor.ws, { type: 'error', message: 'Room not found.' });
  // the spectating site owner can moderate the private room they're watching
  const spectating = actor.siteOwner && actor.spectating === room.id;
  if (actor.roomId !== room.id && !spectating)
    return send(actor.ws, { type: 'error', message: 'You are not in that room.' });
  const target = users.get(msg.targetId);
  // site owner outranks everyone, everywhere
  const actorRank = actor.siteOwner ? 99 : rankOf(room, actor.id);

  // self-unmute is always allowed (no staff rank needed)
  const isSelfUnmute = msg.action === 'unmute' && target && target.id === actor.id;
  if (!isSelfUnmute) {
    const needRank = { mute: 1, unmute: 1, kick: 1, warn: 1, ban: 2, ipban: 2, unban: 2,
                       'promote-mod': 3, 'promote-admin': 3, demote: 3 }[msg.action];
    if (needRank == null) return send(actor.ws, { type: 'error', message: 'Unknown mod action.' });
    if (actorRank < needRank)
      return send(actor.ws, { type: 'error', message: 'You do not have permission for that.' });
  }

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
  if (target.siteOwner && target.id !== actor.id)
    return send(actor.ws, { type: 'error', message: 'You cannot moderate the site owner.' });
  if (target.id === actor.id && msg.action !== 'unmute')
    return send(actor.ws, { type: 'error', message: 'You cannot moderate yourself.' });
  const targetRank = rankOf(room, target.id);
  // self-unmute is allowed unless the mic is locked (staff bypass)
  if (target.id === actor.id && msg.action === 'unmute') {
    const rm = rooms.get(actor.roomId);
    if (rm && rm.settings.micLocked && !actor.siteOwner && rankOf(rm, actor.id) < 1)
      return send(actor.ws, { type: 'error', message: '🔒 Mic is locked — only owner & moderators can talk.' });
  }
  // self-unmute is always allowed; moderating others requires outranking them
  if (target.id !== actor.id && targetRank >= actorRank)
    return send(actor.ws, { type: 'error', message: 'You cannot moderate someone at or above your rank.' });

  switch (msg.action) {
    case 'mute':
      if (target.siteOwner) return send(actor.ws, { type: 'error', message: 'You cannot mute the site owner. \ud83d\udc51' });
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
    case 'mute-all': {
      let n = 0;
      for (const m of roomUsers(room.id)) {
        if (m.id === actor.id || m.siteOwner || rankOf(room, m.id) >= actorRank) continue;
        if (!m.muted) {
          m.muted = true; m.talking = false; m.micLive = false; clearTalkTimer(m);
          send(m.ws, { type: 'force-mute', by: actor.name });
          broadcastRoom(room.id, { type: 'user-muted', id: m.id, name: m.name }, m.id);
          n++;
        }
      }
      broadcastRoom(room.id, { type: 'notice', text: `🔇 ${actor.name} muted everyone (${n}).` });
      break;
    }
    case 'unrestrict': {
      const nm = String(msg.name || '').toLowerCase();
      restrictedUsers.delete(nm);
      if (persistOn) persistWrite(upstash('SREM', 'camwave:restricted-list', nm).then(() => upstash('DEL', 'camwave:restricted:' + nm)));
      for (const m of roomUsers(room.id)) {
        if (m.name.toLowerCase() === nm) {
          m.restricted = false;
          broadcastRoom(room.id, { type: 'user-unrestricted', id: m.id, name: m.name });
        }
      }
      broadcastRoom(room.id, { type: 'notice', text: `\u2705 ${actor.name} lifted restrictions on ${msg.name}.` });
      break;
    }
    case 'unmute-all': {
      for (const m of roomUsers(room.id)) {
        if (m.id === actor.id || m.siteOwner) continue;
        if (m.muted) {
          m.muted = false;
          send(m.ws, { type: 'force-unmute', by: actor.name });
          broadcastRoom(room.id, { type: 'user-unmuted', id: m.id, name: m.name, by: actor.name });
        }
      }
      broadcastRoom(room.id, { type: 'notice', text: `🔊 ${actor.name} unmuted everyone.` });
      break;
    }
    case 'kick': {
      kickLockouts.set(target.name.toLowerCase(), Date.now() + 2 * 60 * 60 * 1000);
      restrictedUsers.set(target.name.toLowerCase(), { by: actor.name, ts: Date.now(), reason: msg.reason || 'kicked' });
      if (persistOn) persistWrite((async () => {
        await upstash('SET', 'camwave:restricted:' + target.name.toLowerCase(), JSON.stringify(restrictedUsers.get(target.name.toLowerCase())));
        await upstash('SADD', 'camwave:restricted-list', target.name.toLowerCase());
      })());
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
      // owner authentication: nickname alone is never enough
      let isOwner = false;
      if (name === SITE_OWNER) {
        if (!OWNER_PASSWORD_HASH)
          return send(ws, { type: 'error', message: 'Owner login is not configured. Pick a different nickname.' });
        const h = crypto.createHash('sha256').update(String(msg.ownerPass || '').trim()).digest('hex');
        if (h !== OWNER_PASSWORD_HASH)
          return send(ws, { type: 'error', message: 'Wrong owner password.' });
        isOwner = true;
      }
      const user = { id, name, gender, age, ip: ws._ip, ws, status: 'online', roomId: null,
                     contacts: new Set(), muted: false, micLive: false, videoOn: false, talking: false, talkTimer: null,
                     siteOwner: isOwner, photo: null, sharingScreen: false,
                     verifiedCam: false, camWarnTimer: null, camKickTimer: null };
      ws._user = user;
      users.set(id, user);
      nameToId.set(name.toLowerCase(), id);
      send(ws, { type: 'welcome', id, name, gender, age, siteOwner: user.siteOwner, siteBanner, triviaBoard: triviaBoard(),
        coins: ensureCoins(name), gifts: GIFTS, topSpenders: topSpenders() });
      const daily = claimDaily(name);
      if (daily > 0) {
        const bal = addCoins(name, daily);
        send(ws, { type: 'daily-bonus', coins: daily, balance: bal });
      }
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
      // Relay WebRTC signaling between members of the same room,
      // or between a spectator and the members of the room they watch.
      const peer = users.get(msg.to);
      if (!peer) return send(ws, { type: 'error', message: 'Signal target not found.' });
      const sameRoom = u.roomId && peer.roomId === u.roomId;
      const spectatorLink = (u.spectating && peer.roomId === u.spectating) ||
                            (peer.spectating && u.roomId === peer.spectating);
      if (!sameRoom && !spectatorLink)
        return send(ws, { type: 'error', message: 'Signal target not in your room.' });
      send(peer.ws, { type: 'signal', from: u.id, data: msg.data });
      break;
    }

    case 'media-state': {
      // videoOn / talking flags for UI
      if (typeof msg.videoOn === 'boolean') u.videoOn = msg.videoOn;
      // camera verification: visible (not dark) feed marks them verified
      if (u.videoOn && typeof msg.brightness === 'number' && msg.brightness >= 0.08 && !u.verifiedCam) {
        u.verifiedCam = true;
        clearCamCheck(u);
        send(ws, { type: 'cam-verified' });
        send(ws, { type: 'notice', text: '✅ Camera verified — you can go off camera whenever you like.' });
      }
      broadcastRoom(u.roomId, { type: 'user-media', id: u.id, videoOn: u.videoOn }, u.id);
      break;
    }

    case 'mic-on': {
      if (u.restricted) return send(u.ws, { type: 'error', message: '\u26a0\ufe0f You are restricted — only the owner can unblock you.' });
      if (u.name === SITE_OWNER && !u.siteOwner) { u.siteOwner = true; console.log('owner flag self-healed for', u.name); }
      if (u.siteOwner) { u.muted = false; send(u.ws, { type: 'force-unmute', by: 'system' }); }
      if (u.muted) return; // server-muted users stay muted
      const room = rooms.get(u.roomId);
      if (!room) return;
      if (room.settings.micLocked && !u.siteOwner && rankOf(room, u.id) < 1 && msg.mode !== 'ptt-ok') {
        return send(u.ws, { type: 'error', message: '🔒 Hands-free is locked — hold the talk button instead.' });
      }
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
      if (u.restricted) return send(u.ws, { type: 'error', message: '\u26a0\ufe0f You are restricted — only the owner can unblock you.' });
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!text) return;
      if (text.startsWith('!') && handleBotCommand(u, text)) break;
      if (checkNovaTrigger(u, text)) break;
      if (handleTriviaAnswer(u.roomId, u, text)) break;
      if (handleBattleTriviaAnswer(u.roomId, u, text)) break;
      const room = rooms.get(u.roomId);
      const payload = { type: 'chat-msg', from: u.id, name: u.name,
        role: roleOf(room, u.id), text, ts: Date.now(), medal: spenderMedal(u.name), vip: vipOf(u.name) };
      addHistory(u.roomId, payload);
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
      room.private = true;
      room.allowed = new Set([u.id, target.id]);
      joinRoom(u, room.id);
      send(target.ws, { type: 'cam-invite', from: u.id, fromName: u.name, roomId: room.id, roomName: room.name });
      break;
    }
    case 'cam-invite-accept': {
      const room = rooms.get(msg.roomId);
      if (!room) return send(ws, { type: 'error', message: 'That invite expired.' });
      joinRoom(u, room.id);
      // alert the site owner that a private session just went live
      const other = [...roomUsers(room.id)].find(m => m.id !== u.id);
      notifySiteOwners({ type: 'private-alert', roomId: room.id, roomName: room.name,
        text: `🔒 ${other ? other.name + ' & ' : ''}${u.name} just went private` });
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

    /* ---- owner spy mode: invisibly watch private 1-on-1 sessions ---- */
    case 'spy-join': {
      if (!u.siteOwner) return send(ws, { type: 'error', message: 'Only the site owner can do that.' });
      const room = rooms.get(msg.roomId);
      if (!room || !room.private) return send(ws, { type: 'error', message: 'Not a private room.' });
      if (u.roomId) doLeaveRoom(u);
      if (u.spectating) {
        const old = u.spectating; u.spectating = null;
        broadcastRoom(old, { type: 'spectator-left', id: u.id });
      }
      u.spectating = room.id;
      const others = roomUsers(room.id);
      send(ws, { type: 'spy-joined', room: { id: room.id, name: room.name }, users: others });
      broadcastRoom(room.id, { type: 'spectator-joined', id: u.id, name: u.name });
      break;
    }
    case 'spy-leave': {
      if (!u.spectating) break;
      const rid = u.spectating;
      u.spectating = null;
      broadcastRoom(rid, { type: 'spectator-left', id: u.id });
      send(ws, { type: 'spy-left' });
      break;
    }

    case 'like': {
      if (!u.roomId) break;
      broadcastRoom(u.roomId, { type: 'like-event', from: u.id, fromName: u.name }, u.id);
      break;
    }

    case 'get-gift-leaderboard': {
      const lb = giftLeaderboard();
      if (msg.seed) lb.seed = true;
      send(ws, lb);
      break;
    }

    case 'get-room-visitors': {
      const room = rooms.get(msg.roomId || u.roomId);
      if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
      // visitor details are staff-only; counts are public on room cards
      const isStaff = u.siteOwner || rankOf(room, u.id) >= 1;
      if (!isStaff) return send(ws, { type: 'error', message: 'Only room staff can see visitor details.' });
      send(ws, { type: 'room-visitors', roomId: room.id, roomName: room.name,
        total: roomVisitCounts.get(room.id) || 0,
        visitors: roomVisitors.get(room.id) || [] });
      break;
    }

    case 'battle-challenge': {
      const target = users.get(msg.to);
      if (!target) return send(ws, { type: 'error', message: 'User not found.' });
      if (!u.roomId || target.roomId !== u.roomId)
        return send(ws, { type: 'error', message: 'You must be in the same room.' });
      if (target.id === u.id) return send(ws, { type: 'error', message: 'You cannot battle yourself.' });
      if (battles.has(u.roomId)) return send(ws, { type: 'error', message: 'A battle is already going in this room!' });
      if (!BATTLE_MODES[msg.mode]) return send(ws, { type: 'error', message: 'Pick a battle mode.' });
      if (pendingChallenges.has(target.id)) return send(ws, { type: 'error', message: 'They already have a pending challenge.' });
      const md = BATTLE_MODES[msg.mode];
      const ch = { challengerId: u.id, challengerName: u.name, mode: msg.mode, roomId: u.roomId,
        timer: setTimeout(() => {
          pendingChallenges.delete(target.id);
          send(ws, { type: 'battle-expired', toName: target.name });
        }, 60000) };
      if (ch.timer.unref) ch.timer.unref();
      pendingChallenges.set(target.id, ch);
      send(target.ws, { type: 'battle-challenge', from: u.id, fromName: u.name,
        mode: msg.mode, modeName: md.emoji + ' ' + md.name });
      send(ws, { type: 'battle-sent', toName: target.name });
      break;
    }

    case 'battle-accept': {
      const ch = pendingChallenges.get(u.id);
      if (!ch) return send(ws, { type: 'error', message: 'No pending challenge.' });
      clearTimeout(ch.timer);
      pendingChallenges.delete(u.id);
      const challenger = users.get(ch.challengerId);
      if (!challenger || challenger.roomId !== u.roomId)
        return send(ws, { type: 'error', message: 'Challenger left the room.' });
      startBattle(u.roomId, challenger, u, ch.mode);
      break;
    }

    case 'battle-decline': {
      const ch = pendingChallenges.get(u.id);
      if (!ch) break;
      clearTimeout(ch.timer);
      pendingChallenges.delete(u.id);
      const challenger = users.get(ch.challengerId);
      if (challenger) send(challenger.ws, { type: 'battle-declined', toName: u.name });
      break;
    }

    case 'battle-tap': {
      const b = battles.get(u.roomId);
      if (!b || b.over || b.mode !== 'taps') break;
      const side = msg.side;
      if (side !== b.p1.id && side !== b.p2.id) break;
      battleAddScore(u.roomId, side, 1);
      break;
    }

    case 'send-gift': {
      const gift = GIFTS.find(g => g.id === msg.giftId);
      const target = users.get(msg.to);
      if (!gift) return send(ws, { type: 'error', message: 'Unknown gift.' });
      if (!u.roomId) return send(ws, { type: 'error', message: 'Join a room first.' });
      if (!target || target.roomId !== u.roomId)
        return send(ws, { type: 'error', message: 'Recipient must be in your room.' });
      if (target.id === u.id) return send(ws, { type: 'error', message: 'You cannot send a gift to yourself.' });
      const bal = getCoins(u.name);
      if (bal < gift.cost)
        return send(ws, { type: 'error', message: `Not enough coins — you have 🪙${bal}.` });
      const newBal = addCoins(u.name, -gift.cost);
      send(ws, { type: 'coins', balance: newBal });
      trackGift(u.name, target.name, gift.cost);
      pushTopSpenders();
      addToGiftGoal(u.roomId, gift.cost, u.name);
      // whale spotlight: huge gifts put a golden frame on the gifter + bot shoutout
      if (gift.cost >= 1000) {
        broadcastRoom(u.roomId, { type: 'gift-spotlight', id: u.id, name: u.name, cost: gift.cost });
        botSay(u.roomId, '🎁 Gifts', `🐋 WHALE ALERT! ${u.name} just dropped a ${gift.emoji} ${gift.name} (${gift.cost.toLocaleString()} coins)! Give it up! 👏`, {});
      }
      const evt = { type: 'gift-event', from: u.id, fromName: u.name, to: target.id, toName: target.name,
        gift: { id: gift.id, emoji: gift.emoji, name: gift.name, cost: gift.cost, tier: giftTier(gift.cost) }, ts: Date.now() };
      broadcastRoom(u.roomId, evt);
      // battle scoring: gifts to a battler = points
      const b = battles.get(u.roomId);
      if (b && !b.over && b.mode === 'gifts' && (target.id === b.p1.id || target.id === b.p2.id))
        battleAddScore(u.roomId, target.id, gift.cost);
      addHistory(u.roomId, { type: 'chat-msg', from: 'gift', name: '🎁 Gifts', role: 'member',
        text: `${u.name} sent ${target.name} ${gift.emoji} ${gift.name}!`, ts: Date.now(), bot: true });
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

    case 'set-bio': {
      const bio = String(msg.bio || '').slice(0, 300);
      getProfile(u.name).bio = bio;
      persistProfile(u.name);
      send(u.ws, { type: 'profile-data', name: u.name, profile: getProfile(u.name) });
      break;
    }
    case 'add-photo': {
      const dataUrl = String(msg.dataUrl || '');
      if (!/^data:image\/(jpeg|png|gif|webp)/i.test(dataUrl)) return;
      if (dataUrl.length > 500 * 1024)
        return send(u.ws, { type: 'error', message: 'Photo too big.' });
      const pr = getProfile(u.name);
      if (pr.photos.length >= 6)
        return send(u.ws, { type: 'error', message: 'Max 6 photos.' });
      pr.photos.push(dataUrl);
      persistProfile(u.name);
      send(u.ws, { type: 'profile-data', name: u.name, profile: pr });
      break;
    }
    case 'del-photo': {
      const pr = getProfile(u.name);
      const i = parseInt(msg.index, 10);
      if (Number.isFinite(i) && i >= 0 && i < pr.photos.length) pr.photos.splice(i, 1);
      persistProfile(u.name);
      send(u.ws, { type: 'profile-data', name: u.name, profile: pr });
      break;
    }
    case 'get-profile': {
      const nm = String(msg.name || '').slice(0, 40);
      send(u.ws, { type: 'profile-data', name: nm, profile: getProfile(nm) });
      break;
    }

    case 'screen-share': {
      u.sharingScreen = !!msg.sharing;
      if (u.roomId) broadcastRoom(u.roomId, { type: 'user-screen', id: u.id, sharing: u.sharingScreen }, u.id);
      break;
    }

    case 'room-settings': {
      const room = rooms.get(msg.roomId);
      if (!room || rankOf(room, u.id) < 1)
        return send(ws, { type: 'error', message: 'Only moderators can change room settings.' });
      const isAdmin = rankOf(room, u.id) >= 2;
      if (typeof msg.openMic === 'boolean' && isAdmin) room.settings.openMic = msg.openMic;
      if (typeof msg.micLocked === 'boolean') {
        room.settings.micLocked = msg.micLocked;
        // hands-free lock: members must use push-to-talk, staff keep hands-free
        if (msg.micLocked) {
          broadcastRoom(room.id, { type: 'notice', text: '🔒 Hands-free locked — members must use push-to-talk. Owner & mods keep hands-free.' });
        } else {
          broadcastRoom(room.id, { type: 'notice', text: '🔓 Hands-free unlocked.' });
        }
        broadcastRoom(room.id, { type: 'room-settings-updated', settings: room.settings });
      }
      if (Number.isFinite(msg.talkLimitSec) && isAdmin)
        room.settings.talkLimitSec = Math.max(0, Math.min(600, Math.floor(msg.talkLimitSec)));
      broadcastRoom(room.id, { type: 'room-settings-updated', settings: room.settings });
      pushRoomList();
      break;
    }

    case 'jukebox-add': {
      if (!u.siteOwner && rankOf(rooms.get(msg.roomId), u.id) < 2)
        return send(ws, { type: 'error', message: 'Only admins can add jukebox tracks.' });
      const g = String(msg.genre || '').toLowerCase();
      if (!jukebox.has(g)) return;
      jukebox.get(g).push({ name: String(msg.name || 'Untitled').slice(0, 80), url: String(msg.url || '') });
      broadcastRoom(msg.roomId, { type: 'jukebox-updated', playlists: jukeboxToObj() });
      break;
    }
    case 'jukebox-remove': {
      if (!u.siteOwner && rankOf(rooms.get(msg.roomId), u.id) < 2) return;
      const g = String(msg.genre || '').toLowerCase();
      if (jukebox.has(g)) jukebox.set(g, jukebox.get(g).filter((_, i) => i !== (msg.index | 0)));
      broadcastRoom(msg.roomId, { type: 'jukebox-updated', playlists: jukeboxToObj() });
      break;
    }
    case 'sfx': {
      if (!u.siteOwner)
        return send(ws, { type: 'error', message: 'Only the owner controls the soundboard. \ud83d\udc51' });
      // broadcast sound effect to room (rate-limited)
      const now = Date.now();
      if (u.lastSfx && now - u.lastSfx < 1500)
        return send(ws, { type: 'error', message: 'Wait a sec before another sound! 🔊' });
      if (u.restricted || u.muted) return;
      u.lastSfx = now;
      broadcastRoom(u.roomId, { type: 'sfx', id: String(msg.id || '').slice(0, 20), by: u.name });
      break;
    }
    case 'dj': {
      // DJ mode: mute everyone except staff so nobody talks over the music
      if ((msg.action === 'start-url' || msg.action === 'start-file' || msg.action === 'start-tab') && u.siteOwner) {
        for (const m of roomUsers(u.roomId)) {
          if (m.id === u.id || m.siteOwner || rankOf(rooms.get(u.roomId), m.id) >= 1) continue;
          if (!m.muted) {
            m.muted = true; m.talking = false; m.micLive = false; clearTalkTimer(m);
            send(m.ws, { type: 'force-mute', by: '🎧 DJ mode' });
            broadcastRoom(u.roomId, { type: 'user-muted', id: m.id, name: m.name }, m.id);
          }
        }
        broadcastRoom(u.roomId, { type: 'notice', text: '🎧 DJ mode — room muted, enjoy the music!' });
      }
      if (msg.action === 'stop' && u.siteOwner) {
        broadcastRoom(u.roomId, { type: 'notice', text: '🎧 DJ stopped — mics are back!' });
      }
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
    settings: { openMic: false, talkLimitSec: 120, micLocked: false },
    dj: { active: false, mode: null, url: null, volume: 1, by: null } };
  rooms.set(id, room);
  return room;
}

/* ================= permanent directory rooms ================= */
const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];
const DIRECTORY_DEFS = [
  { id: 'dir-singles', name: '💕 Singles', category: 'Lifestyle' },
  { id: 'dir-couples', name: '💑 Couples', category: 'Lifestyle' },
  { id: 'dir-swingers', name: '🔥 Swingers', category: 'Adult' },
  { id: 'dir-dating', name: '💘 Dating', category: 'Lifestyle' },
  { id: 'dir-18plus', name: '🔞 18+', category: 'Adult' },
  { id: 'dir-afterdark', name: '🌙 After Dark', category: 'Adult' },
  { id: 'dir-flirt', name: '💋 Flirt Zone', category: 'Adult' },
  { id: 'dir-adultlounge', name: '🥂 Adult Lounge', category: 'Adult' },
  { id: 'dir-masquerade', name: '🎭 Masquerade', category: 'Adult' },
  { id: 'dir-nudity', name: '🔞 Nudity Zone', category: 'Adult' },
  { id: 'dir-w4m', name: '💃 Women Seeking Men', category: 'Adult' },
  { id: 'dir-lesbian', name: '👩‍❤️‍👩 Lesbian Lounge', category: 'Adult' },
  ...US_STATES.map(s => ({ id: 'dir-' + s.toLowerCase().replace(/[^a-z]/g, ''), name: '📍 ' + s, category: 'States' })),
];
// rooms that get the spicy WelcomeBot intro
const ADULT_ROOM_IDS = new Set(['dir-18plus', 'dir-swingers', 'dir-afterdark', 'dir-flirt', 'dir-adultlounge', 'dir-masquerade', 'dir-nudity', 'dir-w4m', 'dir-lesbian']);
function seedDirectoryRooms() {
  for (const d of DIRECTORY_DEFS) {
    if (rooms.has(d.id)) continue;
    const room = { id: d.id, name: d.name, ownerId: null, admins: new Set(), mods: new Set(),
      bans: new Map(), ipBans: new Set(), permanent: true, category: d.category,
      settings: { openMic: false, talkLimitSec: 120, micLocked: false },
      dj: { active: false, mode: null, url: null, volume: 1, by: null } };
    rooms.set(d.id, room);
    loadRoomHistory(d.id);
  }
}

/* ================= room chat history ================= */
const HISTORY_LIMIT = 100;
const roomHistory = new Map(); // roomId -> [{from,name,role,text,ts,bot}]
function addHistory(roomId, entry) {
  let h = roomHistory.get(roomId);
  if (!h) { h = []; roomHistory.set(roomId, h); }
  h.push(entry);
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
  const room = rooms.get(roomId);
  if (room && room.permanent && persistOn) {
    const key = 'camwave:history:' + roomId;
    persistWrite((async () => {
      await upstash('RPUSH', key, JSON.stringify(entry));
      await upstash('LTRIM', key, -HISTORY_LIMIT, -1);
    })());
  }
}
async function loadRoomHistory(roomId) {
  if (!persistOn) return;
  try {
    const raw = await upstash('LRANGE', 'camwave:history:' + roomId, 0, -1);
    const arr = Array.isArray(raw) ? raw : [];
    roomHistory.set(roomId, arr.map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean).slice(-HISTORY_LIMIT));
  } catch (e) { console.warn('history load:', roomId, e.message); }
}

function joinRoom(u, roomId) {
  const room = rooms.get(roomId);
  if (!room) return send(u.ws, { type: 'error', message: 'Room not found.' });
  if (u.roomId === roomId) return;
  // private 1-on-1 rooms: only the two participants (or site owner spying) may enter
  if (room.private && !room.allowed.has(u.id) && !u.siteOwner)
    return send(u.ws, { type: 'error', message: 'This is a private session.' });

  // 2-hour kick lockout
  const lockout = kickLockouts.get(u.name.toLowerCase());
  if (lockout && Date.now() < lockout) {
    const mins = Math.ceil((lockout - Date.now()) / 60000);
    return send(u.ws, { type: 'kick-lockout', mins, room: room.name });
  }
  if (lockout) kickLockouts.delete(u.name.toLowerCase());
  // Ban checks (per-room, this session)
  const banRec = room.bans.get(u.id);
  if (banRec) return send(u.ws, { type: 'ban-reject', scope: 'room', room: room.name });
  if (u.ip && u.ip !== 'unknown' && room.ipBans.has(u.ip))
    return send(u.ws, { type: 'ban-reject', scope: 'room-ip', room: room.name });
  // Persistent global bans (survive restarts)
  if (u.ip && u.ip !== 'unknown' && gIpBans.has(u.ip))
    return send(u.ws, { type: 'ban-reject', scope: 'global-ip' });
  if (u.name && gNameBans.has(u.name.toLowerCase()))
    return send(u.ws, { type: 'ban-reject', scope: 'global' });

  if (u.roomId) doLeaveRoom(u);
  u.roomId = roomId;
  // First person into an ownerless (system) room becomes its owner.
  if (!room.ownerId) {
    room.ownerId = u.id;
    send(u.ws, { type: 'notice', text: `You are now the owner of "${room.name}".` });
  }
  u.muted = u.siteOwner ? false : !room.settings.openMic; // owner NEVER muted
  u.restricted = restrictedUsers.has(u.name.toLowerCase());
  u.videoOn = false;
  u.talking = false;
  u.micLive = false;

  const others = roomUsers(roomId).filter(m => m.id !== u.id);
  send(u.ws, { type: 'room-joined',
    room: { id: room.id, name: room.name, settings: room.settings,
            myRole: roleOf(room, u.id), dj: room.dj },
    users: others,
    selfMuted: u.muted,
    giftGoal: giftGoal(roomId) });
  send(u.ws, { type: 'room-history', messages: roomHistory.get(roomId) || [] });
  send(u.ws, { type: 'jukebox-updated', playlists: jukeboxToObj() });
  broadcastRoom(roomId, { type: 'user-joined',
    user: { ...publicUser(u), role: roleOf(room, u.id) } }, u.id);
  // track the visit (counter + visitor profile)
  trackVisit(roomId, u);
  // camera verification: unverified users must show their face
  startCamCheck(u, roomId);
  // WelcomeBot greets every joiner — even if the room was empty
  greetJoiner(roomId, room, u);
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
    clearCamCheck(u);
    // spectator cleanup: tell the watched room the invisible viewer is gone
    if (u.spectating) {
      broadcastRoom(u.spectating, { type: 'spectator-left', id: u.id });
      u.spectating = null;
    }
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
        if (roomUsers(roomId).length === 0 && !room.permanent) {
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
loadPersistedProfiles();
(async () => {
  if (!persistOn) return;
  try {
    const names = await upstash('SMEMBERS', 'camwave:restricted-list');
    for (const n of (names || [])) {
      const j = await upstash('GET', 'camwave:restricted:' + n);
      if (j) { try { restrictedUsers.set(n, JSON.parse(j)); } catch {} }
    }
    console.log('restricted users loaded:', restrictedUsers.size);
  } catch (e) { console.warn('restricted load:', e.message); }
})();
  loadSiteBanner();
  loadTriviaScores();
  loadCoins();
  loadVisitCounts();
  loadGiftStats();
  seedDirectoryRooms();
});
