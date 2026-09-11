'use strict';
/* PGP Room client — all cryptography happens here, in the browser.
   The private key is generated locally and never transmitted. */

const LS = 'pgpchat.identity.v1';
const LS_DISMISS = 'pgpchat.bannerDismissed';
const $ = id => document.getElementById(id);

const state = {
  id: null,            // {fp,keyId,handle,armoredPrivate,armoredPublic,createdAt,privateKey,publicKeyObj}
  pool: [],            // [{fp,handle,publicKey,joinedAt}]
  poolKeys: new Map(), // fp -> openpgp Key
  online: [],
  ws: null,
  wsOpen: false,
  backoff: 1000,
  outbox: [],
  byId: new Map(),     // server message id -> element
  pending: new Map(),  // tmpId -> element
  ttlMs: 48 * 3600 * 1000,
  lastFp: null,
  lastT: 0,
  booted: false,
};

/* ---------------- utilities ---------------- */
const ADJ = ['quiet','swift','amber','lucid','brave','calm','clever','cosmic','crimson','dapper','eager','faded','gentle','hidden','idle','jolly','keen','lively','mellow','nimble','noble','olive','plain','prime','rapid','rustic','silent','solar','steady','tidal','tiny','vivid','wilder','wired','woven','zesty','bold','cobalt','dusty','electric'];
const ANIMALS = ['otter','falcon','lynx','heron','badger','beaver','cobra','condor','crane','dolphin','eagle','egret','ferret','finch','fox','gazelle','gecko','gibbon','hare','hawk','ibex','jackal','koala','lemur','marlin','mink','moose','moth','newt','ocelot','osprey','panda','quail','raven','salmon','sparrow','tapir','tern','viper','wolf'];
function randomHandle() {
  const a = ADJ[crypto.getRandomValues(new Uint32Array(1))[0] % ADJ.length];
  const b = ANIMALS[crypto.getRandomValues(new Uint32Array(1))[0] % ANIMALS.length];
  const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${a}-${b}-${n}`;
}
function hueFor(fp) {
  let h = 0;
  for (let i = 0; i < 6; i++) h = (h * 31 + parseInt(fp.slice(i * 2, i * 2 + 2), 16)) % 360;
  return h;
}
function colorFor(fp) { return `hsl(${hueFor(fp)} 62% 66%)`; }
function fpGroups(fp) { return (fp.match(/.{1,4}/g) || []).join(' '); }
function relTime(t) {
  const d = Date.now() - t;
  if (d < 45000) return 'now';
  if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + 'm ago';
  const dt = new Date(t), now = new Date();
  const hm = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dt.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dt.toDateString() === y.toDateString()) return 'Yesterday ' + hm;
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    (dt.getFullYear() !== now.getFullYear() ? ', ' + dt.getFullYear() : '') + ' ' + hm;
}
function svg(path, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  if (cls) s.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}
const CHECK = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z';
const LOCK = 'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 5a3 3 0 1 1 6 0v3H9V7Zm4 8.7V18a1 1 0 1 1-2 0v-2.3a2 2 0 1 1 2 0Z';

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function banner(text, kind = 'info', spinner = false) {
  const b = $('banner'), t = $('bannerText'), s = $('bannerSpin'), x = $('bannerClose');
  t.textContent = text;
  b.className = 'banner' + (kind === 'info' ? '' : ' ' + kind);
  b.hidden = false;
  s.style.display = spinner ? '' : 'none';
  x.hidden = spinner;
}
function hideBanner() { $('banner').hidden = true; }

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

/* ---------------- identity ---------------- */
async function ensureIdentity() {
  const raw = localStorage.getItem(LS);
  if (raw) {
    try {
      const s = JSON.parse(raw);
      const privateKey = await openpgp.readPrivateKey({ armoredKey: s.armoredPrivate });
      const publicKeyObj = await openpgp.readKey({ armoredKey: s.armoredPublic });
      return { ...s, privateKey, publicKeyObj };
    } catch (e) {
      console.warn('stored identity unreadable:', e.message);
    }
  }
  const handle = randomHandle();
  const gen = await openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name: handle, email: `${handle}@pgpchat.local` }],
    format: 'armored',
  });
  const privateKey = await openpgp.readPrivateKey({ armoredKey: gen.privateKey });
  const id = {
    handle,
    armoredPrivate: gen.privateKey,
    armoredPublic: gen.publicKey,
    fp: privateKey.getFingerprint().toLowerCase(),
    keyId: privateKey.getKeyID().toHex().toLowerCase(),
    createdAt: Date.now(),
  };
  localStorage.setItem(LS, JSON.stringify(id));
  return { ...id, privateKey, publicKeyObj: await openpgp.readKey({ armoredKey: gen.publicKey }) };
}
function saveIdentity(patch) {
  const cur = JSON.parse(localStorage.getItem(LS) || '{}');
  localStorage.setItem(LS, JSON.stringify({ ...cur, ...patch }));
  Object.assign(state.id, patch);
}

/* ---------------- pool ---------------- */
async function refreshPool() {
  const r = await api('/api/pool');
  if (r.retentionHours) state.ttlMs = r.retentionHours * 3600000;
  state.pool = r.keys;
  await parsePoolKeys();
  setRetentionNote();
}
async function parsePoolKeys() {
  state.poolKeys = new Map();
  for (const k of state.pool) {
    try { state.poolKeys.set(k.fp, await openpgp.readKey({ armoredKey: k.publicKey })); } catch { /* skip bad key */ }
  }
}
async function addPoolKey(k) {
  if (state.pool.some(p => p.fp === k.fp)) return;
  state.pool.push({ fp: k.fp, handle: k.handle, publicKey: k.publicKey, joinedAt: k.joinedAt });
  try { state.poolKeys.set(k.fp, await openpgp.readKey({ armoredKey: k.publicKey })); } catch { /* skip */ }
}

/* ---------------- crypto ---------------- */
async function encryptFor(text) {
  const keys = [...state.poolKeys.values()];
  if (!keys.length) throw new Error('no keys in room');
  const ct = await openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    encryptionKeys: keys,
    signingKeys: state.id.privateKey,
    format: 'armored',
  });
  return { ct, recipients: state.pool.map(k => k.fp) };
}
async function decryptFrom(m) {
  try {
    const message = await openpgp.readMessage({ armoredMessage: m.ct });
    const opts = { message, decryptionKeys: state.id.privateKey, format: 'utf8' };
    const senderKey = state.poolKeys.get(m.fp);
    if (senderKey) opts.verificationKeys = senderKey;
    const res = await openpgp.decrypt(opts);
    let verified = false;
    if (senderKey && res.signatures && res.signatures.length) {
      const vals = await Promise.all(res.signatures.map(s => Promise.resolve(s.verified).catch(() => false)));
      verified = vals.some(Boolean);
    }
    return { text: typeof res.data === 'string' ? res.data : String(res.data), verified };
  } catch (e) {
    return { text: null, error: (e && e.message) || 'decryption failed' };
  }
}

/* ---------------- rendering ---------------- */
const msgsEl = () => $('msgs');
const logEl = () => $('log');

function atBottom() {
  const l = logEl();
  return l.scrollHeight - l.scrollTop - l.clientHeight < 120;
}
function scrollBottom(force) {
  const l = logEl();
  if (force || atBottom()) l.scrollTop = l.scrollHeight;
}
function timeEl(t) {
  const s = document.createElement('span');
  s.className = 'time';
  s.dataset.t = t;
  s.textContent = relTime(t);
  return s;
}
function renderMessage(m, dec, own, tmpId) {
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (own ? ' own' : '');
  wrap.dataset.fp = m.fp;
  wrap.dataset.t = m.t;
  const last = msgsEl().lastElementChild;
  if (last && last.classList.contains('msg') && last.dataset.fp === m.fp && (m.t - Number(last.dataset.t)) < 180000) {
    wrap.classList.add('grouped');
  }

  const top = document.createElement('div');
  top.className = 'top';
  if (!own) {
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.style.setProperty('--h', colorFor(m.fp));
    nm.textContent = m.handle;
    top.appendChild(nm);
  }
  top.appendChild(timeEl(m.t));
  wrap.appendChild(top);

  if (dec && dec.text !== null) {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = dec.text;
    if (dec.verified && !own) {
      const b = svg(CHECK, 'badge');
      b.setAttribute('aria-label', 'signature verified');
      body.appendChild(b);
    }
    wrap.appendChild(body);
  } else {
    const f = document.createElement('div');
    f.className = 'fail';
    f.textContent = 'Could not decrypt this message (' + ((dec && dec.error) || 'unknown') + ')';
    wrap.appendChild(f);
  }
  if (tmpId) { wrap.dataset.tmpId = tmpId; state.pending.set(tmpId, wrap); }
  if (m.id) { wrap.dataset.id = m.id; state.byId.set(m.id, wrap); }
  msgsEl().appendChild(wrap);
  return wrap;
}
function finalizeBubble(el, tmpId, mm) {
  state.pending.delete(tmpId);
  el.classList.remove('pending');
  el.dataset.id = mm.id;
  delete el.dataset.tmpId;
  const t = el.querySelector('.time');
  if (t && mm.t) { t.dataset.t = mm.t; t.textContent = relTime(mm.t); }
  state.byId.set(mm.id, el);
}
/* ---- retention: same window the server enforces, applied to this tab ---- */
function fmtWindow(ms) {
  const hours = ms / 3600000;
  if (hours >= 1) { const h = Math.round(hours); return h === 1 ? '1 hour' : `${h} hours`; }
  const mins = Math.max(1, Math.round(ms / 60000));
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}
function setRetentionNote() {
  const el = $('retentionNote');
  if (!el) return;
  el.textContent = `Messages are deleted ${fmtWindow(state.ttlMs)} after they are sent — on this device and on the server.`;
  el.hidden = !state.ttlMs;
}
function pruneOld() {
  const cutoff = Date.now() - state.ttlMs;
  let removed = 0;
  for (const el of [...document.querySelectorAll('.msg')]) {
    if (Number(el.dataset.t) < cutoff) {
      if (el.dataset.id) state.byId.delete(el.dataset.id);
      if (el.dataset.tmpId) state.pending.delete(el.dataset.tmpId);
      el.remove();
      removed++;
    }
  }
  if (removed) {
    // a surviving bubble may have lost its predecessor: recompute grouping
    let prev = null;
    for (const el of document.querySelectorAll('.msg')) {
      const grouped = prev && prev.dataset.fp === el.dataset.fp &&
        (Number(el.dataset.t) - Number(prev.dataset.t)) < 180000;
      el.classList.toggle('grouped', !!grouped);
      prev = el;
    }
  }
  return removed;
}
function addSys(text, t) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = text;
  msgsEl().appendChild(d);
  scrollBottom();
}
function renderLocked(n) {
  const d = $('lockDivider');
  if (!n) { d.hidden = true; return; }
  $('lockText').textContent = n === 1
    ? '1 earlier message can\u2019t be read in this browser \u2014 it wasn\u2019t encrypted to your key'
    : `${n} earlier messages can\u2019t be read in this browser \u2014 they weren\u2019t encrypted to your key`;
  d.hidden = false;
}
function renderPresence() {
  const n = state.online.length;
  $('onlineCount').textContent = n === 1 ? '1 online' : `${n} online`;
  const others = state.online.filter(o => o.fp !== (state.id && state.id.fp)).map(o => o.handle);
  $('onlineCount').title = others.length ? 'in the room: ' + others.join(', ') : '';
}
function updateMeUI() {
  const h = state.id.handle;
  $('myHandle').textContent = h;
  $('mySwatch').style.background = colorFor(state.id.fp);
  $('handleInput').value = h;
  $('fpFull').textContent = fpGroups(state.id.fp.toUpperCase());
  $('createdAt').textContent = new Date(state.id.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const algo = state.id.privateKey && state.id.privateKey.getAlgorithmInfo ? state.id.privateKey.getAlgorithmInfo() : null;
  $('algoTxt').textContent = algo ? `OpenPGP ${algo.algorithm}, Curve25519 ECDH + Ed25519` : 'OpenPGP Curve25519';
}

/* ---------------- history ---------------- */
async function loadHistory() {
  const h = await api(`/api/history?fp=${state.id.fp}&limit=400`);
  if (h.retentionHours) state.ttlMs = h.retentionHours * 3600000;
  setRetentionNote();
  state.lockedCount = h.lockedCount;
  renderLocked(h.lockedCount);
  const fresh = h.messages.filter(m => !state.byId.has(m.id));
  const decs = await Promise.all(fresh.map(m => decryptFrom(m)));
  fresh.forEach((m, i) => {
    if (state.byId.has(m.id)) return;
    const d = decs[i];
    // A bubble we optimistically drew but never got an ack for is now confirmed
    // by history: drop the local copy so it doesn't render twice.
    if (m.fp === state.id.fp && d.text !== null && state.pending.size) {
      for (const [tmpId, el] of state.pending) {
        const shown = el.querySelector('.body');
        if (shown && shown.textContent.trim() === d.text.trim()) {
          state.pending.delete(tmpId);
          if (el.parentNode) el.remove();
          break;
        }
      }
    }
    renderMessage(m, d, m.fp === state.id.fp);
  });
  pruneOld();
}

/* ---------------- websocket ---------------- */
function connect() {
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOpen = true;
    state.backoff = 1000;
    $('connDot').classList.remove('off');
    ws.send(JSON.stringify({ t: 'hello', fp: state.id.fp, handle: state.id.handle }));
    const first = state.booted;
    state.booted = true;
    if (first) {
      refreshPool().catch(() => {});
      loadHistory().catch(() => {});
    }
    while (state.outbox.length) ws.send(JSON.stringify(state.outbox.shift()));
  };
  ws.onclose = ev => {
    state.wsOpen = false;
    $('connDot').classList.add('off');
    // 1008 = the server refused our hello (key no longer in the pool, e.g. admin
    // wiped the room or the pool evicted it). Put the key back, then reconnect.
    if (ev && ev.code === 1008 && Date.now() - (state.lastRereg || 0) > 10000) {
      state.lastRereg = Date.now();
      registerSelf().then(() => refreshPool()).catch(() => {});
    }
    setTimeout(connect, state.backoff);
    state.backoff = Math.min(state.backoff * 1.7, 30000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  ws.onmessage = async ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'welcome') {
      state.online = m.online || [];
      renderPresence();
    } else if (m.t === 'msg') {
      const mm = m.m;
      if (mm.tmpId && state.pending.has(mm.tmpId)) {
        finalizeBubble(state.pending.get(mm.tmpId), mm.tmpId, mm);
        return;
      }
      const el = state.byId.get(mm.id);
      if (el) { el.classList.remove('pending'); return; }
      const own = mm.fp === state.id.fp;
      const dec = await decryptFrom(mm);
      renderMessage(mm, dec, own);
      scrollBottom(!own);
    } else if (m.t === 'ack') {
      const el = m.tmpId && state.pending.get(m.tmpId);
      if (el) finalizeBubble(el, m.tmpId, m);
    } else if (m.t === 'sys') {
      addSys(m.text);
    } else if (m.t === 'presence') {
      state.online = m.online || [];
      renderPresence();
    } else if (m.t === 'key:add') {
      await addPoolKey({ fp: m.key.fp, handle: m.key.handle, publicKey: m.key.publicKey, joinedAt: m.key.joinedAt });
    } else if (m.t === 'err') {
      toast(m.msg || 'server error');
    }
  };
}
function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; }
  if (state.outbox.length < 10) state.outbox.push(obj);
  toast('Reconnecting — message queued');
  connect();
  return false;
}

/* ---------------- composer ---------------- */
function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}
function updateSend() {
  $('sendBtn').disabled = !$('input').value.trim();
}
async function sendCurrent() {
  const el = $('input');
  const text = el.value.trim();
  if (!text || !state.id) return;
  if (text.length > 4000) { toast('Message too long (4000 character limit)'); return; }
  el.value = '';
  autoGrow();
  updateSend();
  const tmpId = crypto.randomUUID();
  const node = renderMessage({ fp: state.id.fp, handle: state.id.handle, t: Date.now(), id: null }, { text, verified: false }, true, tmpId);
  node.classList.add('pending');
  scrollBottom(true);
  try {
    const { ct, recipients } = await encryptFor(text);
    wsSend({ t: 'send', tmpId, ct, recipients });
  } catch (e) {
    state.pending.delete(tmpId);
    node.classList.remove('pending');
    const f = document.createElement('div');
    f.className = 'fail';
    f.textContent = 'Not sent — ' + e.message;
    node.appendChild(f);
    toast('Encryption failed: ' + e.message);
  }
}

/* ---------------- key backup / restore ---------------- */
function backupKey() {
  const blob = new Blob([state.id.armoredPrivate], { type: 'application/pgp-keys' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pgpchat-${state.id.handle}-${state.id.fp.slice(0, 8)}.asc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Backup saved — keep it somewhere safe');
}
async function restoreKey(file) {
  try {
    const text = await file.text();
    const priv = await openpgp.readPrivateKey({ armoredKey: text.trim() });
    const armoredPublic = priv.toPublic().armor();
    const fp = priv.getFingerprint().toLowerCase();
    saveIdentity({
      armoredPrivate: priv.armor(),
      armoredPublic,
      fp,
      keyId: priv.getKeyID().toHex().toLowerCase(),
    });
    toast('Key restored — reloading');
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    toast('Not a readable private key: ' + e.message, 4200);
  }
}

/* ---------------- boot ---------------- */
async function registerSelf() {
  const reg = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({
      fp: state.id.fp,
      keyId: state.id.keyId,
      handle: state.id.handle,
      publicKey: state.id.armoredPublic,
    }),
  });
  state.joinedAt = reg.joinedAt;
  return reg;
}

async function boot() {
  if (!(window.crypto && crypto.subtle)) {
    banner('This room needs HTTPS — the browser\u2019s crypto engine is unavailable on an insecure origin.', 'err');
    return;
  }
  banner('Setting up your key…', 'info', true);
  try {
    state.id = await ensureIdentity();
    updateMeUI();
    const reg = await registerSelf();
    await refreshPool();
    if (reg.isNew && !localStorage.getItem(LS_DISMISS)) {
      banner(`You\u2019re in as ${state.id.handle}. Your key is new to this room, so messages sent before you joined are sealed to older keys and can\u2019t be read in this browser. Messages delete themselves ${fmtWindow(state.ttlMs)} after they are sent. Save a backup of your key so you don\u2019t lose this device\u2019s history.`, 'info');
      $('bannerClose').hidden = false;
    } else {
      hideBanner();
    }
    await loadHistory();
    scrollBottom(true);
    connect();
  } catch (e) {
    banner('Setup failed: ' + e.message + ' — retrying in 5s', 'err');
    setTimeout(boot, 5000);
  }
}

/* ---------------- wiring ---------------- */
$('sendBtn').addEventListener('click', sendCurrent);
$('input').addEventListener('input', () => { autoGrow(); updateSend(); });
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
$('bannerClose').addEventListener('click', () => { hideBanner(); localStorage.setItem(LS_DISMISS, '1'); });

function openSheet() { $('sheet').hidden = false; $('scrim').hidden = false; }
function closeSheet() { $('sheet').hidden = true; $('scrim').hidden = true; }
$('meBtn').addEventListener('click', openSheet);
$('scrim').addEventListener('click', closeSheet);

$('copyFp').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.id.fp.toUpperCase()); toast('Fingerprint copied'); }
  catch { toast('Copy failed — long-press the fingerprint'); }
});
$('backupKey').addEventListener('click', backupKey);
$('restoreKey').addEventListener('change', e => { const f = e.target.files[0]; if (f) restoreKey(f); e.target.value = ''; });
$('saveHandle').addEventListener('click', async () => {
  const v = $('handleInput').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(v)) { toast('2–24 chars: a–z, 0–9, hyphen'); return; }
  try {
    await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ fp: state.id.fp, keyId: state.id.keyId, handle: v, publicKey: state.id.armoredPublic }),
    });
    saveIdentity({ handle: v });
    $('myHandle').textContent = v;
    state.pool = state.pool.map(k => (k.fp === state.id.fp ? { ...k, handle: v } : k));
    toast('Name updated');
  } catch (e) { toast('Could not update: ' + e.message); }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (!state.wsOpen) connect();
    else if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ t: 'ping' }));
  }
});
setInterval(() => {
  document.querySelectorAll('.time[data-t]').forEach(el => { el.textContent = relTime(+el.dataset.t); });
}, 30000);
setInterval(() => { try { pruneOld(); } catch { /* ignore */ } }, 60000);

boot();
