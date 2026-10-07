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
      localStorage.setItem('camwave_nick', m.name);
      $('login-screen').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('my-name').textContent = m.name;
      $('siteowner-btn').classList.toggle('hidden', !S.siteOwner);
      if (m.siteBanner) { S.siteBanner = m.siteBanner; showLetterhead(m.siteBanner); }
      if (pendingPhoto) { S.myPhoto = pendingPhoto; wsSend({ type: 'set-photo', dataUrl: pendingPhoto }); pendingPhoto = null; }
      wsSend({ type: 'get-contacts' });
      break;
    case 'site-banner':
      S.siteBanner = m.banner; break;
    case 'warned':
      showWarned(m); break;
    case 'mod-banner':
      showModBanner(m); break;
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
    case 'error':
      if ($('login-screen').classList.contains('hidden')) toast(m.message);
      else { $('login-error').textContent = m.message; }
      break;
    case 'room-list':
      S.rooms = m.rooms; renderRooms(); break;
    case 'room-joined': onRoomJoined(m); break;
    case 'left-room': break;
    case 'user-joined': onUserJoined(m.user); break;
    case 'user-left': onUserLeft(m.id, m.reason); break;
    case 'user-status': setUserProp(m.id, 'status', m.status); break;
    case 'user-media': setUserProp(m.id, 'videoOn', m.videoOn); break;
    case 'user-talking': setUserProp(m.id, 'talking', m.talking); if (typeof m.micLive === 'boolean') setUserProp(m.id, 'micLive', m.micLive); renderUserList(); updateTileStates(); break;
    case 'user-muted': setUserProp(m.id, 'muted', true); renderUserList(); break;
    case 'user-unmuted': setUserProp(m.id, 'muted', false); renderUserList(); break;
    case 'room-roles':
      for (const u of m.users) setUserProp(u.id, 'role', u.role);
      renderUserList(); refreshModUI(); break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'chat-msg': addChatMsg(m); break;
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
      setMicEnabled(false, true); toast('🔇 Muted by ' + m.by); break;
    case 'force-unmute':
      toast('🔊 Unmuted by ' + m.by + ' — you may talk now'); break;
    case 'talk-timeout':
      setMicEnabled(false, true); toast(`⏱ Talk time limit (${m.limitSec}s) reached — mic auto-muted`); break;
    case 'kicked': leaveRoomUI(); toast('👢 You were kicked by ' + m.by); break;
    case 'banned': leaveRoomUI(); toast('🚫 ' + m.message); break;
    case 'notice': addSysMsg(m.text); toast(m.text); break;
    case 'room-settings-updated':
      if (S.room) { S.room.settings = m.settings; renderRoomHeader(); }
      addSysMsg(m.settings.openMic ? '🎙 Open mic is now ON' : '🔇 Open mic is now OFF — push-to-talk mode');
      break;
    case 'ban-list': renderBanList(m.bans); break;
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
  wsSend({ type: 'hello', name, gender, age });
}
$('status-select').onchange = (e) => wsSend({ type: 'set-status', status: e.target.value });

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
  for (const r of rooms) {
    const d = document.createElement('div');
    d.className = 'room-card';
    d.innerHTML = `<h3>${esc(r.name)}</h3>
      <div class="meta"><span>👥 ${r.userCount}</span>
      <span class="pill ${r.userCount > 5 ? 'hot' : ''}">${r.openMic ? '🎙 open mic' : '🔊 push-to-talk'}</span>
      ${r.djActive ? '<span class="pill hot">🎧 DJ live</span>' : ''}</div>`;
    d.onclick = () => wsSend({ type: 'join-room', roomId: r.id });
    list.appendChild(d);
  }
}

/* ============================== room ============================== */
function onRoomJoined(m) {
  S.room = m.room;
  S.roomUsers = new Map(m.users.map(u => [u.id, u]));
  S.selfMuted = m.selfMuted;
  $('view-lobby').classList.add('hidden');
  $('view-room').classList.remove('hidden');
  $('chat-log').innerHTML = '';
  $('activity-log').innerHTML = '';
  $('video-grid').innerHTML = '';
  S.peers.clear(); S.spotlightId = null;
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
  }
}

$('leave-room-btn').onclick = () => { wsSend({ type: 'leave-room' }); leaveRoomUI(); };
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
    row.className = 'user-row ledger-row role-' + (u.role || 'member');
    const micIcon = u.muted ? '🔇' : (u.micLive ? '🎙️' : '');
    const camIcon = u.videoOn ? '🎥' : '';
    const whoIcon = u.gender === 'f' ? '♀' : '♂';
    const ageTxt = (u.age ?? '') === '' ? '' : `${whoIcon} ${u.age}`;
    row.innerHTML = `<span class="dot ${u.status||'online'}"></span>
      <span class="nm"><b>${esc(u.name)}</b> ${micIcon} ${camIcon} ${u.talking ? '🟢' : ''}</span>
      <span class="who">${ageTxt}</span>
      <span class="st">${ROLE_LABEL[u.role] || ''}</span>`;
    if (u.id !== S.myId) row.onclick = (e) => showUserPopup(u, e.clientX, e.clientY);
    el.appendChild(row);
  }
}

function canActOn(target) {
  if (!S.room) return 0;
  const mine = ROLE_RANK[S.room.myRole] || 0;
  const theirs = ROLE_RANK[target.role] || 0;
  return mine > theirs ? mine : 0;
}

function showUserPopup(u, x, y) {
  const pop = $('user-popup');
  const rank = canActOn(u);
  let html = `<div style="font-weight:700;margin-bottom:6px">${esc(u.name)}</div>`;
  html += `<button data-a="view">📹 View camera</button>`;
  html += `<button data-a="dm">💬 Message</button>`;
  if (rank >= 1) {
    html += `<button data-a="warn">⚠️ Warn</button>`;
    html += `<button data-a="mute">${u.muted ? '🔊 Unmute' : '🔇 Mute'}</button>`;
    html += `<button data-a="kick" class="danger">👢 Kick</button>`;
  }
  if (rank >= 2) {
    html += `<button data-a="ban" class="danger">🚫 Ban</button>`;
    html += `<button data-a="ipban" class="danger">🚫⛔ IP-ban</button>`;
  }
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
  if (a === 'dm') { openDm(u.id, u.name); return; }
  if (a === 'warn') { openWarnModal(u); return; }
  const map = { mute: u.muted ? 'unmute' : 'mute', kick: 'kick', ban: 'ban', ipban: 'ipban',
                'promote-mod': 'promote-mod', 'promote-admin': 'promote-admin', demote: 'demote' };
  const action = map[a];
  if (!action) return;
  if (['kick','ban','ipban'].includes(action)) {
    if (!confirm(`${action.toUpperCase()} ${u.name}?`)) return;
  }
  wsSend({ type: 'mod-action', action, targetId: u.id, roomId: S.room.id });
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
    // start muted in PTT rooms
    S.localStream.getAudioTracks().forEach(t => t.enabled = false);
    S.selfMuted = true;
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
  if (S.room && S.room.settings.openMic) {
    // open-mic: toggle talk
    setMicEnabled(!S.micOn);
  } else {
    toast(S.room ? '🔊 Push-to-talk mode: hold the TALK button (or Space) to speak.' : '');
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

function setMicEnabled(on, forced) {
  if (on && S.selfMuted && !forced) { toast('🔇 You are muted.'); return; }
  S.micOn = on;
  if (S.localStream) S.localStream.getAudioTracks().forEach(t => t.enabled = on);
  wsSend({ type: on ? 'mic-on' : 'mic-off' });
  updateMediaButtons(); renderUserList();
}

function updateMediaButtons() {
  $('cam-toggle').classList.toggle('off', !S.camOn);
  $('cam-toggle').textContent = S.camOn ? '🎥' : '🚫🎥';
  $('mic-toggle').classList.toggle('off', !S.micOn);
  $('mic-toggle').textContent = S.micOn ? '🎙️' : '🔇';
  const pttMode = !S.room || !S.room.settings.openMic;
  $('ptt-btn').style.display = pttMode ? '' : 'none';
  $('mic-toggle').style.display = pttMode ? 'none' : '';
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
  if (e.code === 'Space' && S.room && !$('view-room').classList.contains('hidden') &&
      document.activeElement.tagName !== 'INPUT') { e.preventDefault(); pttDown(); }
});
addEventListener('keyup', e => { if (e.code === 'Space') pttUp(); });

/* ============================== WebRTC mesh ============================== */
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeer(peerId, offerer) {
  if (S.peers.has(peerId)) return S.peers.get(peerId);
  const pc = new RTCPeerConnection(RTC_CFG);
  const peer = { pc, stream: new MediaStream() };
  S.peers.set(peerId, peer);

  if (S.sharingScreen && S.screenStream) {
    for (const t of S.screenStream.getTracks()) pc.addTrack(t, S.screenStream);
  } else if (S.localStream) {
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
    if (!S.peers.has(el.dataset.peer)) el.remove();
  }
  for (const [id, peer] of S.peers) {
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
    label.innerHTML = `${u && u.sharingScreen ? '🖥️ ' : ''}${esc(u ? u.name : id)} ${u && u.muted ? '🔇' : ''} ${u && ROLE_LABEL[u.role] ? `<span class="role role-${u.role}">${ROLE_LABEL[u.role]}</span>` : ''}`;
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
  el.className = 'chat-msg';
  el.innerHTML = `<span class="who ${m.role==='owner'?'owner':''}">${esc(m.name)}</span><span class="ts">${tsFmt(m.ts)}</span><div>${esc(m.text)}</div>`;
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
      <button class="btn-ghost" data-x="rm" title="Remove">✕</button>`;
    row.onclick = (e) => {
      if (e.target.dataset.x === 'rm') { wsSend({ type: 'remove-contact', id: c.id }); return; }
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
  toast('💬 DM from ' + m.fromName);
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
  $('set-talklimit').value = S.room.settings.talkLimitSec || 0;
  $('settings-modal').classList.remove('hidden');
  wsSend({ type: 'get-ban-list' });
};
$('settings-cancel').onclick = () => $('settings-modal').classList.add('hidden');
$('settings-save').onclick = () => {
  wsSend({ type: 'room-settings', roomId: S.room.id,
    openMic: $('set-openmic').checked,
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
  } else if (m.action === 'stop') {
    stopDjLocal();
    addSysMsg('🎧 DJ stopped.');
  } else if (m.action === 'volume') {
    if (S.dj.audio) S.dj.audio.volume = m.volume;
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
