/* PGP Room — client.
 *
 * All cryptography happens here, in the browser. The relay only ever sees
 * ciphertext plus the metadata it needs to route and moderate: who you signed in
 * as, which room you are in, and whether you are banned.
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const ICON = {
    lock: 'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 5a3 3 0 1 1 6 0v3H9V7Zm4 8.7V18a1 1 0 1 1-2 0v-2.3a2 2 0 1 1 2 0Z',
    send: 'M3 20.5 21 12 3 3.5v6.6l11 1.9-11 1.9z',
    x: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z',
    menu: 'M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
    shield: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 2.2 6 2.3V11c0 4-2.6 7.6-6 9-3.4-1.4-6-5-6-9V6.5l6-2.3Z',
    gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-1.2-8h2.4l.4 2.3 1.5.6 2-1.2 1.7 1.7-1.2 2 .6 1.5 2.3.4v2.4l-2.3.4-.6 1.5 1.2 2-1.7 1.7-2-1.2-1.5.6-.4 2.3h-2.4l-.4-2.3-1.5-.6-2 1.2L4.4 17l1.2-2-.6-1.5-2.3-.4v-2.4l2.3-.4.6-1.5-1.2-2 1.7-1.7 2 1.2 1.5-.6L10.8 2Z',
    key: 'M14 2a6 6 0 0 0-5.7 7.9L2 16.2V22h5.8l1.5-1.5v-2h2v-2h2l1.3-1.3A6 6 0 1 0 14 2Zm2.5 4.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z',
    sliders: 'M3 6h10v2H3V6Zm14 0h4v2h-4V6ZM3 16h4v2H3v-2Zm8 0h10v2H11v-2ZM11 4h2v6h-2V4Zm-4 6h2v6h-2v-6Z',
    users: 'M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 1a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm8 1c-2.7 0-8 1.3-8 4v3h16v-3c0-2.7-5.3-4-8-4Zm-8 1c-2.2 0-6 .9-6 3v3h5v-3c0-1.1.5-2.2 1.3-3-.1 0-.2 0-.3 0Z',
  };
  const svg = (path, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.append(p);
    return s;
  };

  const state = {
    id: null, me: null, rooms: [], room: null, pool: [], poolKeys: new Map(),
    msgs: [], online: [], ws: null, wsRetry: 0, canPost: false, frozen: false,
    settings: { allowNewRooms: true, guestAccess: true }, claimable: false, ttlMs: 48 * 3600e3,
    lastAuthor: null, authMode: 'login',
  };

  const RANK = { guest: 0, user: 1, mod: 2, admin: 3 };
  const rank = role => RANK[role] ?? -1;

  /* ---------------- utilities ---------------- */

  function randomHandle() {
    const ADJ = ['quiet', 'swift', 'amber', 'lucid', 'brave', 'calm', 'clever', 'cosmic', 'crimson', 'eager', 'faded', 'gentle', 'hidden', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'noble', 'plain', 'prime', 'rapid', 'rustic', 'silent', 'solar', 'steady', 'tidal', 'tiny', 'vivid', 'wired', 'woven', 'zesty', 'bold', 'cobalt', 'dusty'];
    const ANIMALS = ['otter', 'falcon', 'lynx', 'heron', 'badger', 'beaver', 'cobra', 'condor', 'crane', 'dolphin', 'eagle', 'egret', 'ferret', 'finch', 'fox', 'gazelle', 'gecko', 'gibbon', 'hare', 'hawk', 'ibex', 'jackal', 'koala', 'lemur', 'marlin', 'mink', 'moose', 'moth', 'newt', 'ocelot', 'osprey', 'panda', 'quail', 'raven', 'salmon', 'sparrow', 'tapir', 'tern', 'viper', 'wolf'];
    const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    return `${ADJ[r(ADJ.length)]}-${ANIMALS[r(ANIMALS.length)]}-${10 + r(90)}`;
  }
  function hueFor(fp) { let h = 0; for (let i = 0; i < 6; i++) h = (h * 31 + parseInt(fp.slice(i * 2, i * 2 + 2), 16)) % 360; return h; }
  const colorFor = fp => `hsl(${hueFor(fp)} 62% 66%)`;
  const fpGroups = fp => (String(fp).match(/.{1,4}/g) || []).join(' ');
  function relTime(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(t).toLocaleDateString();
  }
  const fmtWhen = t => new Date(t).toLocaleString();
  function fmtWindow(ms) {
    const h = ms / 3600000;
    if (h < 1) return `${Math.round(ms / 60000)} minutes`;
    if (h === 1) return '1 hour';
    if (h < 48) return `${Math.round(h)} hours`;
    return `${Math.round(h / 24)} days`;
  }

  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function banner(text, kind = 'info', spinner = false) {
    const b = $('banner');
    b.hidden = false;
    b.dataset.kind = kind;
    $('bannerText').textContent = text;
    $('bannerSpin').hidden = !spinner;
    $('bannerClose').hidden = spinner;
  }
  const hideBanner = () => { $('banner').hidden = true; };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /* ---------------- sheets ---------------- */

  function openSheet(node) {
    closeSheets();
    node.hidden = false;
    $('scrim').hidden = false;
    node.dataset.open = '1';
  }
  function closeSheets() {
    for (const s of document.querySelectorAll('.sheet')) {
      if (!s.hidden) { s.hidden = true; s.dispatchEvent(new Event('hidden')); }
    }
    $('scrim').hidden = true;
    $('railPanel').hidden = true;
    $('railScrim').hidden = true;
  }

  function dialog({ title, body, fields = [], confirm = 'Confirm', danger = false }) {
    return new Promise(resolve => {
      const sheet = $('dialogSheet');
      $('dialogTitle').textContent = title;
      const bodyEl = $('dialogBody');
      bodyEl.textContent = body || '';
      bodyEl.hidden = !body;
      const form = $('dialogFields');
      form.innerHTML = '';
      for (const f of fields) {
        const row = el('label', 'field');
        row.append(el('span', 'field-label', f.label));
        let input;
        if (f.type === 'select') {
          input = el('select', 'input');
          for (const o of f.options) { const opt = el('option', null, o.label); opt.value = o.value; input.append(opt); }
        } else if (f.type === 'textarea') {
          input = el('textarea', 'input');
          input.rows = 2;
        } else {
          input = el('input', 'input');
          input.type = f.type || 'text';
        }
        input.name = f.name;
        if (f.value != null) input.value = f.value;
        if (f.placeholder) input.placeholder = f.placeholder;
        row.append(input);
        form.append(row);
      }
      const confirmBtn = $('dialogConfirm');
      confirmBtn.textContent = confirm;
      confirmBtn.className = danger ? 'btn danger' : 'btn primary';
      openSheet(sheet);
      const done = values => { closeSheets(); resolve(values); };
      confirmBtn.onclick = () => {
        const out = {};
        for (const f of fields) out[f.name] = form.querySelector(`[name="${f.name}"]`).value;
        done(out);
      };
      $('dialogCancel').onclick = () => done(null);
      sheet.addEventListener('hidden', () => resolve(null), { once: true });
    });
  }

  /* ---------------- auth ---------------- */

  function showAuth(mode) {
    state.authMode = mode || 'login';
    $('appScreen').hidden = true;
    $('authScreen').hidden = false;
    for (const b of document.querySelectorAll('.auth-tab')) b.classList.toggle('on', b.dataset.mode === state.authMode);
    $('paneLogin').hidden = state.authMode !== 'login';
    $('paneRegister').hidden = state.authMode !== 'register';
    $('paneGuest').hidden = state.authMode !== 'guest';
    $('authNote').textContent = '';
    if (!$('guestHandle').value) $('guestHandle').value = randomHandle();
    if (state.authMode === 'guest' && state.settings.guestAccess === false) {
      $('authNote').textContent = 'Guest access is off right now — sign in or create an account.';
    }
  }
  const showApp = () => { $('authScreen').hidden = true; $('appScreen').hidden = false; };

  async function loadMe() {
    const meResp = await api('/api/me');
    state.me = meResp.me;
    state.rooms = meResp.rooms;
    state.settings = meResp.settings;
    state.claimable = meResp.claimable;
    state.ttlMs = meResp.retentionHours * 3600000;
    return meResp;
  }

  async function afterAuth() {
    await loadMe();
    showApp();
    setRetentionNote();
    renderMe();
    renderRooms();
    const wanted = Identity.pref('room') || 'lounge';
    const target = state.rooms.find(r => r.id === wanted) || state.rooms.find(r => r.id === 'lounge') || state.rooms[0];
    if (target) await enterRoom(target.id);
  }

  async function boot() {
    $('appScreen').hidden = true;
    let meResp = null;
    try {
      meResp = await api('/api/me');
    } catch (e) {
      if (e.status === 401) { showAuth('login'); return; }
      banner('Could not reach the room. Reload to try again.', 'err');
      return;
    }
    state.me = meResp.me;
    state.settings = meResp.settings;
    state.claimable = meResp.claimable;
    state.ttlMs = meResp.retentionHours * 3600000;
    state.rooms = meResp.rooms;

    // A session with a synced key but nothing local: offer to unlock before this
    // device generates a key that is a stranger to its own history.
    if (!Identity.has() && state.me.syncKey) {
      showApp();
      await promptUnlock();
      if (!Identity.has()) state.id = await Identity.ensure();
    } else {
      state.id = await Identity.ensure();
    }
    showApp();
    setRetentionNote();
    renderMe();
    renderRooms();
    const wanted = Identity.pref('room') || 'lounge';
    const target = state.rooms.find(r => r.id === wanted) || state.rooms.find(r => r.id === 'lounge') || state.rooms[0];
    if (target) await enterRoom(target.id);
  }

  async function promptUnlock() {
    const creds = await dialog({
      title: 'Unlock your key',
      body: 'This account has a synced key. Enter your account password to unlock it here, or cancel to use a brand new key for this device only.',
      fields: [{ name: 'password', label: 'Account password', type: 'password' }],
      confirm: 'Unlock',
    });
    if (!creds || !creds.password) return;
    try {
      const { syncKey } = await api('/api/sync-key');
      if (!syncKey.enabled) return;
      const armored = await Identity.unwrap(creds.password, syncKey.blob);
      state.id = await Identity.adoptPrivate(armored, state.me.handle);
      toast('Key unlocked on this device');
    } catch (e) {
      toast(e.name === 'OperationError' ? 'Wrong password for that key' : `Could not unlock: ${e.message}`, 4200);
    }
  }

  /* ---------------- me / rooms ---------------- */

  const roleChipText = role => role === 'admin' ? 'Admin' : role === 'mod' ? 'Mod' : role === 'guest' ? 'Guest' : 'Member';

  function renderMe() {
    if (!state.me) return;
    $('meHandle').textContent = state.me.handle;
    const chip = $('roleChip');
    chip.textContent = roleChipText(state.me.role);
    chip.dataset.role = state.me.role;
    $('meSwatch').style.background = state.id ? colorFor(state.id.fp) : 'var(--mut)';
    $('railWho').textContent = state.me.kind === 'guest' ? `${state.me.handle} — guest` : `${state.me.username} — ${roleChipText(state.me.role)}`;
    $('btnAdminSheet').hidden = rank(state.me.role) < RANK.mod;
    $('btnClaimSheet').hidden = !(state.claimable && state.me.kind === 'account');
    $('syncRow').hidden = state.me.kind !== 'account';
    $('syncToggle').checked = !!state.me.syncKey;
    $('railRoleNote').textContent = state.me.kind === 'guest'
      ? 'Guests can post in public rooms. Create an account to make your own rooms.'
      : '';
  }

  function roomBadge(r) {
    if (r.frozen) return { text: 'Frozen', cls: 'frozen' };
    if (r.private) return { text: 'Private', cls: 'private' };
    if (r.guestOk) return { text: 'Public', cls: 'public' };
    return null;
  }

  function renderRooms() {
    const list = $('roomList');
    list.innerHTML = '';
    const allowed = state.settings.allowNewRooms !== false || rank(state.me.role) >= RANK.admin;
    const canCreate = rank(state.me.role) >= RANK.user && allowed;
    $('btnNewRoom').disabled = !canCreate;
    $('newRoomHint').hidden = allowed || rank(state.me.role) >= RANK.admin;
    for (const r of state.rooms) {
      const li = el('li', 'room-item' + (state.room && state.room.id === r.id ? ' on' : ''));
      const btn = el('button', 'room-btn');
      btn.type = 'button';
      btn.append(el('span', 'room-name', r.name));
      const b = roomBadge(r);
      if (b) btn.append(el('span', `room-tag ${b.cls}`, b.text));
      const meta = el('span', 'room-meta');
      meta.append(document.createTextNode(`${r.online || 0} online`));
      if (r.canApprove && r.pendingCount) meta.append(el('span', 'pending-pill', `${r.pendingCount} waiting`));
      btn.append(meta);
      btn.onclick = () => { closeSheets(); enterRoom(r.id); };
      li.append(btn);
      list.append(li);
    }
  }

  const currentRoom = () => state.rooms.find(r => r.id === (state.room && state.room.id)) || state.room;

  async function refreshRooms() {
    try { await loadMe(); } catch { /* keep what we have */ }
    renderRooms();
    renderMe();
    setRoomBar();
  }

  /* ---------------- entering a room ---------------- */

  async function enterRoom(roomId) {
    let joined;
    try {
      joined = await api(`/api/rooms/${roomId}/join`, { method: 'POST' });
    } catch (e) {
      if (e.body && e.body.banned) { banner(e.body.error, 'err'); return; }
      toast(e.message, 4000);
      return;
    }
    if (joined.pending) {
      // A private room the room has not let us into yet: show the wait, do not
      // try to read a pool the relay will refuse.
      state.room = joined.room;
      Identity.pref('room', roomId);
      $('msgs').innerHTML = '';
      $('roomName').textContent = joined.room.name;
      $('roomTag').textContent = 'private';
      renderLocked(0);
      state.canPost = false;
      state.online = [];
      renderPresence();
      renderRooms();
      setRoomBar();
      banner(`“${joined.room.name}” is private. Your request is waiting for a moderator.`, 'info');
      return;
    }
    state.room = joined.room;
    Identity.pref('room', roomId);
    state.msgs = [];
    state.lastAuthor = null;
    state.pool = [];
    state.poolKeys = new Map();
    state.online = [];
    $('msgs').innerHTML = '';
    $('lockDivider').hidden = true;
    $('roomName').textContent = state.room.name;
    $('roomTag').textContent = state.room.private ? 'private' : state.room.guestOk ? 'guests welcome' : 'end to end';
    renderRooms();
    setRoomBar();
    await refreshPool();
    await registerKey();
    await loadHistory();
    connect();
  }

  function setRoomBar() {
    const r = currentRoom();
    if (!r) return;
    $('frozenBar').hidden = !r.frozen;
    $('roomSheetBtn').hidden = !(r.canEdit || r.canApprove);
    updateComposerState();
  }

  function updateComposerState() {
    const input = $('input');
    const blocked = !state.canPost;
    input.disabled = blocked;
    $('sendBtn').disabled = blocked || !input.value.trim();
    input.placeholder = blocked ? (state.frozen ? 'This room is frozen' : 'You cannot post in this room') : 'Message — encrypted on this device';
  }

  async function refreshPool() {
    const r = await api(`/api/rooms/${state.room.id}/pool`);
    state.pool = r.keys;
    state.ttlMs = r.retentionHours * 3600000;
    state.poolKeys = new Map();
    for (const k of state.pool) {
      try { state.poolKeys.set(k.fp, await openpgp.readKey({ armoredKey: k.publicKey })); } catch { /* unusable key */ }
    }
    setRetentionNote();
  }
  async function addPoolKey(k) {
    if (state.pool.some(p => p.fp === k.fp)) return;
    state.pool.push({ fp: k.fp, handle: k.handle, publicKey: k.publicKey, joinedAt: k.joinedAt });
    try { state.poolKeys.set(k.fp, await openpgp.readKey({ armoredKey: k.publicKey })); } catch { /* unusable key */ }
  }

  async function registerKey() {
    const id = state.id || (state.id = await Identity.ensure());
    const handle = state.me.kind === 'guest' ? (state.me.handle || id.handle) : state.me.username;
    const res = await api(`/api/rooms/${state.room.id}/keys`, {
      method: 'POST',
      body: { room: state.room.id, fp: id.fp, keyId: id.keyId, handle, publicKey: id.armoredPublic },
    });
    if (res.isNew) banner('You are in as ' + handle + '. Your key is new to this room, so messages sent before you joined stay sealed to older keys. Download a backup so you do not lose this device’s history.', 'info');
    return res;
  }

  /* ---------------- crypto ---------------- */

  async function encryptFor(text) {
    const recipients = state.poolKeys.size ? [...state.poolKeys.values()] : [state.id.publicKeyObj];
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text }),
      encryptionKeys: recipients,
      signingKeys: state.id.privateKey,
      format: 'armored',
    });
    const fps = [...state.poolKeys.keys()];
    if (!fps.includes(state.id.fp)) fps.push(state.id.fp);
    return { ct, recipients: fps };
  }

  async function decryptFrom(m) {
    if (!m.recipients || !m.recipients.includes(state.id.fp)) return null;
    try {
      const message = await openpgp.readMessage({ armoredMessage: m.ct });
      const options = { message, decryptionKeys: state.id.privateKey, format: 'utf8' };
      const senderKey = state.poolKeys.get(m.fp);
      if (senderKey) options.verificationKeys = senderKey;
      const { data } = await openpgp.decrypt(options);
      return { text: typeof data === 'string' ? data : String(data) };
    } catch { return null; }
  }

  /* ---------------- rendering ---------------- */

  function timeEl(t) {
    const n = el('time', 'time', relTime(t));
    n.dateTime = new Date(t).toISOString();
    n.title = fmtWhen(t);
    return n;
  }

  function renderMessage(m, dec, own, tmpId) {
    const wrap = el('div', 'msg' + (own ? ' own' : ''));
    if (tmpId) wrap.dataset.tmpId = tmpId;
    if (state.lastAuthor !== m.fp || tmpId) {
      const head = el('div', 'meta');
      const who = el('span', 'who', m.handle || m.fp.slice(0, 8));
      who.style.color = colorFor(m.fp);
      head.append(who, timeEl(m.t));
      wrap.append(head);
    }
    state.lastAuthor = m.fp;
    const body = el('div', 'body');
    if (dec) body.textContent = dec.text;
    else {
      body.classList.add('locked');
      body.append(svg(ICON.lock, 'ic'), el('span', null, 'sealed to an older key'));
    }
    wrap.append(body);
    $('msgs').append(wrap);
  }

  function addSys(text, t) {
    const n = el('div', 'sys');
    n.append(el('span', null, text));
    if (t) n.append(timeEl(t));
    $('msgs').append(n);
    state.lastAuthor = null;
  }

  function renderLocked(n) {
    const d = $('lockDivider');
    d.hidden = !n;
    if (n) $('lockText').textContent = `${n} earlier ${n === 1 ? 'message is' : 'messages are'} sealed to keys from before you joined`;
  }

  function setRetentionNote() {
    const n = $('retentionNote');
    n.hidden = false;
    n.textContent = `Messages delete themselves ${fmtWindow(state.ttlMs)} after sending — on this device and on the server.`;
  }

  function renderPresence() {
    const others = state.online.filter(o => o.fp !== (state.id && state.id.fp));
    $('onlineCount').textContent = `${state.online.length} online`;
    $('onlineCount').title = others.length ? `in this room: ${others.map(o => o.handle).join(', ')}` : '';
  }

  async function loadHistory() {
    const h = await api(`/api/rooms/${state.room.id}/history?fp=${state.id.fp}`);
    state.ttlMs = h.retentionHours * 3600000;
    setRetentionNote();
    renderLocked(h.lockedCount);
    for (const m of h.messages) {
      const dec = await decryptFrom(m);
      renderMessage(m, dec, m.fp === state.id.fp);
    }
    scrollBottom(true);
  }

  const atBottom = () => { const l = $('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 140; };
  function scrollBottom(force) { const l = $('log'); if (force || atBottom()) l.scrollTop = l.scrollHeight; }

  /* ---------------- websocket ---------------- */

  function setConn(name) {
    $('connDot').className = `dot ${name}`;
    $('connDot').title = name === 'on' ? 'connected' : name === 'wait' ? 'connecting' : 'offline';
  }

  function connect() {
    if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
    setConn('wait');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      state.wsRetry = 0;
      ws.send(JSON.stringify({ t: 'hello', room: state.room.id, fp: state.id.fp, handle: state.me.kind === 'guest' ? state.me.handle : state.me.username }));
    };
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleFrame(m); };
    ws.onclose = ev => {
      setConn('off');
      if (ev.code === 1008) { toast(ev.reason || 'disconnected', 4200); refreshRooms(); return; }
      const wait = Math.min(15000, 1000 * 2 ** Math.min(state.wsRetry++, 4));
      setTimeout(() => { if (state.ws === ws) connect(); }, wait);
    };
    ws.onerror = () => { /* onclose handles it */ };
  }
  const wsSend = obj => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); };

  async function handleFrame(m) {
    if (m.t === 'welcome') {
      setConn('on');
      state.frozen = !!m.frozen;
      state.canPost = !!m.canPost;
      state.online = m.online || [];
      if (m.room) state.room = m.room;
      if (m.retentionHours) { state.ttlMs = m.retentionHours * 3600000; setRetentionNote(); }
      setRoomBar();
      renderPresence();
      renderRooms();
      return;
    }
    if (m.t === 'msg') {
      const own = m.m.fp === state.id.fp && !!m.m.tmpId;
      if (own) {
        const node = document.querySelector(`[data-tmp-id="${m.m.tmpId}"]`);
        if (node) { delete node.dataset.tmpId; return; }
      }
      const dec = await decryptFrom(m.m);
      const sticky = atBottom();
      renderMessage(m.m, dec, m.m.fp === state.id.fp);
      scrollBottom(sticky);
      return;
    }
    if (m.t === 'sys') { addSys(m.text, m.ts || Date.now()); scrollBottom(); return; }
    if (m.t === 'presence') { state.online = m.online || []; renderPresence(); return; }
    if (m.t === 'key:add') { await addPoolKey(m.key); toast(`${m.key.handle} can now read new messages`); return; }
    if (m.t === 'room') {
      state.room = m.room;
      state.frozen = !!m.frozen;
      state.canPost = !!m.canPost;
      $('roomName').textContent = m.room.name;
      setRoomBar();
      renderRooms();
      return;
    }
    if (m.t === 'err') { toast(m.msg, 3600); if (m.kind === 'info') refreshRooms(); return; }
    if (m.t === 'kick') { banner(m.reason || 'removed', 'err'); refreshRooms(); return; }
  }

  /* ---------------- composer ---------------- */

  function autoGrow() {
    const i = $('input');
    i.style.height = 'auto';
    i.style.height = `${Math.min(140, i.scrollHeight)}px`;
  }

  async function sendCurrent() {
    const input = $('input');
    const text = input.value.trim();
    if (!text || !state.canPost) return;
    input.value = '';
    autoGrow();
    updateComposerState();
    const tmpId = `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
    const wrap = el('div', 'msg own');
    wrap.dataset.tmpId = tmpId;
    const head = el('div', 'meta');
    const who = el('span', 'who', state.me.handle);
    who.style.color = colorFor(state.id.fp);
    head.append(who, timeEl(Date.now()));
    wrap.append(head, el('div', 'body', text));
    $('msgs').append(wrap);
    scrollBottom(true);
    try {
      const { ct, recipients } = await encryptFor(text);
      wsSend({ t: 'send', room: state.room.id, tmpId, ct, recipients });
    } catch (e) {
      wrap.remove();
      toast(`Could not encrypt: ${e.message}`, 4200);
    }
  }

  /* ---------------- key sheet ---------------- */

  async function openKeySheet() {
    const id = state.id || (state.id = await Identity.ensure());
    $('fpFull').textContent = fpGroups(id.fp);
    $('createdAt').textContent = fmtWhen(id.createdAt);
    $('algoTxt').textContent = 'Curve25519 (Ed25519 + X25519)';
    $('handleInput').value = state.me.kind === 'guest' ? state.me.handle : state.me.username;
    $('handleInput').disabled = state.me.kind !== 'guest';
    $('handleHint').textContent = state.me.kind === 'guest'
      ? 'Guests may pick any handle. Create an account to keep it.'
      : 'Your handle is your username — change it in account settings.';
    openSheet($('keySheet'));
  }

  async function saveHandle() {
    if (state.me.kind !== 'guest') return;
    const handle = $('handleInput').value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(handle)) { toast('Use 2-24 characters: a-z, 0-9 or -'); return; }
    try {
      await api('/api/guest', { method: 'POST', body: { handle, fp: state.id.fp } });
      await loadMe();
      await registerKey();
      renderMe();
      await loadHistory();
      toast('Handle saved');
    } catch (e) { toast(e.message, 4000); }
  }

  /* ---------------- account sheet ---------------- */

  async function changePassword() {
    const current = $('pwCurrent').value;
    const next = $('pwNext').value;
    if (!current || !next) { toast('Fill in both password fields'); return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, next } });
      $('pwCurrent').value = '';
      $('pwNext').value = '';
      toast('Password changed — other devices were signed out');
      if (state.me.syncKey) {
        const blob = await Identity.wrap(next, state.id.armoredPrivate);
        await api('/api/sync-key', { method: 'PUT', body: { enabled: true, blob } });
        toast('The synced key was re-wrapped with the new password');
      }
    } catch (e) { toast(e.message, 4200); }
  }

  async function toggleSyncKey(on) {
    if (!on) {
      try {
        await api('/api/sync-key', { method: 'DELETE' });
        await loadMe();
        renderMe();
        toast('Key sync is off — the stored envelope was deleted');
      } catch (e) { toast(e.message); }
      return;
    }
    const r = await dialog({
      title: 'Sync this key to your account',
      body: 'The private key is encrypted here, in this browser, with a key derived from your password (PBKDF2 250k rounds, AES-GCM). The server keeps that sealed envelope and cannot open it — but a weak password could be attacked offline, so keep a backup file as well.',
      fields: [{ name: 'password', label: 'Your account password', type: 'password' }],
      confirm: 'Encrypt and save',
    });
    if (!r || !r.password) { $('syncToggle').checked = false; return; }
    try {
      const blob = await Identity.wrap(r.password, state.id.armoredPrivate);
      await api('/api/sync-key', { method: 'PUT', body: { enabled: true, blob } });
      await loadMe();
      renderMe();
      toast('Key synced — a new device can unlock it with your password');
    } catch (e) { toast(e.message, 4200); }
  }

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => { });
    if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
    state.me = null;
    state.room = null;
    closeSheets();
    showAuth('login');
  }

  /* ---------------- room sheet ---------------- */

  function renderRoomSheet() {
    const r = currentRoom();
    if (!r) return;
    $('rsName').textContent = r.name;
    $('rsAbout').textContent = r.about || '';
    $('rsMeta').textContent = `${r.memberCount} member${r.memberCount === 1 ? '' : 's'} · ${r.keys || 0} keys · ${r.online || 0} online`;
    $('rsFrozen').checked = !!r.frozen;
    $('rsPrivate').checked = !!r.private;
    $('rsGuestOk').checked = !!r.guestOk;
    $('rsAllowFiles').checked = !!r.allowFiles;
    $('rsFrozen').disabled = !r.canEdit;
    $('rsPrivate').disabled = !r.canEdit || r.builtin;
    $('rsGuestOk').disabled = !r.canEdit;
    $('rsPrivateHint').hidden = !r.builtin;
    $('rsFilesHint').textContent = 'Pictures and files arrive in the next update; this switch is the permission they will read.';

    const pending = $('rsPending');
    pending.innerHTML = '';
    $('rsPendingWrap').hidden = !(r.canApprove && r.pendingCount);
    for (const u of (r.pending || [])) {
      const row = el('div', 'row');
      row.append(el('span', 'row-name', u));
      const ok = el('button', 'btn sm primary', 'Let in');
      ok.onclick = () => memberOp(r.id, u, 'approve');
      const no = el('button', 'btn sm', 'Deny');
      no.onclick = () => memberOp(r.id, u, 'deny');
      row.append(ok, no);
      pending.append(row);
    }

    const members = $('rsMembers');
    members.innerHTML = '';
    $('rsMembersWrap').hidden = !(r.members && r.members.length);
    for (const u of (r.members || [])) {
      const isMod = (r.mods || []).includes(u);
      const row = el('div', 'row');
      row.append(el('span', 'row-name', u + (u === r.owner ? ' · owner' : isMod ? ' · mod' : '')));
      if (r.canApprove && u !== r.owner) {
        const modBtn = el('button', 'btn sm', isMod ? 'Unmod' : 'Mod');
        modBtn.onclick = () => memberOp(r.id, u, isMod ? 'unmod' : 'mod');
        const banBtn = el('button', 'btn sm', 'Ban');
        banBtn.onclick = () => banUser(u, r.id);
        const kickBtn = el('button', 'btn sm', 'Remove');
        kickBtn.onclick = () => memberOp(r.id, u, 'kick');
        row.append(modBtn, banBtn, kickBtn);
      }
      members.append(row);
    }
    $('rsLeaveWrap').hidden = !!r.builtin;
    $('rsDeleteWrap').hidden = !r.canDelete;
    $('rsMembersHint').hidden = !!r.canApprove;
  }

  async function memberOp(roomId, username, op) {
    try {
      await api(`/api/rooms/${roomId}/members`, { method: 'POST', body: { username, op } });
      await refreshRooms();
      renderRoomSheet();
      toast(`${username}: ${op}`);
    } catch (e) { toast(e.message, 4200); }
  }

  async function patchRoom(patch) {
    const r = currentRoom();
    try {
      const res = await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: patch });
      state.room = res.room;
      await refreshRooms();
      renderRoomSheet();
      toast('Room updated');
    } catch (e) { toast(e.message, 4200); renderRoomSheet(); }
  }

  /* ---------------- admin sheet ---------------- */

  async function openAdminSheet() {
    openSheet($('adminSheet'));
    await renderAdmin();
  }

  async function renderAdmin() {
    const body = $('adminBody');
    body.innerHTML = '';
    let data;
    try { data = await api('/api/admin/overview'); } catch (e) { body.append(el('p', 'note', e.message)); return; }

    const policy = el('section', 'block');
    policy.append(el('h3', null, 'Site settings'));
    const mkToggle = (label, key, hintText) => {
      const row = el('label', 'toggle-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = data.settings[key] !== false;
      cb.onchange = async () => {
        try {
          const res = await api('/api/admin/settings', { method: 'PATCH', body: { [key]: cb.checked } });
          state.settings = res.settings;
          renderRooms();
          toast(`${label}: ${cb.checked ? 'on' : 'off'}`);
        } catch (e) { cb.checked = !cb.checked; toast(e.message); }
      };
      const wrap = el('span', 'toggle-text');
      wrap.append(el('span', 'toggle-label', label), el('span', 'hint', hintText));
      row.append(cb, wrap);
      return row;
    };
    policy.append(
      mkToggle('Allow new rooms', 'allowNewRooms', 'Admins can always create rooms.'),
      mkToggle('Allow guests', 'guestAccess', 'Guests may post in rooms that welcome them.'),
    );
    body.append(policy);

    const acct = el('section', 'block');
    acct.append(el('h3', null, `Accounts (${data.accounts.length})`));
    for (const a of data.accounts) {
      const row = el('div', 'row');
      const nameWrap = el('span', 'row-name');
      nameWrap.append(el('span', null, a.username));
      const chip = el('span', 'role-chip', roleChipText(a.role));
      chip.dataset.role = a.role;
      nameWrap.append(chip);
      if (a.ban) nameWrap.append(el('span', 'ban-chip', a.ban.until ? `banned · ${fmtWhen(a.ban.until)}` : 'banned'));
      row.append(nameWrap);
      const sel = el('select', 'input sm');
      for (const [v, label] of [['user', 'Member'], ['mod', 'Mod'], ['admin', 'Admin']]) { const o = el('option', null, label); o.value = v; sel.append(o); }
      sel.value = a.role;
      sel.onchange = async () => {
        try { await api('/api/admin/role', { method: 'POST', body: { username: a.username, role: sel.value } }); toast(`${a.username} is now ${sel.value}`); renderAdmin(); }
        catch (e) { toast(e.message, 4200); renderAdmin(); }
      };
      row.append(sel);
      if (a.ban) {
        const un = el('button', 'btn sm', 'Unban');
        un.onclick = () => unban({ kind: 'account', target: a.username, room: null });
        row.append(un);
      } else {
        const bn = el('button', 'btn sm', 'Ban');
        bn.onclick = () => banUser(a.username, null);
        row.append(bn);
      }
      acct.append(row);
    }
    body.append(acct);

    const roomsBlock = el('section', 'block');
    roomsBlock.append(el('h3', null, `Rooms (${data.rooms.length})`));
    for (const r of data.rooms) {
      const row = el('div', 'row');
      row.append(el('span', 'row-name', `${r.name} · ${r.members.length} in · ${r.keys} keys${r.frozen ? ' · frozen' : ''}${r.private ? ' · private' : ''}`));
      const freeze = el('button', 'btn sm', r.frozen ? 'Unfreeze' : 'Freeze');
      freeze.onclick = async () => {
        try { await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { frozen: !r.frozen } }); await refreshRooms(); renderAdmin(); toast(r.frozen ? 'Room unfrozen' : 'Room frozen'); }
        catch (e) { toast(e.message, 4200); }
      };
      const del = el('button', 'btn sm danger', 'Delete');
      del.onclick = async () => {
        const ok = await dialog({ title: `Delete “${r.name}”?`, body: 'Its key pool and every ciphertext row in it are shredded for good.', confirm: 'Delete', danger: true });
        if (!ok) return;
        try { await api(`/api/rooms/${r.id}`, { method: 'DELETE' }); await refreshRooms(); renderAdmin(); toast('Room deleted'); }
        catch (e) { toast(e.message, 4200); }
      };
      row.append(freeze, del);
      roomsBlock.append(row);
    }
    body.append(roomsBlock);

    const bans = el('section', 'block');
    bans.append(el('h3', null, `Active bans (${data.bans.length})`));
    if (!data.bans.length) bans.append(el('p', 'note', 'Nobody is banned.'));
    for (const b of data.bans) {
      const row = el('div', 'row');
      const who = b.kind === 'account' ? b.target : `${b.target.slice(0, 12)}… (device)`;
      row.append(el('span', 'row-name', `${who}${b.room ? ` · from ${b.room}` : ' · site-wide'} · ${b.until ? `until ${fmtWhen(b.until)}` : 'permanent'}${b.reason ? ` · ${b.reason}` : ''}`));
      const un = el('button', 'btn sm', 'Unban');
      un.onclick = () => unban({ id: b.id });
      row.append(un);
      bans.append(row);
    }
    body.append(bans);

    const stats = el('section', 'block');
    stats.append(el('h3', null, 'Relay'));
    stats.append(el('p', 'note', `${data.stats.messages} ciphertext rows stored · ${data.stats.keys} keys · ${data.accounts.length} accounts · ${data.sessions} live sessions · retention ${fmtWindow(data.retentionHours * 3600000)}`));
    body.append(stats);
  }

  async function banUser(username, roomId) {
    const r = await dialog({
      title: `Ban ${username}`,
      body: roomId ? `This ban applies to “${roomId}” only. Their connections to that room are dropped at once.` : 'Site-wide: their sessions are dropped and they cannot sign back in until you lift it.',
      fields: [
        { name: 'hours', label: 'How long', type: 'select', options: [
          { value: '1', label: '1 hour' }, { value: '24', label: '24 hours' },
          { value: '168', label: '7 days' }, { value: '720', label: '30 days' },
          { value: '', label: 'Permanent' },
        ] },
        { name: 'reason', label: 'Reason (shown to them)', type: 'text', placeholder: 'optional' },
      ],
      confirm: 'Ban',
    });
    if (!r) return;
    try {
      const res = await api('/api/mod/ban', { method: 'POST', body: { target: username, kind: 'account', room: roomId || null, hours: r.hours === '' ? null : Number(r.hours), reason: r.reason } });
      toast(`${username} banned${res.kicked ? ` · ${res.kicked} connection dropped` : ''}`);
      await refreshRooms();
      if (!$('adminSheet').hidden) renderAdmin();
      if (!$('roomSheet').hidden) renderRoomSheet();
    } catch (e) { toast(e.message, 4200); }
  }

  async function unban(payload) {
    try {
      const res = await api('/api/mod/unban', { method: 'POST', body: payload });
      toast(res.removed ? 'Ban lifted' : 'Nothing to lift');
      if (!$('adminSheet').hidden) renderAdmin();
    } catch (e) { toast(e.message, 4200); }
  }

  /* ---------------- new room ---------------- */

  async function createRoom() {
    const name = $('nrName').value.trim();
    if (name.length < 2) { toast('Give the room a name'); return; }
    try {
      const res = await api('/api/rooms', { method: 'POST', body: { name, about: $('nrAbout').value, private: $('nrPrivate').checked, guestOk: $('nrGuest').checked } });
      $('nrName').value = '';
      $('nrAbout').value = '';
      $('nrPrivate').checked = false;
      $('nrGuest').checked = false;
      closeSheets();
      await refreshRooms();
      await enterRoom(res.room.id);
      toast('Room created');
    } catch (e) { toast(e.message, 4200); }
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    for (const b of document.querySelectorAll('.auth-tab')) b.onclick = () => showAuth(b.dataset.mode);

    $('btnLogin').onclick = async () => {
      const username = $('loginUser').value.trim().toLowerCase();
      const password = $('loginPass').value;
      if (!username || !password) { $('authNote').textContent = 'Username and password, please.'; return; }
      try {
        await api('/api/auth/login', { method: 'POST', body: { username, password } });
        $('loginPass').value = '';
        $('authNote').textContent = '';
        await afterAuth();
      } catch (e) {
        $('authNote').textContent = e.body && e.body.banned ? e.message : 'Wrong username or password.';
        if (!$('appScreen').hidden) toast(`Sign-in failed: ${e.message}`, 5000);
      }
    };
    $('btnRegister').onclick = async () => {
      const username = $('regUser').value.trim().toLowerCase();
      const password = $('regPass').value;
      try {
        await api('/api/auth/register', { method: 'POST', body: { username, password } });
        $('regPass').value = '';
        await afterAuth();
        if (state.claimable) { toast('Account created. Claim the admin seat with your one-time code.', 5200); openSheet($('claimSheet')); }
      } catch (e) {
        $('authNote').textContent = e.message;
        if (!$('appScreen').hidden) toast(`Could not finish: ${e.message}`, 5000);
      }
    };
    $('btnGuest').onclick = async () => {
      const handle = $('guestHandle').value.trim().toLowerCase();
      try {
        await api('/api/guest', { method: 'POST', body: { handle, fp: Identity.has() ? Identity.raw().fp : undefined } });
        await afterAuth();
      } catch (e) {
        $('authNote').textContent = e.message;
        if (!$('appScreen').hidden) toast(`Could not enter: ${e.message}`, 5000);
      }
    };
    $('btnRegenHandle').onclick = () => { $('guestHandle').value = randomHandle(); };

    $('bannerClose').onclick = hideBanner;
    $('btnRail').onclick = () => { $('railPanel').hidden = false; $('railScrim').hidden = false; };
    $('railScrim').onclick = () => { $('railPanel').hidden = true; $('railScrim').hidden = true; };
    $('meBtn').onclick = openKeySheet;
    $('btnKeySheet').onclick = () => { closeSheets(); openKeySheet(); };
    $('btnAccountSheet').onclick = () => { closeSheets(); openSheet($('accountSheet')); };
    $('btnAdminSheet').onclick = () => { closeSheets(); openAdminSheet(); };
    $('btnClaimSheet').onclick = () => { closeSheets(); openSheet($('claimSheet')); };
    $('btnNewRoom').onclick = () => { closeSheets(); openSheet($('newRoomSheet')); };
    $('btnSignOut').onclick = signOut;
    $('roomSheetBtn').onclick = () => { renderRoomSheet(); openSheet($('roomSheet')); };
    $('scrim').onclick = closeSheets;
    for (const s of document.querySelectorAll('.sheet')) {
      const close = s.querySelector('.sheet-close');
      if (close) close.onclick = closeSheets;
    }

    $('saveHandle').onclick = saveHandle;
    $('backupKey').onclick = () => Identity.backup(state.id);
    $('restoreKey').onchange = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const armored = await f.text();
        state.id = await Identity.adoptPrivate(armored, state.me.kind === 'guest' ? state.me.handle : state.me.username);
        await registerKey();
        await loadHistory();
        await openKeySheet();
        toast('Key restored — older messages in this room may open now');
      } catch (err) { toast(`Could not read that backup: ${err.message}`, 4200); }
    };
    $('copyFp').onclick = async () => {
      try { await navigator.clipboard.writeText(state.id.fp); toast('Fingerprint copied'); }
      catch { toast('Copy failed — select the text instead'); }
    };
    $('syncToggle').onchange = e => toggleSyncKey(e.target.checked);
    $('btnChangePw').onclick = changePassword;

    $('rsFreeze').onclick = () => patchRoom({ frozen: !$('rsFrozen').checked });
    $('rsPrivacy').onclick = () => patchRoom({ private: !$('rsPrivate').checked });
    $('rsGuests').onclick = () => patchRoom({ guestOk: !$('rsGuestOk').checked });
    $('rsFiles').onclick = () => patchRoom({ allowFiles: !$('rsAllowFiles').checked });
    $('rsRename').onclick = async () => {
      const r = await dialog({ title: 'Rename room', fields: [{ name: 'name', label: 'Room name', value: (currentRoom() || {}).name || '' }], confirm: 'Save' });
      if (r && r.name) patchRoom({ name: r.name });
    };
    $('rsLeave').onclick = async () => {
      try { await api(`/api/rooms/${state.room.id}/leave`, { method: 'POST' }); closeSheets(); await refreshRooms(); toast('Left the room'); }
      catch (e) { toast(e.message, 4200); }
    };
    $('rsDelete').onclick = async () => {
      const ok = await dialog({ title: 'Delete this room?', body: 'Every key and ciphertext row in it is shredded for good.', confirm: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api(`/api/rooms/${state.room.id}`, { method: 'DELETE' });
        closeSheets();
        await refreshRooms();
        const next = state.rooms.find(r => r.id !== state.room.id) || state.rooms[0];
        if (next) await enterRoom(next.id);
        toast('Room deleted');
      } catch (e) { toast(e.message, 4200); }
    };

    $('btnCreateRoom').onclick = createRoom;
    $('claimBtn').onclick = async () => {
      const code = $('claimCode').value.trim();
      if (!code) return;
      try {
        await api('/api/auth/claim', { method: 'POST', body: { code } });
        $('claimCode').value = '';
        closeSheets();
        await refreshRooms();
        toast('You are the admin');
      } catch (e) { toast(e.message, 4200); }
    };

    const input = $('input');
    input.addEventListener('input', () => { autoGrow(); updateComposerState(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 700) { e.preventDefault(); sendCurrent(); }
    });
    $('sendBtn').onclick = sendCurrent;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
    window.addEventListener('online', () => { if (state.me && state.room) connect(); });
  }

  /* the client half of the retention window: drop expired bubbles locally too */
  setInterval(() => {
    const cutoff = Date.now() - state.ttlMs;
    for (const node of [...$('msgs').children]) {
      const t = node.querySelector('time');
      if (t && Date.parse(t.dateTime) < cutoff) node.remove();
    }
  }, 60000);

  wire();
  boot().catch(e => banner(`Startup problem: ${e.message}`, 'err'));
})();
