/* CamWave client — vanilla JS + WebRTC mesh + WebSocket signaling */
'use strict';

/* ============================== state ============================== */
const S = {
  ws: null, myId: null, myName: null,
  rooms: [], roomFilter: '',
  room: null,           // {id,name,settings,myRole,dj}
  roomUsers: new Map(), // id -> {id,name,status,role,muted,videoOn,talking}
  selfMuted: true,
  localStream: null, camOn: false, micOn: false,
  peers: new Map(),     // peerId -> {pc, stream, senderForDj?}
  hiddenPeers: new Set(), // spectator ids: peer connection exists but no tile/list entry
  spectating: null,      // roomId when invisibly watching a private room
  spotlightId: null,
  contacts: [],
  dmWith: null, dmUnread: new Set(),
  dj: { active: false, mode: null, audio: null, url: null, track: null, by: null },
  pttHeld: false,
  soundOn: true,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tsFmt = (ts) => new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});

function wsSend(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

/* ============================== websocket ============================== */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(proto + '//' + location.host);
  S.ws.onopen = () => {
    const saved = localStorage.getItem('camwave_nick');
    if (saved) { $('nick-input').value = saved; }
    try { S.ownerPass = S.ownerPass || sessionStorage.getItem('camwave_ownerpass') || ''; } catch {}
    // auto re-login if the socket dropped mid-session
    if (S.myName) {
      wsSend({ type: 'hello', name: S.myName, gender: S.myGender || 'm', age: S.myAge || 25, ownerPass: S.ownerPass || '' });
    }
  };
  S.ws.onmessage = (e) => { try { onServer(JSON.parse(e.data)); } catch {} };
  S.ws.onclose = () => {
    setTimeout(() => { if (!$('app').classList.contains('hidden')) connect(); }, 3000);
  };
}

function onServer(m) {
  switch (m.type) {
    case 'welcome':
      S.myId = m.id; S.myName = m.name; S.myGender = m.gender; S.myAge = m.age;
      S.siteOwner = !!m.siteOwner;
      S.coins = m.coins || 0; S.gifts = m.gifts || [];
      localStorage.setItem('camwave_nick', m.name);
      $('login-screen').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('my-name').textContent = m.name;
      $('siteowner-btn').classList.toggle('hidden', !S.siteOwner);
      const sfxBtn = $('sfx-btn'); if (sfxBtn) sfxBtn.classList.toggle('hidden', !S.siteOwner);
      updateCoinDisplay();
      if (m.siteBanner && !S._welcomed) { S.siteBanner = m.siteBanner; showLetterhead(m.siteBanner); }
      if (m.triviaBoard) { S.triviaBoard = m.triviaBoard; renderTriviaBoard(); }
      if (m.topSpenders) renderTopSpenders(m.topSpenders);
      if (pendingPhoto) { S.myPhoto = pendingPhoto; wsSend({ type: 'set-photo', dataUrl: pendingPhoto }); pendingPhoto = null; }
      wsSend({ type: 'get-contacts' });
  wsSend({ type: 'get-profile', name: m.name });
      S._welcomed = true;
      // complete any room tap that happened while disconnected
      if (S.pendingJoin) { const pj = S.pendingJoin; S.pendingJoin = null; wsSend(pj); }
      break;
    case 'coins':
      S.coins = m.balance; updateCoinDisplay(); break;
    case 'daily-bonus':
      S.coins = m.balance; updateCoinDisplay();
      toast(`🎉 Daily bonus: +🪙${m.coins}!`); break;
    case 'gift-event':
      giftCelebration(m); tickerAddGift(m); break;
    case 'gift-leaderboard':
      if (m.seed) seedTicker(m); else showGiftLeaderboard(m);
      break;
    case 'room-visitors':
      showRoomVisitors(m);
      break;
    case 'top-spenders':
      renderTopSpenders(m.top);
      break;
    case 'spy-joined':
      onSpyJoined(m); break;
    case 'private-alert':
      privateAlert(m); break;
    case 'gift-goal':
      renderGiftGoal(m.goal, m.completed); break;
    case 'gift-spotlight':
      giftSpotlight(m); break;
    case 'cam-check-start':
      showCamCheckBanner(false); break;
    case 'cam-warn':
      showCamCheckBanner(true); break;
    case 'cam-verified': {
      const b = $('cam-check-banner');
      if (b) b.classList.add('hidden');
      break;
    }
    case 'spy-left':
      stopSpectating(); break;
    case 'spectator-joined':
      S.hiddenPeers.add(m.id); break;
    case 'spectator-left': {
      S.hiddenPeers.delete(m.id);
      const p = S.peers.get(m.id);
      if (p) { try { p.pc.close(); } catch {} S.peers.delete(m.id); }
      renderVideoGrid();
      break;
    }
    case 'battle-challenge':
    case 'battle-sent':
    case 'battle-declined':
    case 'battle-expired':
    case 'battle-start':
    case 'battle-score':
    case 'battle-end':
      onBattleMessage(m); break;
    case 'like-event':
      spawnHearts(4, false);
      railLikes++;
      $('rail-like-count').textContent = railLikes > 999 ? (railLikes / 1000).toFixed(1) + 'K' : railLikes;
      break;
    case 'site-banner':
      S.siteBanner = m.banner; break;
    case 'warned':
      showWarned(m); break;
    case 'mod-banner':
      showModBanner(m); break;
    case 'profile-data':
      if (m.name === profileName) { profileData = m.profile; renderProfile(); }
      if (m.name === S.myName) {
        try { localStorage.setItem('camwave_profile', JSON.stringify(m.profile)); } catch {}
        // if server lost our profile (restart) but we have a backup, restore it
        maybeRestoreProfile(m.profile);
      }
      break;
    case 'user-photo': {
      const u = S.roomUsers.get(m.id);
      if (u) { u.photo = m.photo; renderVideoGrid(); renderUserList(); }
      break;
    }
    case 'user-screen': {
      const u = S.roomUsers.get(m.id);
      if (u) { u.sharingScreen = m.sharing; renderVideoGrid(); }
      break;
    }
    case 'cam-invite':
      pendingInvite = m;
      $('invite-text').textContent = `${m.fromName} invited you to a private video chat.`;
      $('invite-modal').classList.remove('hidden');
      break;
    case 'trivia-board':
      S.triviaBoard = m.board; renderTriviaBoard(); break;
    case 'trivia-win':
      halloweenCelebration(m.winners || []); break;
    case 'spooky-sound':
      playSpookySound(m.sound); break;
    case 'rizz-sound':
      playRizzSound(m.sound); break;
    case 'error':
      if ($('login-screen').classList.contains('hidden')) toast(m.message);
      else { $('login-error').textContent = m.message; }
      break;
    case 'room-list':
      S.rooms = m.rooms; renderRooms(); break;
    case 'room-joined':
    if (S.siteOwner && m.selfMuted) {
      toast('🔄 Session expired — re-logging in as owner...');
      setTimeout(() => location.reload(), 1500);
      break;
    }
    onRoomJoined(m); break;
    case 'room-history': renderHistory(m.messages || []); break;
    case 'left-room': break;
    case 'user-joined': onUserJoined(m.user); break;
    case 'user-left': onUserLeft(m.id, m.reason); break;
    case 'user-status': setUserProp(m.id, 'status', m.status); break;
    case 'user-media': setUserProp(m.id, 'videoOn', m.videoOn); break;
    case 'user-talking': setUserProp(m.id, 'talking', m.talking); if (typeof m.micLive === 'boolean') setUserProp(m.id, 'micLive', m.micLive); renderUserList(); updateTileStates(); break;
    case 'user-muted': setUserProp(m.id, 'muted', true); renderUserList(); break;
    case 'user-unmuted': setUserProp(m.id, 'muted', false); if (m.id === S.myId) S.selfMuted = false; renderUserList(); break;
    case 'user-unrestricted': setUserProp(m.id, 'restricted', false); renderUserList(); break;
    case 'room-roles':
      for (const u of m.users) setUserProp(u.id, 'role', u.role);
      renderUserList(); refreshModUI(); break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'chat-msg':
      addChatMsg(m);
      if (m.name === '🤖 RizzBot' && m.text) robotSpeak(m.text);
      break;
    case 'chat-media': addMediaMsg(m); break;
    case 'dm-msg': onDmMsg(m); break;
    case 'dm-sent': onDmSent(m); break;
    case 'dm-history':
      if (m.with === S.dmWith) { $('dm-log').innerHTML=''; for (const x of m.messages) addDmMsg(x); }
      break;
    case 'contacts': S.contacts = m.contacts; renderContacts(); break;
    case 'contact-added': toast(m.name + ' added you back as a contact ✓'); wsSend({type:'get-contacts'}); break;
    case 'contact-status':
      { const c = S.contacts.find(x => x.id === m.id); if (c) { c.status = m.status; renderContacts(); } }
      break;
    case 'force-mute':
      stopTalkCountdown(); S.selfMuted = true;
      setMicEnabled(false, true); toast('🔇 Muted by ' + m.by); renderUserList(); break;
    case 'force-unmute':
      S.selfMuted = false; renderUserList();
      toast('🔊 Unmuted by ' + m.by + ' — you may talk now'); break;
    case 'talk-timer': startTalkCountdown(m.limitSec); break;
    case 'sfx': {
      playSfx(m.id);
      const fx = SFX_LIST.find(f => f.id === m.id);
      if (fx) addSysMsg(`${fx.icon} <b>${esc(m.by)}</b> played <b>${fx.name}</b> ${fx.icon}`);
      break;
    }
    case 'jukebox-updated': jbPlaylists = m.playlists || {}; if (!$('jukebox-modal').classList.contains('hidden')) renderJukebox(); break;
  case 'talk-timeout':
      setMicEnabled(false, true); toast(`⏱ Talk time limit (${m.limitSec}s) reached — mic auto-muted`); break;
    case 'kicked': {
      leaveRoomUI();
      const kicks = [
        `👢 BOOTED by ${m.by}! Don't let the door hit ya where the good Lord split ya.`,
        `👢 ${m.by} kicked you out! That's gotta sting. Walk of shame time. 🚶`,
        `👢 KICKED! ${m.by} said "nah." Better luck next room, champ.`,
        `👢 Yeeted by ${m.by}! You were THIS close to behaving.`,
        `👢 ${m.by} drop-kicked you outta here! Go touch grass. 🌱`,
      ];
      showBlastModal('👢 KICKED', kicks[Math.floor(Math.random() * kicks.length)]);
      break;
    }
    case 'kick-lockout': {
      const hrs = Math.floor(m.mins / 60), mins = m.mins % 60;
      const when = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      showBlastModal('⏳ CHILL OUT',
        `You were kicked from "${esc(m.room)}" — take ${when} to relax. 🧘\n\nDon't mess with the Owner's Aura. 👑\n\nCome back calmer.`);
      break;
    }
    case 'ban-reject': {
      const msgs = [
        '🚫 STILL BANNED! Did you really think that changed? Take a hike! 🥾',
        '🚫 Nope. Still not welcome here. The ban didn\'t magically lift. ✋',
        '🚫 Persistent, aren\'t you? The answer is still NO. Go away! 🚪',
        '🚫 This is your sign to stop trying. BANNED means BANNED. 🛑',
        '🚫 Knocking again? Nobody\'s answering. Take the hint! 💡',
        '🚫 You\'ve been rejected more times than a bad pickup line. Move on! 💔',
      ];
      const scope = m.scope === 'room' || m.scope === 'room-ip' ? ` from "${m.room}"` : ' from CamWave';
      blastToxicNoise();
      showBlastModal('🚫 STILL BANNED',
        msgs[Math.floor(Math.random() * msgs.length)] + `\n\nYou are banned${scope}.`);
      // double-tap: another one for good measure
      setTimeout(() => toast('🚫 ' + msgs[Math.floor(Math.random() * msgs.length)]), 1500);
      break;
    }
    case 'banned': {
      leaveRoomUI();
      const bans = [
        '🚫 BANNED! You messed around and found out. Enjoy the void. 🕳️',
        '🚫 PERMABANNED! Your behavior was so bad it made the bots cringe. 🤖',
        '🚫 BANNED! Even the trolls are disappointed in you. Pack it up. 📦',
        '🚫 You are now officially exiled. The door? It hit you. Hard. 🚪💥',
        '🚫 BANNED! Legend says your bad decisions echoed through every room. 🔊',
      ];
      blastToxicNoise();
      showBlastModal('🚫 BANNED', bans[Math.floor(Math.random() * bans.length)] + (m.message ? '\n\n' + m.message : ''));
      break;
    }
    case 'notice': addSysMsg(m.text); toast(m.text); break;
    case 'room-settings-updated':
      if (S.room) { S.room.settings = m.settings; renderRoomHeader(); }
      addSysMsg(m.settings.openMic ? '🎙 Open mic is now ON' : '🔇 Open mic is now OFF — push-to-talk mode');
      break;
    case 'ban-list': renderBanList(m.bans); renderModPanelBans(m.bans); break;
    case 'dj': onDjMsg(m); break;
  }
}

function toast(text) {
  addSysMsg('ℹ️ ' + text);
}

/* ---------- popup banners + join/leave sounds ---------- */
let __audioCtx = null;
function __beep(freq, dur, vol = 0.12, delay = 0) {
  try {
    __audioCtx = __audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (__audioCtx.state === 'suspended') __audioCtx.resume();
    const t = __audioCtx.currentTime + delay;
    const o = __audioCtx.createOscillator(), g = __audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(__audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  } catch {}
}
function joinSound() { if (S.soundOn === false) return; __beep(660, .12); __beep(990, .16, .12, .1); }
function leaveSound() { if (S.soundOn === false) return; __beep(520, .12); __beep(360, .18, .12, .1); }
function banner(text, kind) {
  const stack = $('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast-banner' + (kind === 'leave' ? ' leave' : '');
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3050);
}

/* ============================== login ============================== */
$('join-btn').onclick = doLogin;
$('nick-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
function doLogin() {
  const name = $('nick-input').value.trim();
  if (name.length < 2) { $('login-error').textContent = 'Pick a nickname (2+ characters).'; return; }
  const gender = $('gender-input').value === 'f' ? 'f' : 'm';
  const age = parseInt($('age-input').value, 10);
  if (!Number.isFinite(age) || age < 13 || age > 120) { $('login-error').textContent = 'Enter your age (13+).'; return; }
  $('login-error').textContent = '';
  const ownerPass = $('ownerpass-input') ? $('ownerpass-input').value : '';
  S.ownerPass = ownerPass;
  wsSend({ type: 'hello', name, gender, age, ownerPass });
}
$('status-select').onchange = (e) => wsSend({ type: 'set-status', status: e.target.value });

/* ---- door images: room cards get a mood image ---- */
const ROOM_DOOR_IMGS = {
  'dir-singles': 'img/rooms/singles.jpg',
  'dir-couples': 'img/rooms/couples.jpg',
  'dir-swingers': 'img/rooms/swingers.jpg',
  'dir-dating': 'img/rooms/dating.jpg',
  'dir-18plus': 'img/rooms/18plus.jpg',
  'dir-afterdark': 'img/rooms/afterdark.jpg',
  'dir-flirt': 'img/rooms/flirt.jpg',
  'dir-adultlounge': 'img/rooms/adultlounge.jpg',
  'dir-masquerade': 'img/rooms/masquerade.jpg',
};
function doorImg(r) {
  return ROOM_DOOR_IMGS[r.id] || (r.category === 'States' ? 'img/rooms/states.jpg' : null);
}

/* ============================== lobby ============================== */
$('room-search').addEventListener('input', e => { S.roomFilter = e.target.value.toLowerCase(); renderRooms(); });
$('create-room-btn').onclick = () => {
  const name = prompt('Name your room:');
  if (name && name.trim().length >= 2) wsSend({ type: 'create-room', name: name.trim().slice(0, 40) });
};

function renderRooms() {
  const list = $('room-list');
  const q = S.roomFilter;
  const rooms = S.rooms.filter(r => !q || r.name.toLowerCase().includes(q));
  if (!rooms.length) { list.innerHTML = '<p style="color:var(--muted)">No rooms yet — create one! 🎉</p>'; return; }
  list.innerHTML = '';
  // site owner gets a dedicated SPY section for live private 1-on-1s, right at the top
  const privates = S.siteOwner ? rooms.filter(r => r.private) : [];
  if (privates.length) {
    const h = document.createElement('div');
    h.className = 'room-section spy-section';
    h.innerHTML = `<h2>👁️ Private sessions <span class="count">${privates.length}</span> <small class="fineprint">tap to watch invisibly</small></h2>`;
    const grid = document.createElement('div');
    grid.className = 'room-grid';
    for (const r of privates) grid.appendChild(roomCard(r));
    h.appendChild(grid);
    list.appendChild(h);
  }
  const order = ['Adult', 'Lifestyle', 'States', 'Rooms'];
  const groups = {};
  for (const r of rooms) {
    if (r.private) continue; // private rooms live in the spy section for the owner
    const cat = r.category || 'Rooms';
    (groups[cat] = groups[cat] || []).push(r);
  }
  const cats = [...order.filter(c => groups[c]), ...Object.keys(groups).filter(c => !order.includes(c))];
  for (const cat of cats) {
    const h = document.createElement('div');
    h.className = 'room-section';
    h.innerHTML = `<h2>${esc(cat)} <span class="count">${groups[cat].length}</span></h2>`;
    const grid = document.createElement('div');
    grid.className = 'room-grid';
    // Camfrog style: busiest rooms first
    const sorted = [...groups[cat]].sort((a, b) => (b.userCount || 0) - (a.userCount || 0));
    for (const r of sorted) grid.appendChild(roomCard(r));
    h.appendChild(grid);
    list.appendChild(h);
  }
}

/* single room card (also used by the spy section) */
function roomCard(r) {
  const d = document.createElement('div');
  d.className = 'room-row' + (r.private ? ' private-card' : '');
  const live = (r.userCount || 0) > 0;
  const emoji = r.private ? '🔒' : (live ? '🔴' : '💤');
  const meta = r.private ? 'tap to watch invisibly' : (r.openMic ? '🎙 open mic' : '🔊 push-to-talk');
  d.innerHTML = `<span class="rr-emoji">${emoji}</span>
    <span class="rr-main">
      <span class="rr-name">${esc(r.name)}</span>
      <span class="rr-meta">${r.private ? 'PRIVATE' : meta}${r.djActive ? ' · 🎧 DJ' : ''}</span>
    </span>
    <span class="rr-count">${r.private ? '' : `👥 ${r.userCount || 0}`}</span>
    <span class="rr-go">›</span>`;
  d.onclick = () => {
    const msg = (r.private && S.siteOwner) ? { type: 'spy-join', roomId: r.id } : { type: 'join-room', roomId: r.id };
    if (S.ws && S.ws.readyState === 1) wsSend(msg);
    else {
      S.pendingJoin = msg;
      toast('🔄 Reconnecting…');
      try { S.ws.close(); } catch {}
    }
  };
  return d;
}

/* ---- room chat history ---- */
function renderHistory(msgs) {
  const log = $('chat-log');
  if (!log || !msgs.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'history-wrap';
  const top = document.createElement('div');
  top.className = 'history-divider';
  top.textContent = '📜 Past conversations';
  wrap.appendChild(top);
  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = 'chat-msg history' + (m.bot ? ' bot' : '') + (m.greeting ? ' greeting' : '');
    el.innerHTML = `<span class="who">${esc(m.name)}</span><span class="ts">${tsFmt(m.ts)}</span><div>${esc(m.text)}</div>`;
    wrap.appendChild(el);
  }
  const bot = document.createElement('div');
  bot.className = 'history-divider';
  bot.textContent = '— you joined · live —';
  wrap.appendChild(bot);
  log.prepend(wrap);
  log.scrollTop = 0;
}

/* ============================== room ============================== */
function onRoomJoined(m) {
  S.room = m.room;
  S.roomUsers = new Map(m.users.map(u => [u.id, u]));
  S.selfMuted = m.selfMuted;
  stopDjLocal(); // clear any DJ state from the previous room
  const rdj = m.room && m.room.dj;
  if (rdj && rdj.active && rdj.mode === 'spotify' && rdj.spotifyId) {
    startDjSpotify(rdj.spotifyType, rdj.spotifyId, rdj.by); // late joiner tunes in
  } else if (rdj && rdj.active && rdj.mode === 'youtube' && rdj.youtubeId) {
    startDjYoutube(rdj.youtubeId, rdj.by); // late joiner tunes in
  }
  renderGiftGoal(m.giftGoal || null);
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');
  $('chat-log').innerHTML = '';
  $('activity-log').innerHTML = '';
  $('video-grid').innerHTML = '';
  S.peers.clear(); S.spotlightId = null;
  // reset battle + ticker state for the new room
  S_battle = null;
  if (battleTickTimer) clearInterval(battleTickTimer);
  const bb = $('battle-bar'); if (bb) bb.classList.add('hidden');
  tickerItems.length = 0;
  const tape = $('ticker-tape'); if (tape) tape.innerHTML = '<span class="ticker-item">🎁 Gift activity will stream here…</span>';
  wsSend({ type: 'get-gift-leaderboard', seed: true });
  renderRoomHeader(); renderUserList(); refreshModUI();
  addSysMsg(`You joined "${m.room.name}" as ${m.room.myRole}.`);
  setupLocalMedia().then(() => {
    // create offers to everyone already here
    for (const u of m.users) createPeer(u.id, true);
  });
  updateMediaButtons();
}

function renderRoomHeader() {
  if (!S.room) return;
  $('room-name').textContent = S.room.name;
  const n = S.roomUsers.size + 1;
  $('room-count').textContent = `👥 ${n}`;
  $('side-count').textContent = `(${n})`;
  $('room-mode').textContent = S.room.settings.openMic ? '🎙 open mic' : '🔊 push-to-talk';
  const canMod = ['owner','admin'].includes(S.room.myRole);
  $('room-settings-btn').classList.toggle('hidden', !canMod);
  $('dj-btn').classList.toggle('hidden', !['owner','admin','moderator'].includes(S.room.myRole));
}

function refreshModUI() {
  if (S.room) {
    const canMod = ['owner','admin'].includes(S.room.myRole);
    $('room-settings-btn').classList.toggle('hidden', !canMod);
    $('dj-btn').classList.toggle('hidden', !['owner','admin','moderator'].includes(S.room.myRole));
    // mod control box: staff + site owner
    $('modpanel-btn').classList.toggle('hidden',
      !(S.siteOwner || ['owner','admin','moderator'].includes(S.room.myRole)));
  }
}

$('leave-room-btn').onclick = () => {
  if (S.spectating) { wsSend({ type: 'spy-leave' }); stopSpectating(); }
  else { wsSend({ type: 'leave-room' }); leaveRoomUI(); }
};
function leaveRoomUI() {
  for (const [,p] of S.peers) try { p.pc.close(); } catch {}
  S.peers.clear(); S.room = null; S.roomUsers.clear();
  stopDjLocal();
  $('view-room').classList.add('hidden');
  $('view-lobby').classList.remove('hidden');
  $('spotlight').classList.add('hidden');
}

function onUserJoined(u) {
  S.roomUsers.set(u.id, u);
  addSysMsg(`👋 ${u.name} joined the room.`);
  addActivity('📥', u.name, 'entered the room');
  banner(`📥 ${u.name} joined the room`);
  joinSound();
  renderRoomHeader(); renderUserList();
  // they will send us the offer; nothing to do until signal arrives
}
function onUserLeft(id, reason) {
  const u = S.roomUsers.get(id);
  if (u) {
    addSysMsg(`👋 ${u.name} left${reason ? ' (' + reason + ')' : ''}.`);
    addActivity('📤', u.name, 'left the room' + (reason ? ' (' + reason + ')' : ''));
    banner(`📤 ${u.name} left the room`, 'leave');
    leaveSound();
  }
  S.roomUsers.delete(id);
  const p = S.peers.get(id);
  if (p) { try { p.pc.close(); } catch {} S.peers.delete(id); }
  if (S.spotlightId === id) { $('spotlight').classList.add('hidden'); S.spotlightId = null; }
  renderRoomHeader(); renderUserList(); renderVideoGrid();
}
function setUserProp(id, k, v) {
  const u = S.roomUsers.get(id);
  if (u) { u[k] = v; renderUserList(); }
}

/* ---------- user list + admin popup ---------- */
const ROLE_LABEL = { owner: '👑 owner', admin: '🛡 admin', moderator: '🔧 mod', member: '' };
const ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };

function renderUserList() {
  const el = $('user-list'); el.innerHTML = '';
  const me = { id: S.myId, name: S.myName + ' (you)', gender: S.myGender, age: S.myAge, status: $('status-select').value,
               role: S.room.myRole, muted: S.selfMuted, micLive: S.micOn && !S.selfMuted, videoOn: S.camOn,
               talking: S.micOn && !S.selfMuted };
  const all = [me, ...[...S.roomUsers.values()].sort((a,b) =>
    (ROLE_RANK[b.role]||0) - (ROLE_RANK[a.role]||0) || a.name.localeCompare(b.name))];
  for (const u of all) {
    const row = document.createElement('div');
    row.className = 'user-row ledger-row role-' + (u.role || 'member') + (u.restricted ? ' restricted-user' : '');
    const micIcon = u.muted ? '🔇' : (u.micLive ? '🎙️' : '🔈');
    const camIcon = u.videoOn ? '🎥' : '';
    const whoIcon = u.gender === 'f' ? '♀' : '♂';
    const ageTxt = (u.age ?? '') === '' ? '' : `${whoIcon} ${u.age}`;
    const canMod = S.siteOwner || (ROLE_RANK[S.room.myRole]||0) >= 1;
    const clickable = canMod && u.id !== S.myId;
    row.innerHTML = `${spenderBadge(u.medal, u.photo)}<span class="dot ${u.status||'online'}"></span>
      <span class="nm">${spenderNameBadge(u.medal)}${vipBadge(u.vip)}<b ${vipNameStyle(u.vip)}>${esc(u.name)}</b>${u.restricted ? ' <span class="restricted-tag">⚠️ RESTRICTED</span>' : ''}
      <span class="mic-btn${clickable ? ' clickable' : ''}" data-mic="${u.id}" title="${u.muted ? 'Muted — tap to unmute' : 'Live — tap to mute'}">${micIcon}</span>
      ${camIcon} ${u.talking ? '🟢' : ''}</span>
      <span class="who">${ageTxt}</span>
      <span class="st">${ROLE_LABEL[u.role] || ''}</span>`;
    if (u.id !== S.myId) row.onclick = (e) => {
      if (e.target.dataset.mic && clickable) { toggleUserMute(u); return; }
      showUserPopup(u, e.clientX, e.clientY);
    };
    else if (S.selfMuted) row.onclick = (e) => showSelfPopup(e.clientX, e.clientY);
    el.appendChild(row);
  }
  // legend for owner/mods
  if (S.siteOwner || (ROLE_RANK[S.room.myRole]||0) >= 1) {
    const lg = document.createElement('div');
    lg.className = 'mic-legend';
    lg.innerHTML = `🔇 muted &nbsp; 🎙️ live &nbsp; 🔈 off<br>
      <button id="god-mute-all" class="btn-ghost" style="margin:4px 4px 0 0;padding:6px 10px;font-size:.85em">🔇 Mute all</button>
      <button id="god-unmute-all" class="btn-ghost" style="margin:4px 0 0;padding:6px 10px;font-size:.85em">🔊 Unmute all</button>
      <div style="margin-top:4px;color:var(--muted)">tap any mic to mute/unmute</div>`;
    el.prepend(lg);
    lg.querySelector('#god-mute-all').onclick = (e) => { e.stopPropagation(); wsSend({ type: 'moderate', action: 'mute-all', roomId: S.room.id }); };
    lg.querySelector('#god-unmute-all').onclick = (e) => { e.stopPropagation(); wsSend({ type: 'moderate', action: 'unmute-all', roomId: S.room.id }); };
  }
}
/* quick mute toggle from user list */
function toggleUserMute(u) {
  wsSend({ type: 'moderate', action: u.muted ? 'unmute' : 'mute', target: u.id, roomId: S.room.id });
}

function showSelfPopup(x, y) {
  const pop = $('user-popup');
  pop.innerHTML = `<div style="font-weight:700;margin-bottom:6px">You</div>
    <button data-a="self-unmute">🔊 Unmute me</button>`;
  pop.classList.remove('hidden');
  pop.style.left = Math.min(x, innerWidth - 230) + 'px';
  pop.style.top = Math.min(y, innerHeight - 320) + 'px';
  pop.querySelector('[data-a="self-unmute"]').onclick = () => {
    pop.classList.add('hidden');
    wsSend({ type: 'mod-action', action: 'unmute', targetId: S.myId, roomId: S.room.id });
  };
}

function canActOn(target) {
  if (!S.room) return 0;
  if (S.siteOwner) return 99; // site owner can act on anyone, including while spying
  const mine = ROLE_RANK[S.room.myRole] || 0;
  const theirs = ROLE_RANK[target.role] || 0;
  return mine > theirs ? mine : 0;
}

function showUserPopup(u, x, y) {
  const pop = $('user-popup');
  const rank = canActOn(u);
  let html = `<div style="font-weight:700;margin-bottom:6px">${esc(u.name)}</div>`;
  html += `<button data-a="view">📹 View camera</button>`;
  html += `<button data-a="profile">👤 View profile</button>`;
  html += `<button data-a="dm">💬 Message</button>`;
  html += `<button data-a="gift">🎁 Send gift</button>`;
  html += `<button data-a="battle">⚔️ Battle</button>`;
  // owner in spy mode: record this person's camera only
  if (S.siteOwner && S.spectating) {
    const rec = spyRecorders.find(r => r.id === u.id);
    html += `<button data-a="record">${rec ? '⏹️ Stop recording' : '⏺️ Record camera'}</button>`;
  }
  if (rank >= 1) {
    html += `<button data-a="warn">⚠️ Warn</button>`;
    html += `<button data-a="mute">${u.muted ? '🔊 Unmute' : '🔇 Mute'}</button>`;
    html += `<button data-a="kick" class="danger">👢 Kick</button>`;
  }
  if (rank >= 2) {
    html += `<button data-a="ban" class="danger">🚫 Ban</button>`;
    html += `<button data-a="ipban" class="danger">🚫⛔ IP-ban</button>`;
  }
  if (u.restricted && S.siteOwner) html += `<button data-a="unrestrict">✅ Unblock user</button>`;
  if (rank >= 3) {
    html += `<button data-a="promote-mod">🔧 Make moderator</button>`;
    html += `<button data-a="promote-admin">🛡 Make admin</button>`;
    if ((ROLE_RANK[u.role]||0) > 0) html += `<button data-a="demote">⬇ Demote to member</button>`;
  }
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  pop.style.left = Math.min(x, innerWidth - 230) + 'px';
  pop.style.top = Math.min(y, innerHeight - 320) + 'px';
  pop.querySelectorAll('button').forEach(b => b.onclick = () => {
    pop.classList.add('hidden');
    userAction(b.dataset.a, u);
  });
}
document.addEventListener('click', e => {
  if (!$('user-popup').classList.contains('hidden') && !$('user-popup').contains(e.target))
    $('user-popup').classList.add('hidden');
});

function userAction(a, u) {
  if (a === 'view') { spotlight(u.id); return; }
  if (a === 'profile') { openProfile(u.name, false); return; }
  if (a === 'unrestrict') { wsSend({ type: 'moderate', action: 'unrestrict', name: u.name, roomId: S.room.id }); return; }
  if (a === 'dm') { openDm(u.id, u.name); return; }
  if (a === 'gift') { openGiftShop(u.id); return; }
  if (a === 'battle') { openBattlePicker(u); return; }
  if (a === 'warn') { openWarnModal(u); return; }
  if (a === 'record') { togglePeerRecord(u.id); return; }
  const map = { mute: u.muted ? 'unmute' : 'mute', kick: 'kick', ban: 'ban', ipban: 'ipban',
                'promote-mod': 'promote-mod', 'promote-admin': 'promote-admin', demote: 'demote' };
  const action = map[a];
  if (!action) return;
  if (['kick','ban','ipban'].includes(action)) {
    if (!confirm(`${action.toUpperCase()} ${u.name}?`)) return;
  }
  wsSend({ type: 'mod-action', action, targetId: u.id, roomId: S.room.id });
}

/* ---- mod panel: ban/kick/mute controls in one easy box ---- */
function openModPanel() {
  $('modpanel-modal').classList.remove('hidden');
  $('modpanel-room').textContent = S.room ? S.room.name : '';
  renderModPanelUsers();
  wsSend({ type: 'get-ban-list' });
}
function renderModPanelUsers() {
  const el = $('modpanel-users'); el.innerHTML = '';
  const users = [...S.roomUsers.values()].filter(u => u.id !== S.myId);
  if (!users.length) { el.innerHTML = '<p class="fineprint">Just you here.</p>'; return; }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'modpanel-row';
    const rank = canActOn(u);
    row.innerHTML = `<span class="nm">${u.photo ? `<img src="${esc(u.photo)}" class="vphoto" style="width:28px;height:28px" alt="">` : ''}<b>${esc(u.name)}</b>
        <small style="color:var(--muted)">${ROLE_LABEL[u.role] || ''}${u.muted ? ' · 🔇 muted' : ''}</small></span>
      <span class="modpanel-btns"></span>`;
    const btns = row.querySelector('.modpanel-btns');
    const addBtn = (label, action, danger, confirmMsg) => {
      const b = document.createElement('button');
      b.className = 'btn-ghost' + (danger ? ' danger' : '');
      b.textContent = label; b.title = label;
      b.onclick = () => {
        if (confirmMsg && !confirm(confirmMsg)) return;
        wsSend({ type: 'mod-action', action, targetId: u.id, roomId: S.room.id });
        setTimeout(renderModPanelUsers, 600);
      };
      btns.appendChild(b);
    };
    if (rank >= 1) {
      addBtn(u.muted ? '🔊' : '🔇', u.muted ? 'unmute' : 'mute');
      const wb = document.createElement('button');
      wb.className = 'btn-ghost'; wb.textContent = '⚠️'; wb.title = 'Warn';
      wb.onclick = () => { $('modpanel-modal').classList.add('hidden'); openWarnModal(u); };
      btns.appendChild(wb);
      addBtn('👢', 'kick', true, `Kick ${u.name}?`);
    }
    if (rank >= 2) {
      addBtn('🚫', 'ban', true, `Ban ${u.name}?`);
      addBtn('⛔', 'ipban', true, `IP-BAN ${u.name}? This blocks their network.`);
    }
    if (!btns.children.length) btns.innerHTML = '<small class="fineprint">no permission</small>';
    el.appendChild(row);
  }
}
function renderModPanelBans(bans) {
  const el = $('modpanel-bans'); el.innerHTML = '';
  if (!bans.length) { el.innerHTML = '<p class="fineprint">Nobody banned. 🎉</p>'; return; }
  for (const b of bans) {
    const row = document.createElement('div');
    row.className = 'ban-row';
    row.innerHTML = `<span class="nm">${esc(b.name)} <small style="color:var(--muted)">${esc(b.ip)} · by ${esc(b.by)}</small></span>`;
    const ub = document.createElement('button');
    ub.className = 'btn-ghost'; ub.textContent = 'Unban';
    ub.onclick = () => { wsSend({ type: 'mod-action', action: 'unban', targetId: b.id, roomId: S.room.id }); setTimeout(() => wsSend({ type: 'get-ban-list' }), 600); };
    row.appendChild(ub);
    el.appendChild(row);
  }
}

/* ---- warn presets (private) ---- */
const WARN_PRESETS = [
  '🎙️ Stop hogging the mic — let others talk.',
  '🚫 No spamming the chat.',
  '🤬 Watch your language.',
  '📹 Keep your camera appropriate.',
  '😤 Stop harassing other users.',
  '👋 Final warning — next violation is a ban.'
];
let warnTarget = null;
function openWarnModal(u) {
  warnTarget = u;
  $('warn-target').textContent = u.name;
  const el = $('warn-presets'); el.innerHTML = '';
  WARN_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn-ghost warn-preset'; b.textContent = p;
    b.onclick = () => sendWarn(p);
    el.appendChild(b);
  });
  $('warn-custom').value = '';
  $('warn-modal').classList.remove('hidden');
}
function sendWarn(reason) {
  if (!warnTarget || !S.room) return;
  wsSend({ type: 'mod-action', action: 'warn', targetId: warnTarget.id, roomId: S.room.id, reason: (reason || '').slice(0, 200) });
  $('warn-modal').classList.add('hidden');
  toast('⚠️ Warning sent privately to ' + warnTarget.name);
}
$('warn-send').onclick = () => sendWarn($('warn-custom').value.trim());
$('warn-close').onclick = () => $('warn-modal').classList.add('hidden');

/* ---- trivia champions board ---- */
const BOARD_MEDALS = ['🥇', '🥈', '🥉', '4.', '5.'];
function renderTriviaBoard() {
  const el = $('trivia-board'); if (!el) return;
  el.innerHTML = '';
  const board = (S.triviaBoard || []).slice(0, 5);
  if (!board.length) { el.innerHTML = '<p class="fineprint">No champions yet — type !trivia to play!</p>'; return; }
  board.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'champ-row' + (i === 0 ? ' champ-top' : '');
    row.innerHTML = `<span>${BOARD_MEDALS[i] || (i + 1) + '.'}</span><b>${esc(s.name)}</b><span class="champ-score">${s.score} pts</span>`;
    el.appendChild(row);
  });
}

/* ---- halloween jump-scare celebration ---- */
function halloweenCelebration(winners) {
  const ov = document.createElement('div');
  ov.id = 'spooky-overlay';
  const pop = document.createElement('div');
  pop.className = 'spooky-pop';
  pop.textContent = '👻';
  const winHead = document.createElement('div');
  winHead.className = 'spooky-winner-head';
  winHead.textContent = '🏆 WINNER 🏆';
  const txt = document.createElement('div');
  txt.className = 'spooky-text';
  txt.textContent = `${winners.join(', ')} got it right!`;
  ov.appendChild(pop); ov.appendChild(winHead); ov.appendChild(txt);
  const emojis = ['🎃', '👻', '🦇', '🍬', '🕷️', '💀', '🕸️'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.className = 'spooky-fall';
    s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    s.style.left = (Math.random() * 100) + 'vw';
    s.style.animationDelay = (Math.random() * 1.6) + 's';
    s.style.fontSize = (1.4 + Math.random() * 2.2) + 'em';
    ov.appendChild(s);
  }
  document.body.appendChild(ov);
  playSpookySting();
  crownWinners(winners);
  const kill = () => { if (ov.parentNode) ov.remove(); };
  ov.onclick = kill;
  setTimeout(kill, 6000);
}

/* ---- ambient spooky sound effects ---- */
function playSpookySound(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.resume) ctx.resume();
    const t = ctx.currentTime, out = ctx.destination;
    function tone(o) {
      const { type = 'sine', f0 = 440, f1 = null, t0 = 0, dur = 1, vol = 0.15, lfoF = null, lfoAmt = 0 } = o;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t + t0);
      if (f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + t0 + dur);
      let lfo;
      if (lfoF) {
        lfo = ctx.createOscillator(); const lg = ctx.createGain();
        lfo.frequency.value = lfoF; lg.gain.value = lfoAmt;
        lfo.connect(lg); lg.connect(osc.frequency);
      }
      g.gain.setValueAtTime(0.0001, t + t0);
      g.gain.exponentialRampToValueAtTime(vol, t + t0 + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + t0 + dur);
      osc.connect(g); g.connect(out);
      osc.start(t + t0); osc.stop(t + t0 + dur + 0.1);
      if (lfo) { lfo.start(t + t0); lfo.stop(t + t0 + dur + 0.1); }
    }
    function noise(o) {
      const { t0 = 0, dur = 1, vol = 0.2, fc = 800 } = o;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = fc;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + t0);
      g.gain.exponentialRampToValueAtTime(vol, t + t0 + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + t0 + dur);
      src.connect(flt); flt.connect(g); g.connect(out);
      src.start(t + t0);
    }
    switch (kind) {
      case 'wail': // ghost wail
        tone({ type: 'triangle', f0: 700, f1: 340, dur: 2.4, vol: 0.11, lfoF: 6, lfoAmt: 130 });
        break;
      case 'thunder': // distant thunder
        noise({ dur: 2.6, vol: 0.28, fc: 200 });
        noise({ t0: 0.2, dur: 1.6, vol: 0.18, fc: 110 });
        break;
      case 'creak': // creaking door
        tone({ type: 'sawtooth', f0: 150, f1: 85, dur: 1.7, vol: 0.06, lfoF: 9, lfoAmt: 45 });
        break;
      case 'cackle': // witch cackle
        [0, 0.17, 0.34, 0.55, 0.78].forEach((dt, i) =>
          tone({ type: 'square', f0: 920 - i * 95, f1: 700 - i * 95, t0: dt, dur: 0.13, vol: 0.05 }));
        break;
      case 'howl': // wolf howl
        tone({ type: 'triangle', f0: 300, f1: 620, dur: 0.9, vol: 0.11 });
        tone({ type: 'triangle', f0: 620, f1: 440, t0: 0.9, dur: 1.6, vol: 0.11, lfoF: 5, lfoAmt: 35 });
        break;
      default:
        tone({ type: 'triangle', f0: 700, f1: 340, dur: 2, vol: 0.1, lfoF: 6, lfoAmt: 120 });
    }
    setTimeout(() => { try { ctx.close(); } catch {} }, 4500);
  } catch {}
}

/* ---- rizz bot robot voice ---- */
function robotSpeak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = 0.2;   // low pitch = robotic
    u.rate = 1.05;
    u.volume = 0.9;
    const voices = speechSynthesis.getVoices();
    const v = voices.find(v => /google uk english male|daniel|google us english/i.test(v.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch {}
}

/* ---- rizz bot sound effects ---- */
function playRizzSound(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.resume) ctx.resume();
    const t = ctx.currentTime, out = ctx.destination;
    function tone(type, f0, f1, t0, dur, vol) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + t0 + dur);
      g.gain.setValueAtTime(0.0001, t + t0);
      g.gain.exponentialRampToValueAtTime(vol, t + t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + t0 + dur);
      o.connect(g); g.connect(out);
      o.start(t + t0); o.stop(t + t0 + dur + 0.1);
    }
    switch (kind) {
      case 'airhorn': // classic hype horn
        [466, 471, 461].forEach(f => tone('sawtooth', f, f, 0, 1.1, 0.1));
        tone('square', 233, 233, 0, 1.1, 0.04);
        break;
      case 'whistle': // wolf whistle
        tone('sine', 700, 1400, 0, 0.35, 0.2);
        tone('sine', 1400, 1400, 0.35, 0.12, 0.2);
        tone('sine', 1400, 550, 0.47, 0.55, 0.2);
        break;
      case 'chaching': // cash register
        tone('sine', 987.77, 987.77, 0, 0.12, 0.2);
        tone('sine', 1318.51, 1318.51, 0.12, 0.5, 0.2);
        break;
      case 'kiss': // mwah!
        tone('sine', 900, 180, 0, 0.14, 0.25);
        break;
      case 'smooth': // jazzy major-7th lift
        [261.63, 329.63, 392.0, 493.88].forEach((f, i) => tone('triangle', f, f, i * 0.09, 0.7, 0.11));
        break;
      case 'womp': { // sad trombone — the diss sting
        const notes = [[196.0, 0, 0.28], [185.0, 0.28, 0.28], [174.61, 0.56, 0.28], [164.81, 0.84, 0.7]];
        notes.forEach(([f, t0, dur]) => {
          const o = ctx.createOscillator(), g = ctx.createGain(), v = ctx.createOscillator(), vg = ctx.createGain();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t + t0);
          o.frequency.linearRampToValueAtTime(f * 0.94, t + t0 + dur);
          v.frequency.value = 5.5; vg.gain.value = 6;
          v.connect(vg); vg.connect(o.frequency);
          g.gain.setValueAtTime(0.0001, t + t0);
          g.gain.exponentialRampToValueAtTime(0.16, t + t0 + 0.04);
          g.gain.exponentialRampToValueAtTime(0.0001, t + t0 + dur);
          o.connect(g); g.connect(out);
          o.start(t + t0); v.start(t + t0);
          o.stop(t + t0 + dur + 0.05); v.stop(t + t0 + dur + 0.05);
        });
        break;
      }
      case 'buzz': // robot error buzz
        tone('square', 120, 90, 0, 0.7, 0.14);
        tone('square', 90, 70, 0, 0.7, 0.1);
        break;
      case 'laser': // robot zap
        tone('sawtooth', 2200, 120, 0, 0.32, 0.12);
        break;
      case 'rizzlaugh': { // 🤖 robot laugh ha-ha-ha
        for (let i = 0; i < 5; i++) {
          const t0 = i * 0.17;
          const f = 400 - i * 30;
          const o = ctx.createOscillator(), g = ctx.createGain();
          const lfo = ctx.createOscillator(), lg = ctx.createGain();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t + t0);
          o.frequency.exponentialRampToValueAtTime(Math.max(60, f * 0.7), t + t0 + 0.14);
          lfo.type = 'square'; lfo.frequency.value = 32;
          lg.gain.value = 0.08;
          lfo.connect(lg); lg.connect(g.gain);
          g.gain.setValueAtTime(0.08, t + t0);
          g.gain.setValueAtTime(0.0001, t + t0 + 0.15);
          o.connect(g); g.connect(out);
          o.start(t + t0); lfo.start(t + t0);
          o.stop(t + t0 + 0.16); lfo.stop(t + t0 + 0.16);
        }
        break;
      }
      default:
        [466, 471, 461].forEach(f => tone('sawtooth', f, f, 0, 1.0, 0.1));
    }
    setTimeout(() => { try { ctx.close(); } catch {} }, 3000);
  } catch {}
}

/* crown the winner's video tile so everyone sees who got it */
const winnerCrownTimers = new Map();
function crownWinners(winners) {
  if (!winners.length) return;
  for (const [id, u] of S.roomUsers) {
    if (!winners.includes(u.name)) continue;
    const tile = document.querySelector(`.video-tile[data-peer="${id}"]`);
    if (!tile) continue;
    tile.classList.add('trivia-winner');
    let badge = tile.querySelector('.winner-crown');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'winner-crown';
      badge.textContent = '👑';
      badge.title = 'Trivia winner!';
      tile.appendChild(badge);
    }
    clearTimeout(winnerCrownTimers.get(id));
    winnerCrownTimers.set(id, setTimeout(() => {
      tile.classList.remove('trivia-winner');
      const b = tile.querySelector('.winner-crown');
      if (b) b.remove();
      winnerCrownTimers.delete(id);
    }, 45000));
  }
}
function playSpookySting() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.resume) ctx.resume();
    const t = ctx.currentTime;
    // dissonant descending scare chord
    [[587, 0], [622, 0.02]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t + dt);
      o.frequency.exponentialRampToValueAtTime(110, t + dt + 0.9);
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.22, t + dt + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 1.2);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + dt); o.stop(t + dt + 1.3);
    });
    // warbly ghost wail
    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    o2.type = 'triangle'; o2.frequency.value = 880;
    lfo.type = 'sine'; lfo.frequency.value = 11; lg.gain.value = 220;
    lfo.connect(lg); lg.connect(o2.frequency);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.1, t + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o2.connect(g2); g2.connect(ctx.destination);
    o2.start(t); lfo.start(t); o2.stop(t + 1.2); lfo.stop(t + 1.2);
    setTimeout(() => { try { ctx.close(); } catch {} }, 2500);
  } catch {}
}
/* ---- gifts ---- */
function updateCoinDisplay() {
  const bal = S.coins || 0;
  const a = $('coin-balance'); if (a) a.textContent = `🪙 ${bal}`;
  const b = $('gift-coins'); if (b) b.textContent = `🪙 ${bal}`;
}
let giftToId = null;
function openGiftShop(toId) {
  giftToId = toId || null;
  const sel = $('gift-to');
  sel.innerHTML = '';
  const users = [...S.roomUsers.values()].filter(u => u.id !== S.myId);
  for (const u of users) {
    const o = document.createElement('option');
    o.value = u.id; o.textContent = u.name;
    if (u.id === giftToId) o.selected = true;
    sel.appendChild(o);
  }
  if (!users.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'No one else here yet — gifts need a recipient';
    sel.appendChild(o);
  }
  giftToId = sel.value || null;
  sel.onchange = () => { giftToId = sel.value || null; };
  const grid = $('gift-grid');
  grid.innerHTML = '';
  for (const g of (S.gifts || [])) {
    const b = document.createElement('button');
    b.className = 'gift-item' + ((S.coins || 0) < g.cost ? ' poor' : '');
    b.innerHTML = `<span class="ge">${g.emoji}</span><span class="gn">${esc(g.name)}</span><span class="gc">🪙${g.cost}</span>`;
    b.onclick = () => {
      if (!giftToId) { toast('Wait for someone to join, then send them a gift! 🎁'); return; }
      if ((S.coins || 0) < g.cost) { toast(`Not enough coins for ${g.name} 🪙`); return; }
      wsSend({ type: 'send-gift', to: giftToId, giftId: g.id });
      $('gift-modal').classList.add('hidden');
    };
    grid.appendChild(b);
  }
  updateCoinDisplay();
  $('gift-modal').classList.remove('hidden');
}
/* ---- stock-ticker gift board ---- */
const tickerItems = [];
function seedTicker(m) {
  const tape = $('ticker-tape');
  if (!tape) return;
  tickerItems.length = 0;
  if (m.sent[0]) tickerItems.push(`<span class="ticker-item"><span class="tk-up">▲</span> Top sender: <b>${esc(m.sent[0].name)}</b> <span class="tk-coins">🪙${m.sent[0].coins.toLocaleString()}</span></span>`);
  if (m.received[0]) tickerItems.push(`<span class="ticker-item"><span class="tk-up">▲</span> Top receiver: <b>${esc(m.received[0].name)}</b> <span class="tk-coins">🪙${m.received[0].coins.toLocaleString()}</span></span>`);
  if (!tickerItems.length) tickerItems.push('<span class="ticker-item">🎁 No gifts yet — be the first!</span>');
  tape.innerHTML = tickerItems.join('') + tickerItems.join('');
}
function tickerAddGift(m) {
  const tape = $('ticker-tape');
  if (!tape) return;
  const g = m.gift;
  tickerItems.push(`<span class="ticker-item">${g.emoji} <b>${esc(m.fromName)}</b> → <b>${esc(m.toName)}</b> <span class="tk-coins">🪙${g.cost.toLocaleString()}</span></span>`);
  if (tickerItems.length > 20) tickerItems.shift();
  // duplicate for seamless loop
  tape.innerHTML = tickerItems.join('') + tickerItems.join('');
  // restart animation to include new content
  tape.style.animation = 'none'; void tape.offsetWidth; tape.style.animation = '';
}
$('gift-lb-btn').onclick = () => openGiftLeaderboard();
$('gift-btn').onclick = () => openGiftShop();
$('visitors-btn').onclick = () => openRoomVisitors();
$('modpanel-btn').onclick = () => openModPanel();
$('modpanel-close').onclick = () => $('modpanel-modal').classList.add('hidden');
$('modpanel-refresh-bans').onclick = () => wsSend({ type: 'get-ban-list' });

/* ---- owner spy mode: invisibly watch private 1-on-1s ---- */
function onSpyJoined(m) {
  for (const [, p] of S.peers) try { p.pc.close(); } catch {}
  S.peers.clear(); S.hiddenPeers.clear();
  S.spectating = m.room.id;
  S.room = { id: m.room.id, name: m.room.name, spectating: true };
  S.roomUsers = new Map(m.users.map(u => [u.id, u]));
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');
  $('chat-log').innerHTML = '';
  let banner = $('spy-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'spy-banner';
    document.querySelector('#view-room').prepend(banner);
  }
  banner.innerHTML = `👁️ <b>SPY MODE</b> — invisibly watching <b>${esc(m.room.name)}</b> <button id="spy-record-btn" class="btn-ghost" title="Record this session">⏺️ Record</button> <button id="spy-leave-btn" class="btn-ghost">✕ Stop watching</button>`;
  banner.classList.remove('hidden');
  $('spy-leave-btn').onclick = () => wsSend({ type: 'spy-leave' });
  $('spy-record-btn').onclick = () => toggleSpyRecord();
  renderRoomHeader();
  for (const u of m.users) createPeer(u.id, true, true);
  renderVideoGrid();
}
function stopSpectating() {
  if (spyRecorders.length) stopSpyRecord();
  for (const [, p] of S.peers) try { p.pc.close(); } catch {}
  S.peers.clear(); S.hiddenPeers.clear();
  S.spectating = null; S.room = null; S.roomUsers.clear();
  const banner = $('spy-banner');
  if (banner) banner.classList.add('hidden');
  $('view-room').classList.add('hidden');
  $('view-lobby').classList.remove('hidden');
}

/* ---- spy-mode recording (owner only): individual cameras, silent ---- */
let spyRecorders = [];
function startPeerRecorder(id, stream) {
  if (spyRecorders.find(r => r.id === id)) return null;
  try {
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => saveSpyRecording(id, chunks, mime);
    rec.start(1000);
    const entry = { id, rec, chunks };
    spyRecorders.push(entry);
    return entry;
  } catch (e) { console.warn('recorder failed for', id, e); return null; }
}
function stopPeerRecorder(id) {
  const i = spyRecorders.findIndex(r => r.id === id);
  if (i < 0) return;
  try { spyRecorders[i].rec.stop(); } catch {}
  spyRecorders.splice(i, 1);
}
/* record one person's camera only */
function togglePeerRecord(peerId) {
  if (spyRecorders.find(r => r.id === peerId)) {
    stopPeerRecorder(peerId);
    toast('⏹️ Recording stopped — saving…');
  } else {
    const p = S.peers.get(peerId);
    if (!p || !p.stream || !p.stream.getTracks().length) { toast('No camera stream yet.'); return; }
    if (startPeerRecorder(peerId, p.stream)) {
      const u = S.roomUsers.get(peerId);
      toast(`⏺️ Recording ${u ? u.name : 'camera'}…`);
    }
  }
  updateSpyRecordBtn();
  if (S.room) renderUserList();
}
/* record every camera in the room (one file per person) */
function toggleSpyRecord() {
  if (spyRecorders.length) { stopSpyRecord(); return; }
  const streams = [...S.peers.entries()].filter(([, p]) => p.stream && p.stream.getTracks().length);
  if (!streams.length) { toast('No video streams to record yet.'); return; }
  for (const [id, p] of streams) startPeerRecorder(id, p.stream);
  updateSpyRecordBtn();
  toast(`⏺️ Recording ${spyRecorders.length} camera(s) — one file each…`);
}
function updateSpyRecordBtn() {
  const btn = $('spy-record-btn');
  if (btn) {
    const n = spyRecorders.length;
    btn.innerHTML = n ? `⏹️ Stop (${n})` : '⏺️ Record';
    btn.classList.toggle('recording', n > 0);
  }
}
function stopSpyRecord() {
  for (const r of [...spyRecorders]) stopPeerRecorder(r.id);
  updateSpyRecordBtn();
}
function saveSpyRecording(peerId, chunks, mime) {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const u = S.roomUsers.get(peerId);
  const name = (u ? u.name : peerId).replace(/[^a-z0-9]+/gi, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `camwave_${name}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  toast('💾 Recording saved — check your downloads.');
}

let battleTarget = null;
function openBattlePicker(u) {
  battleTarget = u;
  let m = $('battle-picker-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'battle-picker-modal';
    m.className = 'modal';
    m.innerHTML = `<div class="modal-card">
      <h3>⚔️ Battle <span id="battle-picker-name"></span></h3>
      <p class="fineprint">Pick a game — 5:00 on the clock!</p>
      <div class="battle-modes">
        <button class="battle-mode-btn" data-mode="gifts">🎁<b>Gift Battle</b><span>Most gift coins wins</span></button>
        <button class="battle-mode-btn" data-mode="taps">👆<b>Tap Battle</b><span>Everyone taps — most taps wins</span></button>
        <button class="battle-mode-btn" data-mode="trivia">🧠<b>Trivia Battle</b><span>Most correct answers wins</span></button>
      </div>
      <div class="modal-actions"><button id="battle-picker-cancel" class="btn-ghost">Cancel</button></div>
    </div>`;
    document.body.appendChild(m);
    m.querySelector('#battle-picker-cancel').onclick = () => m.classList.add('hidden');
    m.querySelectorAll('.battle-mode-btn').forEach(b => b.onclick = () => {
      wsSend({ type: 'battle-challenge', to: battleTarget.id, mode: b.dataset.mode });
      m.classList.add('hidden');
    });
  }
  m.querySelector('#battle-picker-name').textContent = u.name;
  m.classList.remove('hidden');
}

let S_battle = null, battleTickTimer = null;
function onBattleMessage(m) {
  if (m.type === 'battle-challenge') {
    let c = $('battle-challenge-modal');
    if (!c) {
      c = document.createElement('div');
      c.id = 'battle-challenge-modal';
      c.className = 'modal';
      c.innerHTML = `<div class="modal-card battle-challenge-card">
        <h3>⚔️ BATTLE CHALLENGE!</h3>
        <p id="battle-challenge-text"></p>
        <div class="modal-actions">
          <button id="battle-accept-btn" class="btn-primary">Accept ⚔️</button>
          <button id="battle-decline-btn" class="btn-ghost">Decline</button>
        </div>
      </div>`;
      document.body.appendChild(c);
      c.querySelector('#battle-accept-btn').onclick = () => { wsSend({ type: 'battle-accept' }); c.classList.add('hidden'); };
      c.querySelector('#battle-decline-btn').onclick = () => { wsSend({ type: 'battle-decline' }); c.classList.add('hidden'); };
    }
    c.querySelector('#battle-challenge-text').innerHTML =
      `<b>${esc(m.fromName)}</b> challenges you to a<br><b>${esc(m.modeName)}</b>! ⏱ 5:00`;
    c.classList.remove('hidden');
    setTimeout(() => c.classList.add('hidden'), 60000);
  }
  else if (m.type === 'battle-sent') toast(`⚔️ Challenge sent to ${m.toName}!`);
  else if (m.type === 'battle-declined') toast(`😅 ${m.toName} declined your battle.`);
  else if (m.type === 'battle-expired') toast(`⏰ Challenge to ${m.toName} expired.`);
  else if (m.type === 'battle-start') startBattleUI(m);
  else if (m.type === 'battle-score') updateBattleScores(m.scores);
  else if (m.type === 'battle-end') endBattleUI(m);
}
function startBattleUI(m) {
  S_battle = m;
  let bar = $('battle-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'battle-bar';
    document.querySelector('#view-room').prepend(bar);
  }
  const isTap = m.mode === 'taps';
  bar.innerHTML = `
    <div class="battle-top"><span class="battle-mode-tag">${esc(m.modeName)}</span><span class="battle-timer" id="battle-timer">5:00</span></div>
    <div class="battle-vs">
      <div class="battle-side p1"><b>${esc(m.p1.name)}</b><span class="battle-score" id="battle-score-1">0</span>
        ${isTap ? `<button class="tap-btn" data-side="${m.p1.id}">👆 TAP!</button>` : ''}</div>
      <div class="battle-mid">🆚</div>
      <div class="battle-side p2"><b>${esc(m.p2.name)}</b><span class="battle-score" id="battle-score-2">0</span>
        ${isTap ? `<button class="tap-btn" data-side="${m.p2.id}">👆 TAP!</button>` : ''}</div>
    </div>
    ${m.mode === 'gifts' ? '<div class="battle-hint">🎁 Send gifts to your fighter!</div>' : ''}
    ${m.mode === 'trivia' ? '<div class="battle-hint">🧠 Battlers: answer with A/B/C/D!</div>' : ''}`;
  bar.classList.remove('hidden');
  bar.querySelectorAll('.tap-btn').forEach(b => b.onclick = () => {
    wsSend({ type: 'battle-tap', side: b.dataset.side });
    b.classList.remove('tapped'); void b.offsetWidth; b.classList.add('tapped');
  });
  updateBattleScores(m.scores);
  if (battleTickTimer) clearInterval(battleTickTimer);
  battleTickTimer = setInterval(() => {
    if (!S_battle) { clearInterval(battleTickTimer); return; }
    const left = Math.max(0, S_battle.endsAt - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor(left % 60000 / 1000);
    const el = $('battle-timer');
    if (el) { el.textContent = mm + ':' + String(ss).padStart(2, '0'); el.classList.toggle('urgent', left < 30000); }
    if (left <= 0) clearInterval(battleTickTimer);
  }, 500);
}
function updateBattleScores(scores) {
  if (!S_battle || !scores) return;
  const s1 = scores[S_battle.p1.id] || 0, s2 = scores[S_battle.p2.id] || 0;
  const e1 = $('battle-score-1'), e2 = $('battle-score-2');
  if (e1) e1.textContent = s1.toLocaleString();
  if (e2) e2.textContent = s2.toLocaleString();
  // leader glow
  document.querySelectorAll('.battle-side').forEach(el => el.classList.remove('leading'));
  if (s1 !== s2) {
    const lead = s1 > s2 ? '.battle-side.p1' : '.battle-side.p2';
    const el = document.querySelector(lead);
    if (el) el.classList.add('leading');
  }
}
function endBattleUI(m) {
  if (battleTickTimer) clearInterval(battleTickTimer);
  S_battle = null;
  const bar = $('battle-bar');
  if (bar) setTimeout(() => bar.classList.add('hidden'), 8000);
  const ov = document.createElement('div');
  ov.id = 'gift-overlay';
  ov.classList.add('legendary');
  const s1 = m.scores[m.p1.id] || 0, s2 = m.scores[m.p2.id] || 0;
  ov.innerHTML = `<div class="legend-flash"></div>
    <div class="legend-actor scene-default">🏆</div>
    <div class="legend-caption">${m.isDraw ? "IT'S A DRAW!" : esc(m.winner.name) + ' WINS!'}</div>
    <div class="gift-text">${esc(m.modeName)}</div>
    <div class="gift-name">${esc(m.p1.name)} ${s1.toLocaleString()} — ${s2.toLocaleString()} ${esc(m.p2.name)}</div>`;
  document.body.appendChild(ov);
  const kill = () => { if (ov.parentNode) ov.remove(); };
  ov.onclick = kill;
  setTimeout(kill, 6000);
}

/* ---- top spenders: floating 1st/2nd/3rd banner in every room ---- */
function medalRank(medal) { return medal === '🥇' ? 1 : medal === '🥈' ? 2 : medal === '🥉' ? 3 : 0; }
/* photo badge with medal ring — stands out like a real award */
function spenderBadge(medal, photo, mini) {
  const r = medalRank(medal);
  if (!r) return '';
  return `<span class="spender-badge rank-${r}${mini ? ' mini' : ''}"><span class="sb-photo">${photo ? `<img src="${esc(photo)}" alt="">` : '👤'}</span><i class="sb-rank">${r}</i></span>`;
}
/* name pill badge: "1ST", "2ND", "3RD" */
function spenderNameBadge(medal) {
  const r = medalRank(medal);
  if (!r) return '';
  const label = ['1ST', '2ND', '3RD'][r - 1];
  return `<span class="name-badge rank-${r}">🏆 ${label}</span>`;
}
function renderTopSpenders(top) {
  const html = top.length
    ? `<span class="ts-label">🏆 TOP SPENDERS</span>` + top.map(t => {
        const r = medalRank(t.medal);
        return `<span class="ts-chip${r === 1 ? ' first' : ''}">${spenderBadge(t.medal, null, true)} ${esc(t.name)} <small>🪙${t.coins.toLocaleString()}</small></span>`;
      }).join('')
    : '';
  for (const id of ['top-spenders-lobby', 'top-spenders-room']) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = html;
    el.classList.toggle('hidden', !top.length);
  }
}

/* ---- VIP tiers: status badges + name colors ---- */
function vipBadge(vip) {
  if (!vip) return '';
  return `<span class="vip-badge" style="--vip-color:${vip.color}" title="${vip.icon} ${vip.name} VIP">${vip.icon} ${vip.name}</span>`;
}
function vipNameStyle(vip) {
  return vip ? `style="color:${vip.color}"` : '';
}

/* ---- room gift goal progress bar ---- */
function renderGiftGoal(goal, completed) {
  let bar = $('gift-goal-bar');
  if (completed) {
    if (bar) bar.classList.add('hidden');
    banner('🎯 GOAL SMASHED! 🎉', 'goal');
    return;
  }
  if (!goal) { if (bar) bar.classList.add('hidden'); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'gift-goal-bar';
    document.querySelector('#view-room').prepend(bar);
  }
  const pct = Math.min(100, 100 * goal.raised / goal.target);
  bar.innerHTML = `<span class="gg-label">🎯 GOAL 🪙${goal.raised.toLocaleString()} / 🪙${goal.target.toLocaleString()}</span>
    <div class="gg-track"><div class="gg-fill" style="width:${pct}%"></div></div>
    <span class="gg-pct">${pct.toFixed(0)}%</span>`;
  bar.classList.remove('hidden');
}

/* ---- whale spotlight: golden frame on big gifter ---- */
function giftSpotlight(m) {
  const tile = document.querySelector(`.video-tile[data-peer="${m.id}"]`);
  if (tile) {
    tile.classList.add('whale-spotlight');
    setTimeout(() => tile.classList.remove('whale-spotlight'), 30000);
  }
  banner(`🐋 ${m.name} dropped 🪙${m.cost.toLocaleString()}!`, 'whale');
}

/* ---- private-session alert for the site owner ---- */
function privateAlert(m) {
  toast(m.text);
  banner(m.text, 'private');
  // ping sound to make sure it's noticed
  __beep(880, .15); __beep(1174, .2, .12, .15);
  // add a quick-jump button to spy on it
  let n = $('private-alert');
  if (!n) {
    n = document.createElement('div');
    n.id = 'private-alert';
    document.body.appendChild(n);
  }
  n.innerHTML = `<span>${esc(m.text)}</span><button class="btn-primary">👁️ Watch</button><button class="btn-ghost">✕</button>`;
  n.classList.remove('hidden');
  n.querySelector('.btn-primary').onclick = () => {
    n.classList.add('hidden');
    if (S.spectating) wsSend({ type: 'spy-leave' });
    wsSend({ type: 'spy-join', roomId: m.roomId });
  };
  n.querySelector('.btn-ghost').onclick = () => n.classList.add('hidden');
  // auto-dismiss after 30s
  clearTimeout(n._t);
  n._t = setTimeout(() => n.classList.add('hidden'), 30000);
}

/* ---- room visitors ---- */
function openRoomVisitors() {
  wsSend({ type: 'get-room-visitors' });
}
function showRoomVisitors(m) {
  let md = $('visitors-modal');
  if (!md) {
    md = document.createElement('div');
    md.id = 'visitors-modal';
    md.className = 'modal';
    md.innerHTML = `<div class="modal-card">
      <h3>📊 Room Visitors</h3>
      <p class="fineprint" id="visitors-total"></p>
      <div id="visitors-list" class="visitors-list"></div>
      <div class="modal-actions"><button id="visitors-close" class="btn-ghost">Close</button></div>
    </div>`;
    document.body.appendChild(md);
    md.querySelector('#visitors-close').onclick = () => md.classList.add('hidden');
  }
  md.querySelector('#visitors-total').textContent =
    `${m.total.toLocaleString()} total visits to ${m.roomName}`;
  md.querySelector('#visitors-list').innerHTML = m.visitors.length ? m.visitors.map(v => `
    <div class="visitor-row">
      ${v.photo ? `<img src="${esc(v.photo)}" class="vphoto" alt="">` : '<div class="vphoto vphoto-none">👤</div>'}
      <div class="vinfo"><strong>${esc(v.name)}</strong><br><small>${new Date(v.ts).toLocaleString()}</small></div>
      <button class="btn-ghost vmsg" data-id="${esc(v.id)}" data-name="${esc(v.name)}">💬</button>
    </div>`).join('') : '<p class="fineprint">No visitors yet.</p>';
  md.querySelectorAll('.vmsg').forEach(b => b.onclick = () => openDm(b.dataset.id, b.dataset.name));
  md.classList.remove('hidden');
}

/* ---- gift leaderboard ---- */
function openGiftLeaderboard() {
  wsSend({ type: 'get-gift-leaderboard' });
}
function showGiftLeaderboard(m) {
  let lb = $('gift-lb-modal');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'gift-lb-modal';
    lb.className = 'modal';
    lb.innerHTML = `<div class="modal-card">
      <h3>🎁 Gift Leaders</h3>
      <div class="lb-cols">
        <div><h4>💸 Top Senders</h4><div id="lb-sent"></div></div>
        <div><h4>👑 Top Receivers</h4><div id="lb-received"></div></div>
      </div>
      <div class="modal-actions"><button id="gift-lb-close" class="btn-ghost">Close</button></div>
    </div>`;
    document.body.appendChild(lb);
    lb.querySelector('#gift-lb-close').onclick = () => lb.classList.add('hidden');
  }
  const row = (x, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `<div class="lb-row"><span>${medal} ${esc(x.name)}</span><span>🪙${x.coins.toLocaleString()} <small>(${x.count})</small></span></div>`;
  };
  lb.querySelector('#lb-sent').innerHTML = m.sent.length ? m.sent.map(row).join('') : '<p class="fineprint">No gifts sent yet.</p>';
  lb.querySelector('#lb-received').innerHTML = m.received.length ? m.received.map(row).join('') : '<p class="fineprint">No gifts received yet.</p>';
  lb.classList.remove('hidden');
}

/* ---- TikTok action rail: likes, gifts, share ---- */
let railLikes = 0;
function spawnHearts(n, big) {
  const layer = $('heart-layer');
  if (!layer) return;
  const emojis = big ? ['❤️', '💖', '💕'] : ['❤️'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'float-heart';
    s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    s.style.left = (55 + Math.random() * 35) + '%';
    s.style.animationDelay = (Math.random() * 0.4) + 's';
    if (big) s.style.fontSize = (1.6 + Math.random() * 1.6) + 'em';
    layer.appendChild(s);
    setTimeout(() => s.remove(), 2200);
  }
}
$('rail-like').onclick = (e) => {
  const btn = e.currentTarget;
  btn.classList.remove('liked'); void btn.offsetWidth; btn.classList.add('liked');
  railLikes++;
  $('rail-like-count').textContent = railLikes > 999 ? (railLikes / 1000).toFixed(1) + 'K' : railLikes;
  spawnHearts(3, false);
  wsSend({ type: 'like' });
};
$('rail-gift').onclick = () => openGiftShop(null);
$('rail-share').onclick = async () => {
  const url = location.origin + location.pathname;
  try { await navigator.clipboard.writeText(url); toast('🔗 Room link copied!'); }
  catch { toast('🔗 ' + url); }
};
// double-tap video grid = big like (TikTok-style)
let lastTap = 0;
$('video-grid').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastTap < 350) { spawnHearts(8, true); wsSend({ type: 'like' }); }
  lastTap = now;
});

/* ---- bottom nav ---- */
$('nav-home').onclick = () => {
  if (S.spectating) { wsSend({ type: 'spy-leave' }); stopSpectating(); }
  else if (S.room) { wsSend({ type: 'leave-room' }); leaveRoomUI(); }
  else { $('view-room').classList.add('hidden'); $('view-lobby').classList.remove('hidden'); }
  setNav('nav-home');
};
$('nav-create').onclick = () => {
  const name = prompt('Name your room:');
  if (name && name.trim().length >= 2) wsSend({ type: 'create-room', name: name.trim().slice(0, 40) });
  setNav('nav-home');
};
$('nav-profile').onclick = () => { $('contacts-drawer').classList.remove('hidden'); setNav('nav-profile'); };
function setNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === id));
}

/* ---- coin shop (real-money top-ups) ---- */
function openCoinShop() {
  $('coin-modal').classList.remove('hidden');
  const el = $('coin-packages');
  el.innerHTML = '<p class="fineprint">Loading…</p>';
  fetch('/api/coin-shop').then(r => r.json()).then(j => {
    el.innerHTML = '';
    if (!j.stripeReady) {
      el.innerHTML = '<p class="fineprint">💳 Card purchases coming soon — for now earn free coins: +🪙100 welcome, +🪙50 daily, +🪙10 per trivia win.</p>';
      return;
    }
    for (const p of j.packages) {
      const b = document.createElement('button');
      b.className = 'coin-pack';
      b.innerHTML = `<span class="cp-tag">${esc(p.tag)}</span><span class="cp-coins">🪙 ${p.coins.toLocaleString()}</span><span class="cp-price">$${p.usd}</span>`;
      b.onclick = async () => {
        b.disabled = true;
        try {
          const rr = await fetch('/api/create-checkout', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageId: p.id, user: S.myName }),
          });
          const jj = await rr.json();
          if (!rr.ok) throw new Error(jj.error || 'Checkout failed.');
          location.href = jj.url;
        } catch (e) { toast('⚠️ ' + e.message); b.disabled = false; }
      };
      el.appendChild(b);
    }
  }).catch(() => { el.innerHTML = '<p class="fineprint">Could not load coin shop.</p>'; });
}
$('buy-coins-btn').onclick = openCoinShop;
$('coin-balance').onclick = openCoinShop;
$('coin-close').onclick = () => $('coin-modal').classList.add('hidden');
// after Stripe checkout, show a full coin-purchase celebration
if (new URLSearchParams(location.search).get('coins') === 'success') {
  history.replaceState(null, '', location.pathname);
  setTimeout(() => coinPurchaseCelebration(), 1200);
}
function coinPurchaseCelebration() {
  const ov = document.createElement('div');
  ov.id = 'gift-overlay';
  ov.classList.add('legendary');
  ov.innerHTML = `<div class="legend-flash"></div>
    <div class="coin-burst">🪙</div>
    <div class="legend-caption">PAYMENT SUCCESSFUL!</div>
    <div class="gift-text">Your coins are on the way ✨</div>`;
  const bits = ['🪙', '💰', '✨', '🎉'];
  for (let i = 0; i < 30; i++) {
    const s = document.createElement('span');
    s.className = 'gift-fall';
    s.textContent = bits[Math.floor(Math.random() * bits.length)];
    s.style.left = (Math.random() * 100) + 'vw';
    s.style.animationDelay = (Math.random() * 1.6) + 's';
    s.style.fontSize = (1.2 + Math.random() * 2) + 'em';
    ov.appendChild(s);
  }
  document.body.appendChild(ov);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC(); if (ctx.resume) ctx.resume();
      const t = ctx.currentTime;
      [880, 1174.66, 1567.98].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.15 + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.15 + 0.6);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + i * 0.15); o.stop(t + i * 0.15 + 0.7);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 2500);
    }
  } catch {}
  const kill = () => { if (ov.parentNode) ov.remove(); };
  ov.onclick = kill;
  setTimeout(kill, 5000);
}

/* TikTok-style tiered gift animations:
   tier 1-2: compact combo banners · tier 3: full-screen banner · tier 4: legendary cinematic */
const giftCombos = new Map(); // senderId:giftId -> {count, el, timer}
function giftCelebration(evt) {
  const tier = (evt.gift && evt.gift.tier) || 1;
  if (tier <= 2) return giftBanner(evt, tier);
  if (tier === 3) return giftFullscreen(evt);
  return giftLegendary(evt);
}
function giftBanner(evt, tier) {
  const key = evt.from + ':' + evt.gift.id;
  const existing = giftCombos.get(key);
  if (existing) {
    existing.count++;
    const badge = existing.el.querySelector('.gcombo');
    if (badge) {
      badge.textContent = 'x' + existing.count;
      badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
    }
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => { existing.el.remove(); giftCombos.delete(key); }, 4000);
    return;
  }
  let stack = $('gift-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'gift-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'gift-banner tier' + tier;
  el.innerHTML = `<span class="gb-emoji">${evt.gift.emoji}</span>
    <span class="gb-text"><b>${esc(evt.fromName)}</b> sent <b>${esc(evt.toName)}</b> ${esc(evt.gift.name)}</span>
    <span class="gcombo">x1</span>`;
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstChild.remove();
  const rec = { count: 1, el, timer: setTimeout(() => { el.remove(); giftCombos.delete(key); }, 4000) };
  giftCombos.set(key, rec);
}
function giftFullscreen(evt) {
  const ov = document.createElement('div');
  ov.id = 'gift-overlay';
  ov.innerHTML = `<div class="gift-pop">${evt.gift.emoji}</div>
    <div class="gift-text">${esc(evt.fromName)} sent ${esc(evt.toName)}</div>
    <div class="gift-name">${evt.gift.emoji} ${esc(evt.gift.name)}!</div>`;
  const bits = [evt.gift.emoji, '✨', '🎉', '💖'];
  for (let i = 0; i < 22; i++) {
    const s = document.createElement('span');
    s.className = 'gift-fall';
    s.textContent = bits[Math.floor(Math.random() * bits.length)];
    s.style.left = (Math.random() * 100) + 'vw';
    s.style.animationDelay = (Math.random() * 1.4) + 's';
    s.style.fontSize = (1.2 + Math.random() * 1.8) + 'em';
    ov.appendChild(s);
  }
  document.body.appendChild(ov);
  const kill = () => { if (ov.parentNode) ov.remove(); };
  ov.onclick = kill;
  setTimeout(kill, 4200);
}
const LEGENDARY_SCENES = {
  lion:     { cls: 'scene-lion',     caption: 'ROAR! 🦁' },
  universe: { cls: 'scene-universe', caption: 'OUT OF THIS WORLD! 🌠' },
  yacht:    { cls: 'scene-yacht',    caption: 'SAILING IN STYLE! 🛥️' },
  sportscar:{ cls: 'scene-car',      caption: 'VROOM! 🏎️' },
  jet:      { cls: 'scene-jet',      caption: 'TAKING OFF! 🛩️' },
  ferris:   { cls: 'scene-ferris',   caption: 'ROUND AND ROUND! 🎡' },
};
function giftLegendary(evt) {
  const scene = LEGENDARY_SCENES[evt.gift.id] || { cls: 'scene-default', caption: 'LEGENDARY! ✨' };
  const ov = document.createElement('div');
  ov.id = 'gift-overlay';
  ov.classList.add('legendary');
  ov.innerHTML = `<div class="legend-flash"></div>
    <div class="legend-actor ${scene.cls}">${evt.gift.emoji}</div>
    <div class="legend-caption">${scene.caption}</div>
    <div class="gift-text">${esc(evt.fromName)} sent ${esc(evt.toName)}</div>
    <div class="gift-name">${evt.gift.emoji} ${esc(evt.gift.name)}!</div>`;
  document.body.appendChild(ov);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC(); if (ctx.resume) ctx.resume();
      const t = ctx.currentTime;
      // bass thump on slam
      const th = ctx.createOscillator(), tg = ctx.createGain();
      th.type = 'sine'; th.frequency.setValueAtTime(120, t);
      th.frequency.exponentialRampToValueAtTime(35, t + 0.25);
      tg.gain.setValueAtTime(0.5, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      th.connect(tg); tg.connect(ctx.destination);
      th.start(t); th.stop(t + 0.4);
      // bright fanfare
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + 0.1 + i * 0.1);
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.1 + i * 0.1 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1 + i * 0.1 + 0.4);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + 0.1 + i * 0.1); o.stop(t + 0.1 + i * 0.1 + 0.5);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 2500);
    }
  } catch {}
  const kill = () => { if (ov.parentNode) ov.remove(); };
  ov.onclick = kill;
  setTimeout(kill, 6000);
}
/* ---- private cam invites ---- */
let pendingInvite = null;
$('invite-accept').onclick = () => {
  if (pendingInvite) wsSend({ type: 'cam-invite-accept', roomId: pendingInvite.roomId });
  pendingInvite = null;
  $('invite-modal').classList.add('hidden');
};
$('invite-decline').onclick = () => {
  if (pendingInvite) wsSend({ type: 'cam-invite-decline', from: pendingInvite.from, roomId: pendingInvite.roomId });
  pendingInvite = null;
  $('invite-modal').classList.add('hidden');
};

/* ---- public moderation banner ---- */
let modBannerTimer = null;
function showModBanner(m) {
  const el = $('mod-banner');
  el.innerHTML = `<span>${esc(m.icon || '📢')}</span><b>${esc(m.text || '')}</b><button id="mod-banner-x" title="Dismiss">✕</button>`;
  el.classList.remove('hidden');
  $('mod-banner-x').onclick = () => el.classList.add('hidden');
  clearTimeout(modBannerTimer);
  modBannerTimer = setTimeout(() => el.classList.add('hidden'), 9000);
}

/* ============================== letterhead + warnings ============================== */
function showLetterhead(b) {
  $('lh-title').textContent = b.title || '👑 Welcome to CamWave';
  $('lh-body').textContent = b.body || '';
  $('lh-contact').textContent = b.contact || '';
  $('letterhead-modal').classList.remove('hidden');
}
$('lh-enter').onclick = () => $('letterhead-modal').classList.add('hidden');

function showWarned(m) {
  const reason = m.reason ? `\nReason: ${m.reason}` : '';
  $('warned-text').textContent = `${m.by} has given you an official warning (strike ${m.count}).${reason}\n\nKeep breaking the rules and you'll be muted, kicked, or banned.`;
  $('warned-modal').classList.remove('hidden');
}
$('warned-ok').onclick = () => $('warned-modal').classList.add('hidden');

/* site banner editor (site owner only) */
$('siteowner-btn').onclick = () => {
  const b = S.siteBanner || {};
  $('sb-title').value = b.title || '';
  $('sb-body').value = b.body || '';
  $('sb-contact').value = b.contact || '';
  $('sitebanner-modal').classList.remove('hidden');
};
$('sb-close').onclick = () => $('sitebanner-modal').classList.add('hidden');
$('sb-save').onclick = () => {
  wsSend({ type: 'site-banner', action: 'set',
    title: $('sb-title').value, body: $('sb-body').value, contact: $('sb-contact').value });
  $('sitebanner-modal').classList.add('hidden');
  toast('📋 Welcome letterhead updated.');
};

/* ============================== media ============================== */
async function setupLocalMedia() {
  if (S.localStream) return;
  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    S.camOn = true; S.micOn = false;
    // mic starts OFF in PTT rooms (hold to talk); never touch S.selfMuted here —
    // that's the server's mute flag, and setting it locally deadlocks the mic button.
    S.localStream.getAudioTracks().forEach(t => t.enabled = false);
    wsSend({ type: 'media-state', videoOn: true });
  } catch (e) {
    console.warn('No local media (watch-only mode):', e.message);
    S.localStream = null; S.camOn = false; S.micOn = false;
  }
  renderSelfTile(); updateMediaButtons();
}

$('cam-toggle').onclick = async () => {
  await setupLocalMedia();
  if (!S.localStream) return toast('📷 No camera available — watch-only mode.');
  S.camOn = !S.camOn;
  S.localStream.getVideoTracks().forEach(t => t.enabled = S.camOn);
  wsSend({ type: 'media-state', videoOn: S.camOn });
  renderSelfTile(); updateMediaButtons();
};

$('mic-toggle').onclick = () => {
  const staff = S.siteOwner || (S.room && (S.room.myRole === 'owner' || S.room.myRole === 'admin' || S.room.myRole === 'moderator'));
  if ((S.room && S.room.settings.openMic) || staff) {
    // open-mic rooms: toggle for everyone; PTT rooms: toggle for staff
    setMicEnabled(!S.micOn);
  } else {
    toast('🔊 Push-to-talk mode: hold the TALK button (or Space) to speak.');
  }
};

/* ============================== screen sharing ============================== */
$('screen-btn').onclick = () => { S.sharingScreen ? stopScreenShare() : startScreenShare(); };
function updateScreenBtn() {
  $('screen-btn').classList.toggle('active', !!S.sharingScreen);
  $('screen-btn').title = S.sharingScreen ? 'Stop sharing' : 'Share screen';
}
async function startScreenShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia)
    return toast('Screen sharing is not supported in this browser.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch { return; } // user cancelled
  const vTrack = stream.getVideoTracks()[0];
  if (!vTrack) { stream.getTracks().forEach(t => { try { t.stop(); } catch {} }); return toast('No video in that share.'); }
  S.sharingScreen = true;
  S.screenStream = stream;
  const aTrack = stream.getAudioTracks()[0];
  for (const [, p] of S.peers) {
    try {
      const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(vTrack);
      if (aTrack && !p.screenAudioSender) p.screenAudioSender = p.pc.addTrack(aTrack, stream);
    } catch (e) { console.warn(e); }
  }
  vTrack.onended = stopScreenShare; // browser's own "Stop sharing" button
  wsSend({ type: 'screen-share', sharing: true });
  renderSelfTile(); updateScreenBtn();
  toast('🖥️ You are sharing your screen with the room.');
}
function stopScreenShare() {
  if (!S.sharingScreen) return;
  S.sharingScreen = false;
  const camTrack = (S.localStream && S.camOn) ? S.localStream.getVideoTracks()[0] : null;
  for (const [, p] of S.peers) {
    (async () => {
      try {
        const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(camTrack);
        if (p.screenAudioSender) { p.pc.removeTrack(p.screenAudioSender); p.screenAudioSender = null; }
      } catch (e) { console.warn(e); }
    })();
  }
  if (S.screenStream) { S.screenStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); S.screenStream = null; }
  wsSend({ type: 'screen-share', sharing: false });
  renderSelfTile(); updateScreenBtn();
}
$('sound-toggle').onclick = () => {
  S.soundOn = !S.soundOn;
  $('sound-toggle').textContent = S.soundOn ? '🔔' : '🔕';
  $('sound-toggle').classList.toggle('off', !S.soundOn);
};

/* mic level meter */
let micAnalyser = null, micAudioCtx = null, micMeterRAF = null;
function startMicMeter() {
  stopMicMeter();
  try {
    const track = S.localStream && S.localStream.getAudioTracks()[0];
    if (!track) return;
    micAudioCtx = micAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (micAudioCtx.state === 'suspended') micAudioCtx.resume();
    const src = micAudioCtx.createMediaStreamSource(new MediaStream([track]));
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    src.connect(micAnalyser);
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    const meter = document.getElementById('mic-meter-fill');
    const wrap = document.getElementById('mic-meter');
    if (wrap) wrap.style.display = 'block';
    const loop = () => {
      micAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const lvl = Math.min(100, (sum / data.length) * 1.2);
      if (meter) {
        meter.style.width = lvl + '%';
        meter.style.background = lvl > 70 ? 'var(--bad)' : lvl > 30 ? 'var(--warn)' : 'var(--good)';
      }
      micMeterRAF = requestAnimationFrame(loop);
    };
    loop();
  } catch {}
}
function stopMicMeter() {
  if (micMeterRAF) cancelAnimationFrame(micMeterRAF);
  micMeterRAF = null; micAnalyser = null;
  const wrap = document.getElementById('mic-meter');
  if (wrap) wrap.style.display = 'none';
}
function setMicEnabled(on, forced) {
  if (on && S.selfMuted && !forced) { toast('🔇 You are muted.'); return; }
  S.micOn = on;
  if (S.localStream) S.localStream.getAudioTracks().forEach(t => t.enabled = on);
  wsSend({ type: on ? 'mic-on' : 'mic-off' });
  if (on) startMicMeter(); else stopMicMeter();
  updateMediaButtons(); renderUserList();
}

function updateMediaButtons() {
  $('cam-toggle').classList.toggle('off', !S.camOn);
  $('cam-toggle').textContent = S.camOn ? '🎥' : '🚫🎥';
  $('mic-toggle').classList.toggle('off', !S.micOn);
  $('mic-toggle').textContent = S.micOn ? '🎙️' : '🔇';
  const pttMode = !S.room || !S.room.settings.openMic;
  const staff = S.siteOwner || (S.room && (S.room.myRole === 'owner' || S.room.myRole === 'admin' || S.room.myRole === 'moderator'));
  $('ptt-btn').style.display = pttMode ? '' : 'none';
  $('mic-toggle').style.display = (pttMode && !staff) ? 'none' : '';
}

/* push-to-talk: hold button or hold Space */
const pttBtn = $('ptt-btn');
function pttDown(e) { if (e) e.preventDefault(); if (S.pttHeld) return; S.pttHeld = true;
  pttBtn.classList.add('active'); setMicEnabled(true); }
function pttUp() { if (!S.pttHeld) return; S.pttHeld = false;
  pttBtn.classList.remove('active'); setMicEnabled(false); }
pttBtn.addEventListener('mousedown', pttDown);
addEventListener('mouseup', pttUp);
pttBtn.addEventListener('touchstart', pttDown, {passive:false});
pttBtn.addEventListener('touchend', pttUp);
addEventListener('keydown', e => {
  const ae = document.activeElement, tag = ae ? ae.tagName : '';
  if (e.code === 'Space' && S.room && !$('view-room').classList.contains('hidden') &&
      tag !== 'INPUT' && tag !== 'TEXTAREA' && !ae.isContentEditable) { e.preventDefault(); pttDown(); }
});
addEventListener('keyup', e => { if (e.code === 'Space') pttUp(); });

/* ---- camera brightness sampling for verification ---- */
function sampleCamBrightness() {
  try {
    const v = document.querySelector('#tile-self video');
    if (!v || !S.camOn || v.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4) / 255;
  } catch { return null; }
}
setInterval(() => {
  if (!S.room || S.spectating || !S.camOn || !S.localStream) return;
  const b = sampleCamBrightness();
  wsSend({ type: 'media-state', videoOn: true, brightness: b == null ? 1 : b });
}, 5000);

/* ---- camera verification banners ---- */
function showCamCheckBanner(warn) {
  let b = $('cam-check-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'cam-check-banner';
    document.querySelector('#view-room').prepend(b);
  }
  b.innerHTML = warn
    ? '⚠️ <b>15 SECONDS</b> — turn on your camera with the lights on or you\'ll be removed!'
    : '📹 <b>Camera check:</b> turn on your camera (face visible, lights on) to verify. 45 seconds.';
  b.className = warn ? 'warn' : '';
  b.classList.remove('hidden');
  clearTimeout(b._t);
  if (!warn) b._t = setTimeout(() => b.classList.add('hidden'), 45000);
}

/* ============================== WebRTC mesh ============================== */
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeer(peerId, offerer, recvOnly) {
  if (S.peers.has(peerId)) return S.peers.get(peerId);
  const pc = new RTCPeerConnection(RTC_CFG);
  const peer = { pc, stream: new MediaStream() };
  S.peers.set(peerId, peer);

  if (!recvOnly && S.sharingScreen && S.screenStream) {
    for (const t of S.screenStream.getTracks()) pc.addTrack(t, S.screenStream);
  } else if (!recvOnly && S.localStream) {
    for (const t of S.localStream.getTracks()) pc.addTrack(t, S.localStream);
  } else {
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch {}
  }
  // DJ file/tab track, if currently DJing
  if (S.dj.active && (S.dj.mode === 'file' || S.dj.mode === 'tab') && S.dj.track) {
    try { peer.djSender = pc.addTrack(S.dj.track, S.dj.stream); } catch {}
  }

  pc.ontrack = (e) => {
    for (const t of e.streams[0].getTracks()) {
      if (!peer.stream.getTrackById(t.id)) {
        peer.stream.addTrack(t);
        t.onmute = () => renderVideoGrid();
        t.onunmute = () => renderVideoGrid();
        t.onended = () => renderVideoGrid();
      }
    }
    renderVideoGrid();
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'signal', to: peerId, data: { ice: e.candidate } });
  };
  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
    } catch (e) { console.warn('renegotiate failed', e); }
  };
  if (offerer) {
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() =>
      wsSend({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } })
    ).catch(e => console.warn('offer failed', e));
  }
  return peer;
}

async function onSignal(from, data) {
  const peer = createPeer(from, false);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        wsSend({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      await pc.addIceCandidate(new RTCIceCandidate(data.ice));
    }
  } catch (e) { console.warn('signal error', e); }
}

function renderSelfTile() {
  let tile = $('tile-self');
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile'; tile.id = 'tile-self';
    $('video-grid').prepend(tile);
  }
  tile.innerHTML = `<div class="video-label">${S.sharingScreen ? '🖥️ You are sharing' : `📹 You ${S.camOn ? '' : '(cam off)'}`}</div>`;
  if (S.sharingScreen && S.screenStream) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsinline = true; v.muted = true;
    v.srcObject = S.screenStream;
    tile.prepend(v);
  } else if (S.localStream && S.camOn) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsinline = true; v.muted = true;
    v.srcObject = S.localStream;
    tile.prepend(v);
  } else if (S.myPhoto) {
    const img = document.createElement('img');
    img.src = S.myPhoto; img.alt = 'your photo'; img.className = 'tile-photo';
    tile.prepend(img);
  }
}

function renderVideoGrid() {
  renderSelfTile();
  // remove tiles for departed peers
  for (const el of [...document.querySelectorAll('.video-tile[data-peer]')]) {
    if (!S.peers.has(el.dataset.peer) || S.hiddenPeers.has(el.dataset.peer)) el.remove();
  }
  for (const [id, peer] of S.peers) {
    if (S.hiddenPeers.has(id)) continue; // invisible spectator: connected but no tile
    const u = S.roomUsers.get(id);
    let tile = document.querySelector(`.video-tile[data-peer="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile'; tile.dataset.peer = id;
      tile.onclick = () => spotlight(id);
      $('video-grid').appendChild(tile);
    }
    const vTracks = peer.stream.getVideoTracks();
    const liveTrack = vTracks.find(t => t.readyState === 'live' && !t.muted);
    const hasVideo = !!liveTrack;
    tile.classList.toggle('speaking', !!(u && u.talking));
    tile.classList.toggle('role-owner', !!(u && u.role === 'owner'));
    tile.classList.toggle('role-admin', !!(u && u.role === 'admin'));
    tile.classList.toggle('role-moderator', !!(u && u.role === 'moderator'));
    // top-spender medal frame + corner badge
    const sr = medalRank(u && u.medal);
    tile.classList.toggle('spender-1', sr === 1);
    tile.classList.toggle('spender-2', sr === 2);
    tile.classList.toggle('spender-3', sr === 3);
    let tb = tile.querySelector('.tile-badge');
    if (sr && !tb) { tb = document.createElement('div'); tb.className = 'tile-badge'; tile.appendChild(tb); }
    if (tb) { if (sr) tb.innerHTML = spenderBadge(u.medal, u.photo, true); else tb.remove(); }
    if (!tile.querySelector('video') && hasVideo) {
      const v = document.createElement('video');
      v.autoplay = true; v.playsinline = true;
      v.srcObject = peer.stream;
      tile.prepend(v);
    }
    // photo fallback when their camera is off
    const existingPhoto = tile.querySelector('.tile-photo');
    if (!hasVideo && u && u.photo) {
      if (!existingPhoto) {
        const img = document.createElement('img');
        img.className = 'tile-photo'; img.alt = '';
        tile.prepend(img);
      }
      tile.querySelector('.tile-photo').src = u.photo;
    } else if (existingPhoto) {
      existingPhoto.remove();
    }
    let label = tile.querySelector('.video-label');
    if (!label) { label = document.createElement('div'); label.className = 'video-label'; tile.appendChild(label); }
    label.innerHTML = `${u && u.sharingScreen ? '🖥️ ' : ''}${spenderNameBadge(u && u.medal)}${vipBadge(u && u.vip)}<b ${vipNameStyle(u && u.vip)}>${esc(u ? u.name : id)}</b> ${u && u.muted ? '🔇' : ''} ${u && ROLE_LABEL[u.role] ? `<span class="role role-${u.role}">${ROLE_LABEL[u.role]}</span>` : ''}`;
    let mic = tile.querySelector('.mic-off-icon');
    if (u && u.muted && !mic) { mic = document.createElement('div'); mic.className = 'mic-off-icon'; mic.textContent = '🔇'; tile.appendChild(mic); }
    if (u && !u.muted && mic) mic.remove();
  }
}

function updateTileStates() { renderVideoGrid(); }

function spotlight(peerId) {
  S.spotlightId = peerId;
  const sp = $('spotlight');
  sp.classList.remove('hidden');
  const v = $('spotlight-video');
  const u = S.roomUsers.get(peerId);
  $('spotlight-label').textContent = '🔍 ' + (u ? u.name : peerId);
  if (peerId === 'self' || !peerId) {
    v.srcObject = S.localStream;
  } else {
    const p = S.peers.get(peerId);
    v.srcObject = p ? p.stream : null;
  }
  v.play().catch(()=>{});
  sp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('spotlight-close').onclick = () => { $('spotlight').classList.add('hidden'); S.spotlightId = null; };

/* ============================== text chat ============================== */
const EMOJIS = ['😀','😂','😍','🔥','👍','👎','🎉','😎','🤔','😢','👏','🙏','💯','🎧','🎥'];
(function emojiBar(){
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.textContent = e; b.className = 'btn-ghost'; b.style.padding = '4px 8px';
    b.onclick = () => { $('chat-input').value += e; $('chat-input').focus(); };
    bar.appendChild(b);
  }
  $('chat-log').before(bar);
})();

$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const t = $('chat-input').value.trim();
  if (!t) return;
  wsSend({ type: 'chat', text: t });
  $('chat-input').value = '';
}
function addChatMsg(m) {
  const el = document.createElement('div');
  el.className = 'chat-msg' + (m.bot ? ' bot' : '') + (m.greeting ? ' greeting' : '');
  el.innerHTML = `<span class="who ${m.role==='owner'?'owner':''}">${spenderNameBadge(m.medal)}${vipBadge(m.vip)}<b ${vipNameStyle(m.vip)}>${esc(m.name)}</b></span><span class="ts">${tsFmt(m.ts)}</span><div>${esc(m.text)}</div>`;
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = 1e6;
}
function addMediaMsg(m) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const head = document.createElement('div');
  head.innerHTML = `<span class="who ${m.role==='owner'?'owner':''}">${esc(m.name)}</span><span class="ts">${tsFmt(m.ts)}</span>`;
  el.appendChild(head);
  const wrap = document.createElement('div');
  wrap.className = 'chat-media';
  if (m.kind === 'video') {
    const v = document.createElement('video');
    v.src = m.dataUrl; v.controls = true; v.preload = 'metadata'; v.playsInline = true;
    wrap.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = m.dataUrl; img.alt = 'shared photo'; img.loading = 'lazy';
    img.onclick = () => openLightbox(m.dataUrl);
    wrap.appendChild(img);
  }
  el.appendChild(wrap);
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = 1e6;
}
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox-modal').classList.remove('hidden');
}
$('lightbox-close').onclick = () => { $('lightbox-modal').classList.add('hidden'); $('lightbox-img').src = ''; };
$('lightbox-modal').onclick = (e) => { if (e.target.id === 'lightbox-modal') $('lightbox-close').onclick(); };

/* ---- photo / video sharing ---- */
function blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}
function compressImage(file, maxDim = 1280, quality = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.width, h = img.height;
        if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(img.src);
        c.toBlob(b => b ? res(b) : rej(new Error('compress failed')), 'image/jpeg', quality);
      } catch (e) { rej(e); }
    };
    img.onerror = () => rej(new Error('bad image'));
    img.src = URL.createObjectURL(file);
  });
}

/* ---- profile photo (shown instead of camera) ---- */
let pendingPhoto = null; // chosen at login, sent after welcome
async function pickPhoto(file, previewEl) {
  if (!file || !file.type.startsWith('image/')) return null;
  try {
    const blob = await compressImage(file, 512, 0.8);
    const du = await blobToDataURL(blob);
    if (previewEl) { previewEl.src = du; previewEl.classList.remove('hidden'); }
    return du;
  } catch { toast('Could not use that photo.'); return null; }
}
$('login-photo-btn').onclick = () => $('login-photo-input').click();
$('login-photo-input').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  pendingPhoto = await pickPhoto(f, $('login-photo-preview'));
};
$('photo-btn').onclick = () => $('photo-input').click();
$('photo-input').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  const du = await pickPhoto(f, null);
  if (du) { S.myPhoto = du; wsSend({ type: 'set-photo', dataUrl: du }); renderSelfTile(); toast('📷 Profile photo updated.'); }
};
$('chat-photo-btn').onclick = () => $('chat-photo-input').click();
$('chat-video-btn').onclick = () => $('chat-video-input').click();
$('chat-photo-input').onchange = async (e) => {
  const files = [...e.target.files].filter(f => f.type.startsWith('image/')).slice(0, 6);
  e.target.value = '';
  if (!files.length) return;
  toast(`📷 Sharing ${files.length} photo${files.length > 1 ? 's' : ''}…`);
  for (const f of files) {
    try {
      const blob = await compressImage(f);
      wsSend({ type: 'chat-media', kind: 'image', dataUrl: await blobToDataURL(blob) });
    } catch { toast('Could not share a photo.'); }
  }
};
$('chat-video-input').onchange = async (e) => {
  const f = [...e.target.files].find(f => f.type.startsWith('video/'));
  e.target.value = '';
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) return toast('Video too big — max ~15MB.');
  toast('🎬 Sharing video…');
  try { wsSend({ type: 'chat-media', kind: 'video', dataUrl: await blobToDataURL(f) }); }
  catch { toast('Could not share that video.'); }
};

/* ---- record a video clip from camera ---- */
let mediaRecorder = null, recordChunks = [], recordTimer = null, recordTick = null, recordSecs = 0;
$('chat-record-btn').onclick = () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') { stopRecording(); return; }
  startRecording();
};
async function startRecording() {
  let stream = S.localStream;
  if (!stream || !stream.getVideoTracks().length) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
    catch { return toast('Camera needed to record a clip.'); }
  }
  try {
    const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    recordChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1500000 });
  } catch { return toast('Recording not supported here.'); }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
  mediaRecorder.onstop = shareRecording;
  mediaRecorder.start();
  recordSecs = 0;
  $('rec-time').textContent = '0:00';
  $('rec-indicator').classList.remove('hidden');
  recordTick = setInterval(() => { recordSecs++; $('rec-time').textContent = `${Math.floor(recordSecs/60)}:${String(recordSecs%60).padStart(2,'0')}`; }, 1000);
  recordTimer = setTimeout(stopRecording, 30000);
  toast('🔴 Recording — tap ⏺️ again or Stop to share (max 30s).');
}
function stopRecording() {
  clearTimeout(recordTimer); clearInterval(recordTick);
  $('rec-indicator').classList.add('hidden');
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  else { mediaRecorder = null; }
}
$('rec-stop').onclick = stopRecording;
function shareRecording() {
  mediaRecorder = null;
  const blob = new Blob(recordChunks, { type: 'video/webm' });
  recordChunks = [];
  if (!blob.size) return;
  if (blob.size > 20 * 1024 * 1024) return toast('Clip too big to share.');
  toast('🎬 Sharing your clip…');
  blobToDataURL(blob).then(du => wsSend({ type: 'chat-media', kind: 'video', dataUrl: du }))
    .catch(() => toast('Could not share the clip.'));
}
function addSysMsg(text) {
  if ($('view-room').classList.contains('hidden')) return;
  const el = document.createElement('div');
  el.className = 'chat-msg sys'; el.textContent = text;
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = 1e6;
}
function addActivity(icon, name, action) {
  if ($('view-room').classList.contains('hidden')) return;
  const log = $('activity-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'activity-row';
  el.innerHTML = `${icon} <b>${esc(name)}</b> ${esc(action)} <span class="ts">${tsFmt(Date.now())}</span>`;
  log.appendChild(el);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = 1e6;
}

/* ============================== contacts & DMs ============================== */
$('contacts-btn').onclick = () => { $('contacts-drawer').classList.remove('hidden'); wsSend({type:'get-contacts'}); };
$('contacts-close').onclick = () => $('contacts-drawer').classList.add('hidden');
$('add-contact-btn').onclick = () => {
  const n = $('add-contact-input').value.trim();
  if (n) { wsSend({ type: 'add-contact', name: n }); $('add-contact-input').value = ''; }
};

function renderContacts() {
  const el = $('contact-list'); el.innerHTML = '';
  if (!S.contacts.length) { el.innerHTML = '<p style="color:var(--muted)">No contacts yet — add people by nickname.</p>'; return; }
  for (const c of [...S.contacts].sort((a,b) => (b.online - a.online) || a.name.localeCompare(b.name))) {
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `<span class="dot ${c.online ? c.status : 'offline'}" style="${c.online?'':'background:#555'}"></span>
      <span class="nm">${esc(c.name)}</span>
      ${S.dmUnread.has(c.id) ? '<span class="badge" style="position:static">●</span>' : ''}
      ${c.online ? '<button class="btn-ghost" data-x="cam" title="Invite to private video chat">📹</button>' : ''}
      <button class="btn-ghost" data-x="rm" title="Remove">✕</button>`;
    row.onclick = (e) => {
      if (e.target.dataset.x === 'rm') { wsSend({ type: 'remove-contact', id: c.id }); return; }
      if (e.target.dataset.x === 'cam') {
        wsSend({ type: 'cam-invite', to: c.id });
        toast(`📹 Invited ${c.name} to a private video chat…`);
        return;
      }
      openDm(c.id, c.name);
    };
    el.appendChild(row);
  }
  updateDmBadge();
}

function openDm(id, name) {
  S.dmWith = id; S.dmUnread.delete(id);
  $('dm-thread').classList.remove('hidden');
  $('contacts-drawer').classList.remove('hidden');
  $('dm-title').textContent = '💬 ' + name;
  $('dm-log').innerHTML = '';
  wsSend({ type: 'dm-history', with: id });
  updateDmBadge(); renderContacts();
}
$('dm-close').onclick = () => { $('dm-thread').classList.add('hidden'); S.dmWith = null; };
$('dm-send').onclick = sendDm;
$('dm-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendDm(); });
function sendDm() {
  const t = $('dm-input').value.trim();
  if (!t || !S.dmWith) return;
  wsSend({ type: 'dm', to: S.dmWith, text: t });
  $('dm-input').value = '';
}
function addDmMsg(m) {
  const mine = m.from === S.myId;
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="who">${esc(mine ? 'You' : m.fromName)}</span><span class="ts">${tsFmt(m.ts)}</span><div>${esc(m.text)}</div>`;
  $('dm-log').appendChild(el);
  $('dm-log').scrollTop = 1e6;
}
function onDmMsg(m) {
  if (m.from === S.dmWith) { addDmMsg(m); }
  else { S.dmUnread.add(m.from); }
  updateDmBadge(); renderContacts();
  banner('💬 New private message');
}
function onDmSent(m) { if (m.to === S.dmWith) addDmMsg(m); }
function updateDmBadge() {
  const b = $('dm-badge');
  b.classList.toggle('hidden', S.dmUnread.size === 0);
  b.textContent = S.dmUnread.size;
}

/* ============================== room settings & bans ============================== */
$('room-settings-btn').onclick = () => {
  if (!S.room) return;
  $('set-openmic').checked = S.room.settings.openMic;
  $('set-miclock').checked = !!S.room.settings.micLocked;
  $('set-talklimit').value = S.room.settings.talkLimitSec || 0;
  $('settings-modal').classList.remove('hidden');
  wsSend({ type: 'get-ban-list' });
};
$('settings-cancel').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-save').onclick = () => {
  wsSend({ type: 'room-settings', roomId: S.room.id,
    openMic: $('set-openmic').checked,
    micLocked: $('set-miclock').checked,
    talkLimitSec: parseInt($('set-talklimit').value || '0', 10) });
  $('settings-modal').classList.add('hidden');
};
function renderBanList(bans) {
  const el = $('ban-list'); el.innerHTML = '';
  if (!bans.length) { el.innerHTML = '<p style="color:var(--muted)">Nobody banned. 🎉</p>'; return; }
  for (const b of bans) {
    const row = document.createElement('div');
    row.className = 'ban-row';
    row.innerHTML = `<span class="nm">${esc(b.name)} <small style="color:var(--muted)">${esc(b.ip)} · by ${esc(b.by)}</small></span>`;
    const ub = document.createElement('button');
    ub.className = 'btn-ghost'; ub.textContent = 'Unban';
    ub.onclick = () => wsSend({ type: 'mod-action', action: 'unban', targetId: b.id, roomId: S.room.id });
    row.appendChild(ub);
    el.appendChild(row);
  }
}

/* ============================== DJ mode ============================== */
$('dj-btn').onclick = () => $('dj-modal').classList.remove('hidden');
$('dj-close').onclick = () => $('dj-modal').classList.add('hidden');

function onDjMsg(m) {
  if (m.action === 'you-are-dj') return; // we already started locally
  if (m.action === 'start-url') {
    startDjUrl(m.url, m.by);
    addSysMsg(`🎧 ${m.by} started DJing a stream.`);
  } else if (m.action === 'start-file') {
    addSysMsg(`🎧 ${m.by} is DJing an audio file.`);
    S.dj.active = true; S.dj.mode = 'file-remote'; S.dj.by = m.by;
    toast('🎧 ' + m.by + ' is DJing — listen for their audio track.');
  } else if (m.action === 'start-tab') {
    addSysMsg(`🎧 ${m.by} is DJing their tab audio (e.g. Spotify).`);
    S.dj.active = true; S.dj.mode = 'tab-remote'; S.dj.by = m.by;
    toast('🎧 ' + m.by + ' is DJing — listen for their audio track.');
  } else if (m.action === 'start-spotify') {
    startDjSpotify(m.spotifyType, m.spotifyId, m.by);
    addSysMsg(`🎧 ${m.by} started DJing Spotify — tap play on the card to tune in.`);
  } else if (m.action === 'start-youtube') {
    startDjYoutube(m.youtubeId, m.by);
    addSysMsg(`🎧 ${m.by} started DJing YouTube — tap play on the card to tune in.`);
  } else if (m.action === 'stop') {
    stopDjLocal();
    addSysMsg('🎧 DJ stopped.');
  } else if (m.action === 'volume') {
    if (S.dj.audio) S.dj.audio.volume = m.volume;
    if (S.dj.mode === 'youtube' && ytPlayer && ytPlayer.setVolume) {
      try { ytPlayer.setVolume(Math.round(m.volume * 100)); } catch {}
    }
  }
  renderRoomHeader();
}

async function djPlayFile() {
  const f = $('dj-file').files[0];
  if (!f) return toast('Pick an audio file first.');
  stopDjLocal();
  const audio = new Audio(URL.createObjectURL(f));
  audio.volume = ($('dj-volume').value | 0) / 100;
  await audio.play().catch(() => toast('Could not play that file.'));
  let stream = null, track = null;
  try {
    stream = audio.captureStream ? audio.captureStream() : audio.mozCaptureStream();
    track = stream.getAudioTracks()[0];
  } catch (e) { return toast('This browser cannot share audio from a file.'); }
  S.dj = { active: true, mode: 'file', audio, url: null, track, stream, by: S.myName };
  // add track to all current peer connections (renegotiation follows automatically)
  for (const [, p] of S.peers) {
    try { p.djSender = p.pc.addTrack(track, stream); } catch (e) { console.warn(e); }
  }
  wsSend({ type: 'dj', action: 'start-file' });
  $('dj-modal').classList.add('hidden');
  toast('🎧 You are now DJing for the room!');
}
function startDjUrl(url, by) {
  stopDjLocal();
  const audio = new Audio(url);
  audio.volume = ($('dj-volume').value | 0) / 100;
  audio.play().catch(() => toast('Could not play that stream URL.'));
  S.dj = { active: true, mode: 'url', audio, url, track: null, stream: null, by };
}
/* ---- Spotify DJ: owner picks the music, everyone tunes in ----
   Spotify is DRM-locked so true broadcast is impossible; instead each
   phone plays the track through Spotify's own embed, started together
   by the owner's pick. The owner is the only one who can change it. */
function parseSpotifyLink(input) {
  const s = String(input || '').trim();
  let m = s.match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]{22})$/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})(?:[\/?#]|$)/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}
function startDjSpotify(spotifyType, spotifyId, by) {
  if (!spotifyType || !/^[A-Za-z0-9]{22}$/.test(spotifyId || '')) return;
  stopDjLocal();
  const wrap = $('spotify-dj-embed');
  wrap.innerHTML = '';
  const fr = document.createElement('iframe');
  fr.src = `https://open.spotify.com/embed/${spotifyType}/${spotifyId}?utm_source=generator&theme=0`;
  fr.width = '100%';
  fr.height = (spotifyType === 'track' || spotifyType === 'episode') ? '152' : '252';
  fr.frameBorder = '0';
  fr.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  fr.loading = 'lazy';
  fr.style.borderRadius = '12px';
  wrap.appendChild(fr);
  $('spotify-dj-by').textContent = by || 'Someone';
  $('spotify-dj-card').classList.remove('hidden');
  S.dj = { active: true, mode: 'spotify', audio: null, url: null, track: null, stream: null,
           spotifyType, spotifyId, by };
  toast('🎧 Tap play on the Spotify card to tune in.');
}
function hideSpotifyCard() {
  const card = $('spotify-dj-card');
  if (card) { card.classList.add('hidden'); const w = $('spotify-dj-embed'); if (w) w.innerHTML = ''; }
}
/* ---- YouTube DJ: owner picks the video, everyone tunes in ----
   Uses YouTube's IFrame Player API so the owner changing videos keeps
   playing on listeners' phones without another tap (first play needs
   one tap due to browser autoplay rules). */
let ytPlayer = null;
function parseYoutubeLink(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s; // bare video ID
  const m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?[^#]*v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i);
  return m ? m[1] : null;
}
function ensureYtApi(cb) {
  if (window.YT && YT.Player) { cb(); return; }
  if (!ensureYtApi.loading) {
    ensureYtApi.loading = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const first = document.getElementsByTagName('script')[0];
    first.parentNode.insertBefore(tag, first);
  }
  const iv = setInterval(() => {
    if (window.YT && YT.Player) { clearInterval(iv); cb(); }
  }, 300);
  setTimeout(() => clearInterval(iv), 10000);
}
function startDjYoutube(youtubeId, by) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || '')) return;
  stopDjLocal();
  $('youtube-dj-by').textContent = by || 'Someone';
  $('youtube-dj-card').classList.remove('hidden');
  S.dj = { active: true, mode: 'youtube', audio: null, url: null, track: null, stream: null,
           youtubeId, by };
  ensureYtApi(() => {
    if (!S.dj.active || S.dj.mode !== 'youtube') return; // stopped while the API loaded
    try {
      if (!ytPlayer) {
        ytPlayer = new YT.Player('youtube-dj-embed', {
          width: '100%', height: '230', videoId: youtubeId,
          playerVars: { rel: 0, autoplay: 1, origin: window.location.origin },
        });
      } else {
        ytPlayer.loadVideoById(youtubeId);
      }
    } catch (e) { /* player will show when ready */ }
  });
  toast('🎧 Tap play on the YouTube card to tune in.');
}
function hideYoutubeCard() {
  const card = $('youtube-dj-card');
  if (card) card.classList.add('hidden');
  try { if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); } catch {}
}
async function djPlayTab() {
  // Share another browser tab's audio (Spotify web player, YouTube, …) with the room.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia)
    return toast('Tab audio share is not supported in this browser.');
  stopDjLocal();
  let disp;
  try {
    disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; /* user cancelled the picker */ }
  const srcTracks = disp.getAudioTracks();
  if (!srcTracks.length) {
    disp.getTracks().forEach(t => { try { t.stop(); } catch {} });
    return toast('No audio in that share — pick the music tab and tick "Share tab audio".');
  }
  // Route through a gain node so the DJ volume slider works.
  let stream = disp, track = srcTracks[0], gainNode = null, audioCtx = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(disp);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = ($('dj-volume').value | 0) / 100;
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(gainNode); gainNode.connect(dest);
    stream = dest.stream;
    track = stream.getAudioTracks()[0];
    disp.getVideoTracks().forEach(t => { try { t.stop(); } catch {} });
  } catch (e) { /* fall back to the raw captured track */ }
  const endDj = () => { stopDjLocal(); wsSend({ type: 'dj', action: 'stop' }); };
  track.onended = endDj;
  srcTracks.forEach(t => { if (t !== track) t.onended = endDj; });
  S.dj = { active: true, mode: 'tab', audio: null, url: null, track, stream, by: S.myName,
           gainNode, audioCtx, dispStream: disp };
  for (const [, p] of S.peers) {
    try { p.djSender = p.pc.addTrack(track, stream); } catch (e) { console.warn(e); }
  }
  wsSend({ type: 'dj', action: 'start-tab' });
  $('dj-modal').classList.add('hidden');
  toast('🎧 You are now DJing your tab audio for the room!');
}
function stopDjLocal() {
  hideSpotifyCard();
  hideYoutubeCard();
  if (S.dj.audio) { try { S.dj.audio.pause(); } catch {} }
  if (S.dj.track) {
    for (const [, p] of S.peers) {
      try { if (p.djSender) { p.pc.removeTrack(p.djSender); p.djSender = null; } } catch {}
    }
  }
  if (S.dj.dispStream) { try { S.dj.dispStream.getTracks().forEach(t => t.stop()); } catch {} }
  if (S.dj.audioCtx) { try { S.dj.audioCtx.close(); } catch {} }
  S.dj = { active: false, mode: null, audio: null, url: null, track: null, stream: null, by: null };
}
$('dj-play-file').onclick = djPlayFile;
$('dj-play-tab').onclick = djPlayTab;
$('dj-play-spotify').onclick = () => {
  const parsed = parseSpotifyLink($('dj-spotify').value);
  if (!parsed) return toast('Paste a Spotify track, album, or playlist link.');
  startDjSpotify(parsed.type, parsed.id, S.myName);
  wsSend({ type: 'dj', action: 'start-spotify', spotifyType: parsed.type, spotifyId: parsed.id });
  $('dj-modal').classList.add('hidden');
};
$('spotify-dj-hide').onclick = () => $('spotify-dj-card').classList.add('hidden'); // minimize for me only
$('dj-play-youtube').onclick = () => {
  const yid = parseYoutubeLink($('dj-youtube').value);
  if (!yid) return toast('Paste a YouTube video link.');
  startDjYoutube(yid, S.myName);
  wsSend({ type: 'dj', action: 'start-youtube', youtubeId: yid });
  $('dj-modal').classList.add('hidden');
};
$('youtube-dj-hide').onclick = () => hideYoutubeCard(); // minimize for me only (stops my playback)
$('dj-play-url').onclick = () => {
  const url = $('dj-url').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Paste a valid http(s) audio URL.');
  startDjUrl(url, S.myName);
  wsSend({ type: 'dj', action: 'start-url', url });
  $('dj-modal').classList.add('hidden');
};
$('dj-stop').onclick = () => { stopDjLocal(); wsSend({ type: 'dj', action: 'stop' }); $('dj-modal').classList.add('hidden'); };
$('dj-volume').oninput = (e) => {
  const v = (e.target.value | 0) / 100;
  if (S.dj.audio) S.dj.audio.volume = v;
  if (S.dj.gainNode) { try { S.dj.gainNode.gain.value = v; } catch {} }
  wsSend({ type: 'dj', action: 'volume', volume: v });
};

/* ============================== boot ============================== */
connect();

/* ============================== profiles ============================== */
let profileName = null, profileData = null;
$('profile-close').onclick = () => $('profile-modal').classList.add('hidden');
$('my-profile-btn').onclick = () => openProfile(S.myName, true);

function openProfile(name, edit) {
  profileName = name;
  wsSend({ type: 'get-profile', name });
  $('profile-body').innerHTML = '<p style="color:var(--muted)">Loading profile...</p>';
  $('profile-modal').classList.remove('hidden');
  $('profile-modal').dataset.edit = edit ? '1' : '';
}

function renderProfile() {
  const body = $('profile-body');
  const isMine = profileName === S.myName;
  const edit = isMine || $('profile-modal').dataset.edit === '1';
  const pr = profileData || { bio: '', photos: [] };
  const u = [...S.roomUsers.values()].find(x => x.name === profileName);
  const photo = (u && u.photo) || S.myPhoto;

  let html = `<div style="text-align:center;margin-bottom:12px">`;
  html += photo ? `<img src="${esc(photo)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover">`
                : `<div style="width:96px;height:96px;border-radius:50%;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:2.5em;margin:0 auto">👤</div>`;
  html += `<h3 style="margin:8px 0 4px">${esc(profileName)}</h3></div>`;

  // bio
  if (edit && isMine) {
    html += `<textarea id="profile-bio" rows="3" placeholder="Tell people about yourself..." style="width:100%;background:var(--bg2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit;resize:vertical">${esc(pr.bio || '')}</textarea>`;
    html += `<button id="profile-save-bio" class="btn-ghost" style="margin:8px 0">💾 Save bio</button>`;
  } else if (pr.bio) {
    html += `<p style="background:var(--bg2);border-radius:8px;padding:10px;margin:0 0 12px">${esc(pr.bio)}</p>`;
  }

  // photo gallery
  html += `<h4 style="margin:12px 0 8px">📸 Photos (${pr.photos.length}/6)</h4>`;
  html += `<div class="profile-gallery">`;
  pr.photos.forEach((p, i) => {
    html += `<div class="pg-photo"><img src="${esc(p)}" alt="">
      ${edit && isMine ? `<button data-del="${i}" title="Delete">✕</button>` : ''}</div>`;
  });
  html += `</div>`;
  if (edit && isMine && pr.photos.length < 6) {
    html += `<label class="btn-ghost" style="display:inline-block;margin-top:8px;cursor:pointer">📤 Upload photo
      <input type="file" id="profile-upload" accept="image/*" style="display:none"></label>`;
  }
  body.innerHTML = html;

  if (edit && isMine) {
    $('profile-save-bio').onclick = () => {
      wsSend({ type: 'set-bio', bio: $('profile-bio').value });
      toast('Bio saved ✓');
    };
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => wsSend({ type: 'del-photo', index: b.dataset.del }));
    const up = $('profile-upload');
    if (up) up.onchange = () => {
      const f = up.files[0];
      if (!f) return;
      compressPhoto(f, (dataUrl) => wsSend({ type: 'add-photo', dataUrl }));
    };
  }
}

/* compress image before upload */
function compressPhoto(file, cb) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 800;
    let { width: w, height: h } = img;
    if (w > max || h > max) { const r = max / Math.max(w, h); w *= r; h *= r; }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    cb(c.toDataURL('image/jpeg', 0.75));
  };
  img.src = url;
}

/* restore own profile from local backup if server lost it */
let _restored = false;
function maybeRestoreProfile(serverPr) {
  if (_restored) return;
  const empty = !serverPr || (!serverPr.bio && !(serverPr.photos || []).length);
  if (!empty) return;
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem('camwave_profile') || 'null'); } catch {}
  if (!backup || (!backup.bio && !(backup.photos || []).length)) return;
  _restored = true;
  if (backup.bio) wsSend({ type: 'set-bio', bio: backup.bio });
  for (const p of (backup.photos || []).slice(0, 6)) wsSend({ type: 'add-photo', dataUrl: p });
  toast('📸 Restored your profile photos ✓');
}

/* 2-minute mic countdown */
let talkCountdownInt = null;
function startTalkCountdown(secs) {
  clearInterval(talkCountdownInt);
  let left = secs;
  const el = document.createElement('div');
  el.id = 'talk-countdown';
  el.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);border:1px solid var(--accent1);border-radius:20px;padding:6px 16px;font-weight:700;z-index:9000;';
  document.body.appendChild(el);
  const tick = () => {
    const m = Math.floor(left / 60), sec = left % 60;
    el.textContent = `🎙 ${m}:${String(sec).padStart(2, '0')}`;
    el.style.borderColor = left <= 30 ? 'var(--bad)' : 'var(--accent1)';
    if (left <= 0) { clearInterval(talkCountdownInt); el.remove(); return; }
    left--;
  };
  tick();
  talkCountdownInt = setInterval(tick, 1000);
  // clear on mute/timeout
  const orig = window.__talkTimeoutHandler;
}
// remove countdown when muted or timeout
const _origOnServer = onServer;

/* savage kick/ban modal */
function showBlastModal(title, text) {
  let ov = document.getElementById('blast-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'blast-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.9);padding:20px;';
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div style="text-align:center;max-width:400px">
    <div style="font-size:3em;margin-bottom:12px">${title.split(' ')[0]}</div>
    <h2 style="color:var(--bad);margin:0 0 12px">${esc(title)}</h2>
    <p style="font-size:1.1em;line-height:1.5">${esc(text)}</p>
    <button id="blast-ok" class="btn-primary" style="margin-top:16px">Fine. Whatever. 😤</button>
  </div>`;
  ov.style.display = 'flex';
  document.getElementById('blast-ok').onclick = () => ov.style.display = 'none';
}
/* toxic ban noise: dissonant screech */
function blastToxicNoise() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    [220, 233, 247, 110].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.15 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.15); o.stop(ctx.currentTime + i * 0.15 + 0.55);
    });
  } catch {}
}

/* ============================== JUKEBOX ============================== */
const JB_GENRES = ['rap','techno','country','pop','rock'];
const JB_ICONS = { rap: '🎤', techno: '🎛️', country: '🤠', pop: '⭐', rock: '🎸' };
let jbPlaylists = {}, jbGenre = 'rap';
$('jukebox-btn').onclick = () => { renderJukebox(); $('jukebox-modal').classList.remove('hidden'); };
$('jukebox-close').onclick = () => $('jukebox-modal').classList.add('hidden');
function renderJukebox() {
  const tabs = $('jukebox-tabs'); tabs.innerHTML = '';
  for (const g of JB_GENRES) {
    const b = document.createElement('button');
    b.className = 'btn-ghost' + (g === jbGenre ? ' active' : '');
    b.textContent = `${JB_ICONS[g]} ${g[0].toUpperCase() + g.slice(1)}`;
    b.onclick = () => { jbGenre = g; renderJukebox(); };
    tabs.appendChild(b);
  }
  const list = $('jukebox-list'); list.innerHTML = '';
  const tracks = (jbPlaylists[jbGenre] || []);
  const canAdd = S.siteOwner || ['owner','admin'].includes(S.room?.myRole);
  $('jukebox-add').classList.toggle('hidden', !canAdd);
  if (!tracks.length) {
    list.innerHTML = `<p style="color:var(--muted)">No tracks yet. ${canAdd ? 'Add some below!' : ''}</p>`;
  }
  tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `<span class="nm"><b>${esc(t.name)}</b></span>
      <span><button class="btn-ghost jb-play" data-i="${i}">▶</button>
      ${canAdd ? `<button class="btn-ghost jb-del" data-i="${i}">🗑️</button>` : ''}</span>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.jb-play').forEach(b => b.onclick = () => {
    const t = tracks[b.dataset.i | 0];
    if (!t) return;
    startDjUrl(t.url, S.myName);
    wsSend({ type: 'dj', action: 'start-url', url: t.url });
    $('jukebox-modal').classList.add('hidden');
    toast(`🎵 Now playing: ${t.name}`);
  });
  list.querySelectorAll('.jb-del').forEach(b => b.onclick = () => {
    wsSend({ type: 'jukebox-remove', genre: jbGenre, index: b.dataset.i | 0, roomId: S.room.id });
  });
}
$('jb-add-btn').onclick = () => {
  const name = $('jb-name').value.trim(), url = $('jb-url').value.trim();
  const file = $('jb-file').files[0];
  if (!name) return toast('Enter a track name.');
  if (file) {
    if (file.size > 15 * 1024 * 1024) return toast('File too big (15MB max).');
    const rd = new FileReader();
    rd.onload = () => {
      wsSend({ type: 'jukebox-add', genre: jbGenre, name, url: rd.result, roomId: S.room.id });
      $('jb-name').value = ''; $('jb-url').value = ''; $('jb-file').value = '';
      toast('🎵 Track added!');
    };
    rd.readAsDataURL(file);
  } else if (/^https?:\/\//i.test(url)) {
    wsSend({ type: 'jukebox-add', genre: jbGenre, name, url, roomId: S.room.id });
    $('jb-name').value = ''; $('jb-url').value = '';
    toast('🎵 Track added!');
  } else {
    toast('Add an MP3 URL or pick a file.');
  }
};

/* ============================== SOUNDBOARD ============================== */
const SFX_LIST = [
  { id: 'fart', icon: '💨', name: 'Fart' },
  { id: 'airhorn', icon: '📯', name: 'Air Horn' },
  { id: 'trombone', icon: '🎺', name: 'Sad Trombone' },
  { id: 'rimshot', icon: '🥁', name: 'Rimshot' },
  { id: 'boom', icon: '💥', name: 'Vine Boom' },
  { id: 'bruh', icon: '💀', name: 'Bruh' },
  { id: 'crickets', icon: '🦗', name: 'Crickets' },
  { id: 'applause', icon: '👏', name: 'Applause' },
  { id: 'record', icon: '⏪', name: 'Record Scratch' },
  { id: 'error', icon: '⚠️', name: 'Windows Error' },
  { id: 'notify', icon: '🔔', name: 'Notification' },
  { id: 'laugh', icon: '😂', name: 'Evil Laugh' },
  { id: 'coin', icon: '🪙', name: 'Mario Coin' },
  { id: 'mariodeath', icon: '🍄', name: 'Mario Death' },
  { id: 'oof', icon: '🧱', name: 'Roblox Oof' },
  { id: 'levelup', icon: '⬆️', name: 'Level Up' },
  { id: 'victory', icon: '🏆', name: 'Victory' },
  { id: 'gameover', icon: '🎮', name: 'Game Over' },
  { id: 'wasted', icon: '💀', name: 'WASTED' },
  { id: 'missionfail', icon: '🎖️', name: 'Mission Failed' },
  { id: 'emergency', icon: '🚨', name: 'Emergency!' },
  { id: 'braaam', icon: '📢', name: 'BRAAAM' },
  { id: 'dramatic', icon: '🎻', name: 'Dramatic' },
  { id: 'failhorn', icon: '📉', name: 'Fail Horn' },
  { id: 'boo', icon: '👎', name: 'Crowd Boo' },
  { id: 'cheer', icon: '🎉', name: 'Crowd Cheer' },
  { id: 'sadviolin', icon: '😢', name: 'Sad Violin' },
  { id: 'pipe', icon: '🔩', name: 'Metal Pipe' },
  { id: 'iphone', icon: '📱', name: 'iPhone Ding' },
  { id: 'xp', icon: '🖥️', name: 'XP Startup' },
  { id: 'hadouken', icon: '🔥', name: 'Hadouken' },
  { id: 'animewow', icon: '✨', name: 'Anime Wow' },
  { id: 'pacman', icon: '👾', name: 'Pacman Death' },
  { id: 'creeper', icon: '💚', name: 'Creeper' },
  { id: 'nyan', icon: '🌈', name: 'Nyan Cat' },
];
$('sfx-btn').onclick = () => {
  const g = $('sfx-grid'); g.innerHTML = '';
  for (const fx of SFX_LIST) {
    const b = document.createElement('button');
    b.className = 'btn-ghost'; b.style.cssText = 'padding:14px 6px;font-size:1.6em;display:flex;flex-direction:column;align-items:center;gap:4px';
    b.innerHTML = `${fx.icon}<span style="font-size:.55em">${fx.name}</span>`;
    b.onclick = () => { wsSend({ type: 'sfx', id: fx.id }); playSfx(fx.id); };
    g.appendChild(b);
  }
  $('sfx-modal').classList.remove('hidden');
};
$('sfx-close').onclick = () => $('sfx-modal').classList.add('hidden');

const SFX_FILES = { fart:1, boom:1, animewow:1, error:1, laugh:1, oof:1, bruh:1, pipe:1, coin:1, airhorn:1, notify:1, rimshot:1, record:1, applause:1, crickets:1, trombone:1, wasted:1, emergency:1, xp:1, nyan:1, cheer:1, boo:1 };
function playSfx(id) {
  // real recorded sound if we have the file
  if (SFX_FILES[id]) {
    try {
      const a = new Audio('/sfx/' + id + '.mp3');
      a.volume = .8;
      a.play().catch(() => playSfxSynth(id));
      return;
    } catch { /* fall through to synth */ }
  }
  playSfxSynth(id);
}
function playSfxSynth(id) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const osc = (type, f0, f1, t0, dur, vol = .3) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t + t0);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + t0 + dur);
      g.gain.setValueAtTime(.0001, t + t0);
      g.gain.exponentialRampToValueAtTime(vol, t + t0 + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t + t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + t0); o.stop(t + t0 + dur + .05);
    };
    const noise = (t0, dur, vol = .3, freq = 1000) => {
      const len = ctx.sampleRate * dur, buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t + t0);
      g.gain.exponentialRampToValueAtTime(.0001, t + t0 + dur);
      src.connect(f); f.connect(g); g.connect(ctx.destination);
      src.start(t + t0);
    };
    switch (id) {
      case 'fart': // sputtering low osc
        for (let i = 0; i < 8; i++) osc('sawtooth', 90 - i * 6, 60 - i * 5, i * .09, .12, .35);
        break;
      case 'airhorn':
        osc('sawtooth', 392, 392, 0, .7, .4); osc('sawtooth', 415, 415, 0, .7, .3);
        break;
      case 'trombone': // womp womp womppp
        osc('triangle', 220, 220, 0, .25, .35); osc('triangle', 208, 208, .3, .25, .35);
        osc('triangle', 196, 185, .6, .6, .35);
        break;
      case 'rimshot': // ba dum tss
        noise(0, .08, .4, 3000); noise(.18, .08, .4, 3000); noise(.36, .3, .25, 6000);
        break;
      case 'boom':
        osc('sine', 150, 40, 0, .5, .5);
        break;
      case 'bruh':
        osc('sine', 160, 90, 0, .6, .4);
        break;
      case 'crickets':
        for (let i = 0; i < 6; i++) osc('sine', 4200, 4200, i * .25, .08, .12);
        break;
      case 'applause':
        for (let i = 0; i < 12; i++) noise(Math.random() * .8, .1, .2, 2500 + Math.random() * 2000);
        break;
      case 'record':
        osc('sawtooth', 800, 200, 0, .4, .25); noise(0, .15, .2, 4000);
        break;
      case 'error':
        osc('square', 660, 660, 0, .15, .2); osc('square', 520, 520, .18, .25, .2);
        break;
      case 'notify':
        osc('sine', 880, 880, 0, .12, .3); osc('sine', 1320, 1320, .14, .18, .3);
        break;
      case 'laugh':
        for (let i = 0; i < 5; i++) osc('sawtooth', 300 - i * 20, 200 - i * 15, i * .16, .15, .3);
        break;
      case 'coin':
        osc('square', 988, 988, 0, .08, .25); osc('square', 1319, 1319, .08, .3, .25);
        break;
      case 'mariodeath':
        osc('square', 500, 100, 0, .5, .3); osc('square', 300, 60, .5, .5, .3);
        break;
      case 'oof':
        osc('sine', 300, 120, 0, .25, .4);
        break;
      case 'levelup':
        [523, 659, 784, 1047].forEach((f, i) => osc('square', f, f, i * .1, .15, .25));
        break;
      case 'victory':
        [523, 523, 523, 659, 784, 1047].forEach((f, i) => osc('triangle', f, f, i * .14, .2, .35));
        break;
      case 'gameover':
        [392, 370, 349, 311].forEach((f, i) => osc('triangle', f, f * .98, i * .22, .25, .35));
        break;
      case 'wasted':
        osc('sine', 110, 55, 0, 1.2, .5); osc('sine', 165, 82, 0, 1.2, .3);
        break;
      case 'missionfail':
        osc('square', 220, 220, 0, .3, .3); osc('square', 220, 220, .4, .3, .3); osc('square', 174, 174, .8, .6, .3);
        break;
      case 'emergency':
        for (let i = 0; i < 3; i++) { osc('sawtooth', 600, 900, i * .4, .2, .3); osc('sawtooth', 900, 600, i * .4 + .2, .2, .3); }
        break;
      case 'braaam':
        osc('sawtooth', 65, 60, 0, 1.5, .5); osc('sawtooth', 98, 92, 0, 1.5, .35);
        break;
      case 'dramatic':
        osc('sawtooth', 146, 146, 0, .3, .35); osc('sawtooth', 146, 146, .35, .3, .35); osc('sawtooth', 220, 220, .7, .7, .4);
        break;
      case 'failhorn':
        osc('sawtooth', 300, 280, 0, .25, .3); osc('sawtooth', 280, 260, .28, .25, .3);
        osc('sawtooth', 260, 240, .56, .25, .3); osc('sawtooth', 220, 150, .84, .8, .35);
        break;
      case 'boo':
        noise(0, 1.2, .3, 500); osc('sawtooth', 150, 120, 0, 1.2, .15);
        break;
      case 'cheer':
        noise(0, 1.5, .35, 2000);
        [523, 659, 784].forEach(f => osc('triangle', f, f, Math.random() * .5, .4, .15));
        break;
      case 'sadviolin':
        osc('sawtooth', 440, 415, 0, .4, .25); osc('sawtooth', 415, 392, .45, .4, .25); osc('sawtooth', 392, 370, .9, .8, .25);
        break;
      case 'pipe': // metallic clang: inharmonic partials
        [800, 1250, 1730, 2310].forEach(f => osc('sine', f, f * .99, 0, .8, .2));
        noise(0, .1, .4, 5000);
        break;
      case 'iphone':
        osc('sine', 1568, 1568, 0, .15, .3); osc('sine', 2093, 2093, .18, .3, .3);
        break;
      case 'xp':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => osc('sine', f, f, i * .18, .25, .3));
        break;
      case 'hadouken':
        osc('sawtooth', 200, 800, 0, .4, .3); noise(.4, .3, .4, 1500); osc('sine', 100, 50, .4, .4, .5);
        break;
      case 'animewow':
        [1047, 1319, 1568, 2093, 2637].forEach((f, i) => osc('sine', f, f, i * .07, .2, .25));
        break;
      case 'pacman':
        for (let i = 0; i < 4; i++) osc('square', 600 - i * 100, 300 - i * 50, i * .2, .18, .25);
        osc('square', 200, 50, .8, .5, .3);
        break;
      case 'creeper':
        noise(0, .8, .25, 6000); osc('sine', 80, 40, .8, .6, .5); noise(.8, .4, .4, 800);
        break;
      case 'nyan':
        [784, 988, 1175, 784, 988, 1175, 784, 659].forEach((f, i) => osc('square', f, f, i * .12, .11, .2));
        break;
    }
  } catch {}
}

/* ============================== VIDEO STUDIO ============================== */
const STUDIO_FILTERS = [
  { id: 'none', name: 'Normal', css: 'none' },
  { id: 'bw', name: 'B&W', css: 'grayscale(1)' },
  { id: 'sepia', name: 'Vintage', css: 'sepia(.8)' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.8) contrast(1.2)' },
  { id: 'cool', name: 'Cool', css: 'hue-rotate(30deg) saturate(1.3)' },
  { id: 'warm', name: 'Warm', css: 'sepia(.4) saturate(1.4)' },
  { id: 'invert', name: 'Trippy', css: 'invert(.9) hue-rotate(180deg)' },
  { id: 'blur', name: 'Dreamy', css: 'blur(2px) saturate(1.5)' },
];
const STUDIO_SPEEDS = [0.5, 1, 1.5, 2];
const STUDIO_EMOJIS = ['😂','🔥','💯','😍','🤯','💀','🎉','⭐','👑','💪'];
let studio = { video: null, filter: 'none', speed: 1, playing: false, raf: null, stickers: [] };

$('studio-btn').onclick = () => $('studio-modal').classList.remove('hidden');
$('studio-close').onclick = () => { studioStop(); $('studio-modal').classList.add('hidden'); };

$('studio-file').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 100 * 1024 * 1024) return toast('Video too big (100MB max).');
  const url = URL.createObjectURL(f);
  studioLoad(url);
};
function studioLoad(url) {
  studioStop();
  const v = document.createElement('video');
  v.src = url; v.muted = false; v.playsInline = true; v.crossOrigin = 'anonymous';
  v.onloadedmetadata = () => {
    studio.video = v;
    $('studio-editor').classList.remove('hidden');
    $('studio-start').max = 100; $('studio-end').max = 100;
    $('studio-start').value = 0; $('studio-end').value = 100;
    studioUpdateTrimLabel();
    studioBuildFilters(); studioBuildSpeeds(); studioBuildStickers();
    studioDrawFrame();
    $('studio-status').textContent = `Loaded: ${v.duration.toFixed(1)}s`;
  };
  v.onerror = () => toast('Could not load that video.');
}
function studioBuildFilters() {
  const el = $('studio-filters'); el.innerHTML = '';
  for (const f of STUDIO_FILTERS) {
    const b = document.createElement('button');
    b.className = 'btn-ghost' + (studio.filter === f.id ? ' active' : '');
    b.textContent = f.name; b.style.fontSize = '.8em';
    b.onclick = () => { studio.filter = f.id; studioBuildFilters(); studioDrawFrame(); };
    el.appendChild(b);
  }
}
function studioBuildSpeeds() {
  const el = $('studio-speeds'); el.innerHTML = '';
  for (const sp of STUDIO_SPEEDS) {
    const b = document.createElement('button');
    b.className = 'btn-ghost' + (studio.speed === sp ? ' active' : '');
    b.textContent = sp + 'x'; b.style.fontSize = '.8em';
    b.onclick = () => { studio.speed = sp; studioBuildSpeeds(); };
    el.appendChild(b);
  }
}
function studioBuildStickers() {
  let wrap = $('studio-stickers');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'studio-stickers';
    wrap.innerHTML = '<label>😎 Stickers (tap to add)</label><div id="studio-sticker-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px"></div>';
    $('studio-speeds').parentElement.after(wrap);
  }
  const row = $('studio-sticker-row'); row.innerHTML = '';
  for (const em of STUDIO_EMOJIS) {
    const b = document.createElement('button');
    b.className = 'btn-ghost'; b.textContent = em; b.style.fontSize = '1.4em';
    b.onclick = () => {
      studio.stickers.push({ emoji: em, x: .5 + (Math.random() - .5) * .4, y: .3 + Math.random() * .4, size: 60 });
      studioDrawFrame();
    };
    row.appendChild(b);
  }
  const clr = document.createElement('button');
  clr.className = 'btn-ghost'; clr.textContent = '🗑️ Clear'; clr.style.fontSize = '.8em';
  clr.onclick = () => { studio.stickers = []; studioDrawFrame(); };
  row.appendChild(clr);
}
function studioTrimRange() {
  const v = studio.video;
  if (!v) return [0, 0];
  const s = $('studio-start').value / 100 * v.duration;
  const e = $('studio-end').value / 100 * v.duration;
  return [Math.min(s, e), Math.max(s, e)];
}
function studioUpdateTrimLabel() {
  const [s, e] = studioTrimRange();
  $('studio-trim-label').textContent = `${s.toFixed(1)}s → ${e.toFixed(1)}s`;
}
$('studio-start').oninput = $('studio-end').oninput = () => { studioUpdateTrimLabel(); studioDrawFrame(); };
$('studio-text').oninput = () => studioDrawFrame();
function studioDrawFrame() {
  const v = studio.video;
  if (!v) return;
  const cv = $('studio-canvas'), ctx = cv.getContext('2d');
  cv.width = v.videoWidth || 640; cv.height = v.videoHeight || 360;
  const f = STUDIO_FILTERS.find(x => x.id === studio.filter);
  ctx.filter = f ? f.css : 'none';
  const [s] = studioTrimRange();
  if (!studio.playing) { try { v.currentTime = Math.min(s, v.duration - .1); } catch {} }
  ctx.drawImage(v, 0, 0, cv.width, cv.height);
  ctx.filter = 'none';
  // text overlay
  const txt = $('studio-text').value;
  if (txt) {
    ctx.font = `bold ${Math.floor(cv.height / 12)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
    ctx.strokeText(txt, cv.width / 2, cv.height * .88);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, cv.width / 2, cv.height * .88);
  }
  // stickers
  ctx.textAlign = 'center';
  for (const st of studio.stickers) {
    ctx.font = `${st.size}px sans-serif`;
    ctx.fillText(st.emoji, st.x * cv.width, st.y * cv.height);
  }
}
$('studio-play').onclick = () => {
  const v = studio.video;
  if (!v) return;
  if (studio.playing) { studioStop(); $('studio-play').textContent = '▶ Preview'; return; }
  const [s, e] = studioTrimRange();
  v.currentTime = s; v.playbackRate = studio.speed;
  v.play().then(() => {
    studio.playing = true;
    $('studio-play').textContent = '⏸ Stop';
    const loop = () => {
      if (!studio.playing) return;
      if (v.currentTime >= e || v.ended) { studioStop(); $('studio-play').textContent = '▶ Preview'; return; }
      studioDrawFrame();
      studio.raf = requestAnimationFrame(loop);
    };
    loop();
  }).catch(() => toast('Preview failed.'));
};
function studioStop() {
  studio.playing = false;
  if (studio.raf) cancelAnimationFrame(studio.raf);
  if (studio.video) try { studio.video.pause(); } catch {}
}
$('studio-export').onclick = async () => {
  const v = studio.video;
  if (!v) return;
  const [s, e] = studioTrimRange();
  const dur = (e - s) / studio.speed;
  if (dur <= 0 || dur > 60) return toast('Trim to 60 seconds or less.');
  $('studio-status').textContent = '⏳ Exporting...';
  $('studio-export').disabled = true;
  try {
    const cv = $('studio-canvas');
    const stream = cv.captureStream(30);
    // capture audio too
    let combined = stream;
    try {
      const actx = new AudioContext();
      const src = actx.createMediaElementSource(v);
      const dest = actx.createMediaStreamDestination();
      src.connect(dest); src.connect(actx.destination);
      combined = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    } catch {}
    const rec = new MediaRecorder(combined, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      // share to room
      const rd = new FileReader();
      rd.onload = () => {
        wsSend({ type: 'chat-media', kind: 'video', dataUrl: rd.result, roomId: S.room.id });
        $('studio-status').textContent = '✅ Shared to room!';
        toast('🎬 Video shared to room!');
      };
      rd.readAsDataURL(blob);
      // also offer download
      const a = document.createElement('a');
      a.href = url; a.download = 'camwave-edit.webm';
      a.click();
      $('studio-export').disabled = false;
    };
    // play through the trim range for capture
    v.currentTime = s; v.playbackRate = studio.speed;
    studio.playing = true;
    const drawLoop = () => {
      if (!studio.playing) return;
      if (v.currentTime >= e) { studioStop(); return; }
      studioDrawFrame();
      studio.raf = requestAnimationFrame(drawLoop);
    };
    v.play().then(() => { rec.start(); drawLoop(); });
    const stopAt = setTimeout(() => { rec.stop(); studioStop(); }, dur * 1000 + 500);
    rec.onstop = ((orig) => () => { clearTimeout(stopAt); orig(); })(rec.onstop);
  } catch (err) {
    $('studio-status').textContent = 'Export failed: ' + err.message;
    $('studio-export').disabled = false;
  }
};
