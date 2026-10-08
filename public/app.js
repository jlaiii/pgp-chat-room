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
    trash: 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z',
    pencil: 'M4 20h4L20 8l-4-4L4 16v4Zm2-3.2 9.6-9.6 1.6 1.6L7.6 18.4 6 18v-1.2Z',
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
    settings: { allowNewRooms: true, guestAccess: true, allowRegistration: true, motd: '' },
    claimable: false, ttlMs: 48 * 3600e3,
    lastAuthor: null, authMode: 'login', muted: false, saidBye: false,
    maxFileBytes: 0, lastReset: null,
    fx: {}, effects: [], adminPage: null, adminData: null, userFilter: '', activity: [], activityHasMore: false, eventFilter: '',
  };

  const RANK = { guest: 0, user: 1, mod: 2, admin: 3, developer: 4 };
  const rank = role => RANK[role] ?? -1;

  // Human labels for the effect pickers; the names themselves are the wire format.
  const FX_LABELS = {
    rainbow: 'Rainbow sweep', rgb: 'RGB flash', 'rgb-letters': 'RGB letters',
    jump: 'Jumping letters', wave: 'Wave', shake: 'Shake', pulse: 'Pulse', heartbeat: 'Heartbeat',
    glow: 'Glow', neon: 'Neon', flicker: 'Flicker', blink: 'Blink', fade: 'Fade through',
    float: 'Float', flip: 'Flip', spin: 'Spin', swing: 'Swing', bounce: 'Bounce',
    typewriter: 'Typewriter', glitch: 'Glitch', matrix: 'Matrix', gold: 'Gold', chrome: 'Chrome',
    ice: 'Ice', fire: 'Fire', aurora: 'Aurora', hologram: 'Hologram', sparkle: 'Sparkle',
    ghost: 'Ghost', warp: 'Warp',
  };
  const fxLabel = n => FX_LABELS[n] || String(n || '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

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

  // ---- display names ---------------------------------------------------------
  // A name renders as plain text unless its account carries a name effect. With an
  // effect on, every letter is its own element with its own index (`--i`) so the
  // effect can stagger letters; the effect itself is one CSS class, `.fx-<name>`.
  const fxOn = handle => state.fx[String(handle || '').toLowerCase()] || null;
  function nameEl(handle, cls) {
    const text = String(handle || '');
    const node = el('span', cls || null);
    node.dataset.name = text.toLowerCase();
    const fx = fxOn(text);
    if (!fx) { node.textContent = text; return node; }
    node.classList.add('fx', `fx-${fx}`);
    node.dataset.fx = fx;
    const n = Math.max(1, text.length);
    for (let i = 0; i < text.length; i++) {
      const ch = el('i', null, text[i]);
      ch.style.setProperty('--i', String(i));
      ch.style.setProperty('--n', String(n));
      node.append(ch);
    }
    return node;
  }

  // The per-identity colour stays the base for every name; the effect may override it.
  function paintName(node, color) {
    node.dataset.color = color;
    node.style.setProperty('--c', color);
    if (!node.classList.contains('fx')) node.style.color = color;
  }

  // Effects can change while a room is open: swap every node that shows that name.
  function rerenderNames(username) {
    const name = String(username || '').toLowerCase();
    for (const old of [...document.querySelectorAll(`[data-name="${name}"]`)]) {
      const keep = old.className.replace(/\bfx(?:-\S+)?\b/g, '').replace(/\s+/g, ' ').trim();
      const fresh = nameEl(name, keep || null);
      if (old.dataset.color) paintName(fresh, old.dataset.color);
      old.replaceWith(fresh);
    }
    renderPresence();
  }
  function relTime(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(t).toLocaleDateString();
  }
  const fmtWhen = t => new Date(t).toLocaleString();
  // Attachments and retention are policy the server publishes, so the client never
  // hardcodes a window or a size cap.
  const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const ttlFrom = hours => (hours == null ? null : hours * 3600000);
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
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
  function closeRail() {
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
      // Resolve BEFORE closing. Closing the sheet dispatches 'hidden', whose listener
      // resolves null — anything resolved afterwards is dropped, which silently turned
      // every confirmation in the app into a cancel.
      let settled = false;
      const finish = values => {
        if (settled) return;
        settled = true;
        resolve(values);
        closeSheets();
      };
      confirmBtn.onclick = () => {
        const out = {};
        for (const f of fields) out[f.name] = form.querySelector(`[name="${f.name}"]`).value;
        finish(out);
      };
      $('dialogCancel').onclick = () => finish(null);
      sheet.addEventListener('hidden', () => finish(null), { once: true });
    });
  }

  /* ---------------- auth ---------------- */

  function showAuth(mode) {
    state.authMode = mode || 'login';
    // A forced logout (frozen account, revoked session) must never leave a manage
    // page floating over the sign-in screen.
    if (state.adminPage) closePage();
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
    if (state.authMode === 'register' && state.settings.allowRegistration === false) {
      $('authNote').textContent = 'Signups are closed right now.';
    }
  }
  const showApp = () => { $('authScreen').hidden = true; $('appScreen').hidden = false; };

  async function loadMe() {
    const meResp = await api('/api/me');
    state.me = meResp.me;
    state.rooms = meResp.rooms;
    state.settings = meResp.settings;
    state.claimable = meResp.claimable;
    state.fx = meResp.fx || {};
    state.effects = meResp.effects || [];
    state.maxFileBytes = meResp.maxFileBytes || 0;
    state.ttlMs = ttlFrom(meResp.retentionHours);
    return meResp;
  }

  async function afterAuth() {
    await loadMe();
    showApp();
    setRetentionNote();
    renderMe();
    renderRooms();
    applySettings();
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
    state.fx = meResp.fx || {};
    state.effects = meResp.effects || [];
    state.maxFileBytes = meResp.maxFileBytes || 0;
    state.ttlMs = ttlFrom(meResp.retentionHours);
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
    applySettings();
    const wanted = Identity.pref('room') || 'lounge';
    const target = state.rooms.find(r => r.id === wanted) || state.rooms.find(r => r.id === 'lounge') || state.rooms[0];
    if (target) await enterRoom(target.id);
  }

  // Relay policy that every client should follow live: the notice board and whether
  // signups are open.
  function applySettings() {
    const s = state.settings || {};
    if (s.motd) banner(s.motd, 'info');
    refreshMsgActions();
    const closed = s.allowRegistration === false;
    for (const n of document.querySelectorAll('.auth-tab')) {
      if (n.dataset.mode !== 'register') continue;
      n.disabled = closed;
      n.classList.toggle('off', closed);
    }
    $('btnRegister').disabled = closed;
    $('regUser').disabled = closed;
    $('regPass').disabled = closed;
    if (closed && state.authMode === 'register') $('authNote').textContent = 'Signups are closed right now.';
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
      const r = await restoreAccountKey(creds.password);
      if (r.ok) toast(r.same ? 'This device already holds your account key' : 'Key unlocked on this device');
      else if (r.reason === 'unwrap-failed') toast('Wrong password for that key', 4200);
      else if (r.reason === 'no-envelope') toast('This account has no synced key any more');
      else toast(`Could not unlock: ${r.reason}`, 4200);
    } catch (e) {
      toast(`Could not unlock: ${e.message}`, 4200);
    }
  }

  /* ---------------- me / rooms ---------------- */

  const roleChipText = role => role === 'developer' ? 'Developer' : role === 'admin' ? 'Admin' : role === 'mod' ? 'Mod' : role === 'guest' ? 'Guest' : 'Member';

  function renderMe() {
    if (!state.me) return;
    const mh = $('meHandle');
    mh.innerHTML = '';
    mh.append(nameEl(state.me.handle, null));
    const chip = $('roleChip');
    chip.textContent = roleChipText(state.me.role);
    chip.dataset.role = state.me.role;
    $('meSwatch').style.background = state.id ? colorFor(state.id.fp) : 'var(--mut)';
    const rw = $('railWho');
    rw.innerHTML = '';
    rw.append(nameEl(state.me.kind === 'guest' ? state.me.handle : state.me.username, null));
    rw.append(document.createTextNode(state.me.kind === 'guest' ? ' — guest' : ` — ${roleChipText(state.me.role)}`));
    $('btnClaimSheet').hidden = !(state.claimable && state.me.kind === 'account');
    applyMenuVisibility();
    $('syncRow').hidden = state.me.kind !== 'account';
    $('syncToggle').checked = !!state.me.syncKey;
    // A name effect is per-account and mirrors the account record: the picker is
    // live for staff and for anyone the developer has unlocked; otherwise it stays
    // visible but locked, so nobody has to guess where the feature lives.
    $('fxWrap').hidden = state.me.kind !== 'account';
    if (state.me.kind === 'account') renderFxPicker();
    $('railRoleNote').textContent = state.me.kind === 'guest'
      ? 'Guests can post in public rooms. Create an account to make your own rooms.'
      : '';
  }

  // The self-serve effect picker: live for staff and for accounts the developer has
  // unlocked; visibly locked otherwise, so the feature is discoverable either way.
  function renderFxPicker() {
    const allowed = rank(state.me.role) >= RANK.admin || !!state.me.fxAllowed;
    const sel = $('fxSelect');
    sel.innerHTML = '';
    const none = el('option', null, 'None'); none.value = ''; sel.append(none);
    for (const name of state.effects) { const o = el('option', null, fxLabel(name)); o.value = name; sel.append(o); }
    sel.value = state.me.fx || '';
    sel.disabled = !allowed;
    $('fxHint').textContent = allowed
      ? 'Shown on your name for everyone in the room. Cosmetic only — nothing about your key or your messages changes.'
      : 'Locked — the developer can apply an effect to your name, or unlock this picker for you.';
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
    $('frozenBar').hidden = !(r.frozen || state.muted);
    $('frozenBar').textContent = state.muted
      ? 'You are muted in this room — you can read, but not post, until a moderator lifts it.'
      : 'This room is frozen — only moderators can post right now.';
    $('roomSheetBtn').hidden = !(r.canEdit || r.canApprove);
    updateComposerState();
  }

  function updateComposerState() {
    const input = $('input');
    const blocked = !state.canPost;
    input.disabled = blocked;
    $('sendBtn').disabled = blocked || !input.value.trim();
    input.placeholder = blocked
      ? (state.muted ? 'You are muted in this room' : state.frozen ? 'This room is frozen' : 'You cannot post in this room')
      : 'Message — encrypted on this device';
    // The attach button only exists where the relay says attachments are welcome —
    // both the site switch and the room switch have to be on.
    $('attachBtn').hidden = !state.canPost || !uploadsAllowed();
    if ($('attachBtn').hidden && pendingFile) setPending(null);
  }

  async function refreshPool() {
    const r = await api(`/api/rooms/${state.room.id}/pool`);
    state.pool = r.keys;
    state.ttlMs = ttlFrom(r.retentionHours);
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
    // An account's key is stuck to its account: the tag keeps it from ever being
    // claimed by a different account registering on this shared device later.
    if (state.me.kind === 'account') Identity.save({ owner: state.me.username });
    // The pool was fetched before this key joined it: keep the local copy honest, or
    // the first message sent this session would be sealed to everyone but its author.
    await addPoolKey({ fp: id.fp, handle, publicKey: id.armoredPublic, joinedAt: res.joinedAt || Date.now() });
    if (res.isNew) banner('You are in as ' + handle + '. Your key is new to this room, so messages sent before you joined stay sealed to older keys. Download a backup so you do not lose this device’s history.', 'info');
    return res;
  }

  /* ---------------- crypto ---------------- */

  async function encryptFor(text) {
    const recipients = state.poolKeys.size ? [...state.poolKeys.values()] : [state.id.publicKeyObj];
    // Always address the author too, whatever the pool looks like locally: nobody
    // should have to treat their own message as "sealed to an older key".
    if (!state.poolKeys.has(state.id.fp)) recipients.push(state.id.publicKeyObj);
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
    // Live frames and history rows carry no recipient list — the relay only needs it to
    // route, and shipping it would hand every member the fingerprint set of each message.
    // So: try to open it, and let a failure mean "sealed to a key that was never told
    // about you", which is exactly what that state is.
    if (Array.isArray(m.recipients) && !m.recipients.includes(state.id.fp)) return null;
    try {
      const message = await openpgp.readMessage({ armoredMessage: m.ct });
      const options = { message, decryptionKeys: state.id.privateKey, format: 'utf8' };
      const senderKey = state.poolKeys.get(m.fp);
      if (senderKey) options.verificationKeys = senderKey;
      const { data } = await openpgp.decrypt(options);
      return parsePayload(typeof data === 'string' ? data : String(data));
    } catch { return null; }
  }

  /* ---------------- attachments ---------------- */

  // A file is sealed here, in the browser, with a one-off AES-GCM key. Only the sealed
  // bytes go to the relay; the key travels inside the room's OpenPGP message, addressed
  // to the same recipients as the text. So the relay stores a blob it cannot open and
  // still cannot read a byte of it, and the filename never leaves this device.
  let pendingFile = null;

  const kindOf = file => {
    const t = String(file.type || '').toLowerCase();
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    return 'file';
  };
  const uploadsAllowed = () => {
    const s = state.settings || {};
    const r = currentRoom();
    return !!(r && r.allowFiles && (s.allowImages || s.allowVideo || s.allowFiles));
  };
  const allowedKinds = () => {
    const s = state.settings || {};
    return { image: !!s.allowImages, video: !!s.allowVideo, file: !!s.allowFiles };
  };

  function setPending(f) {
    pendingFile = f;
    const chip = $('attachChip');
    chip.innerHTML = '';
    chip.hidden = !f;
    if (!f) return;
    chip.append(el('span', 'chip', f.name), el('span', 'chip', fmtBytes(f.size)), el('span', 'chip', f.kind));
    const drop = el('button', 'btn sm', 'Remove');
    drop.onclick = () => setPending(null);
    chip.append(drop);
  }

  function pickFile() {
    const kinds = allowedKinds();
    const accept = [];
    if (kinds.image) accept.push('image/*');
    if (kinds.video) accept.push('video/*');
    if (kinds.file) accept.push('*/*');
    const input = $('attachInput');
    input.accept = accept.join(',') || '';
    input.click();
  }

  async function sealFile(file) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw);
    return { bytes: new Uint8Array(cipher), key: b64(await crypto.subtle.exportKey('raw', key)), iv: b64(iv) };
  }

  async function openFile(desc, cipherBuf) {
    const key = await crypto.subtle.importKey('raw', unb64(desc.key), { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(desc.iv) }, key, cipherBuf);
    return new Blob([plain], { type: desc.type || 'application/octet-stream' });
  }

  function attachmentEl(desc, roomId) {
    const wrap = el('div', 'attach');
    wrap.append(el('div', 'attach-note', `${desc.name || 'file'} · ${fmtBytes(desc.size || 0)}`));
    const slot = el('div');
    const open = el('button', 'btn sm', desc.kind === 'video' ? 'Load video' : desc.kind === 'image' ? 'Open picture' : 'Download file');
    let done = false;
    const load = async () => {
      if (done) return;
      open.disabled = true;
      open.textContent = 'Fetching…';
      try {
        const res = await fetch(`/api/rooms/${roomId}/files/${desc.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.status === 404 ? 'this attachment is gone — it followed the retention window' : `HTTP ${res.status}`);
        const blob = await openFile(desc, await res.arrayBuffer());
        const url = URL.createObjectURL(blob);
        const type = desc.type || blob.type || '';
        slot.innerHTML = '';
        if (type.startsWith('image/')) {
          const img = el('img', 'attach-media');
          img.src = url; img.alt = desc.name || 'picture'; img.loading = 'lazy';
          slot.append(img);
        } else if (type.startsWith('video/')) {
          const v = el('video', 'attach-media');
          v.controls = true; v.src = url; v.preload = 'metadata';
          slot.append(v);
        } else if (type.startsWith('audio/')) {
          const a = el('audio');
          a.controls = true; a.src = url; a.style.width = '100%';
          slot.append(a);
        } else {
          const a = el('a', 'btn sm', `Save ${desc.name || 'file'}`);
          a.href = url; a.download = desc.name || 'file';
          slot.append(a);
        }
        open.hidden = true;
        done = true;
      } catch (e) {
        open.disabled = false;
        open.textContent = 'Try again';
        wrap.append(el('div', 'attach-note', e.message));
      }
    };
    open.onclick = load;
    wrap.append(slot, open);
    // Pictures under a couple of megabytes are cheap: show them without a tap.
    if (desc.kind === 'image' && (desc.size || 0) <= 2 * 1048576) load();
    return wrap;
  }

  // A message payload is plain text, or JSON when it carries an attachment.
  function parsePayload(raw) {
    const s = String(raw);
    if (s.startsWith('{') && s.endsWith('}') && s.includes('"file"')) {
      try {
        const o = JSON.parse(s);
        if (o && o.file && o.file.id && o.file.key) return { text: typeof o.text === 'string' ? o.text : '', file: o.file };
      } catch { /* a message that merely looks like JSON */ }
    }
    return { text: s, file: null };
  }

  /* ---------------- rendering ---------------- */

  function timeEl(t) {
    const n = el('time', 'time', relTime(t));
    n.dateTime = new Date(t).toISOString();
    n.title = fmtWhen(t);
    return n;
  }

  // Who may touch one message. The author's own words are theirs while the site
  // switch is on; anyone with staff rank in this room may delete (that is moderation),
  // but never rewrite somebody else's message — the relay cannot re-sign a ciphertext.
  function staffHere() {
    const r = currentRoom() || {};
    return !!(r.canApprove || r.canDelete);
  }

  // One place that paints a bubble's body, so an edit can repaint it in place.
  function fillBody(body, dec, roomId, edited) {
    body.innerHTML = '';
    body.classList.remove('locked', 'gone');
    if (dec && (dec.text || dec.file)) {
      if (dec.text) body.append(el('div', 'text', dec.text));
      if (dec.file) body.append(attachmentEl(dec.file, roomId));
      if (!dec.text && !dec.file) body.append(el('div', 'text', ''));
    } else if (dec) {
      body.append(el('div', 'text', ''));
    } else {
      body.classList.add('locked');
      body.append(svg(ICON.lock, 'ic'), el('span', null, 'sealed to an older key'));
    }
    // The marker lives inside the bubble, not in the meta line: consecutive messages
    // from one author share a head, so a head is not always there to hang it on.
    if (edited && !body.classList.contains('locked')) body.append(el('span', 'edited', 'edited'));
  }

  function tombstone(node, by, author) {
    node.classList.add('deleted');
    node.classList.remove('acts-on');
    const acts = node.querySelector('.msg-acts');
    if (acts) acts.remove();
    const body = node.querySelector('.body');
    if (!body) return;
    body.innerHTML = '';
    body.classList.add('gone');
    body.append(svg(ICON.trash, 'ic'));
    body.append(el('span', null, by && by !== author ? `deleted by ${by}` : 'This message was deleted'));
  }

  function messageNode(m, dec, own, tmpId) {
    const wrap = el('div', 'msg' + (own ? ' own' : ''));
    if (tmpId) wrap.dataset.tmpId = tmpId;
    if (m.id) wrap.dataset.mid = m.id;
    if (m.fp) wrap.dataset.fp = m.fp;
    if (m.deleted) wrap.classList.add('deleted');
    // A tombstone needs its label, so it forces a head even inside a run of messages.
    if (state.lastAuthor !== m.fp || tmpId || m.deleted) {
      const head = el('div', 'meta');
      const who = nameEl(m.handle || m.fp.slice(0, 8), 'who');
      paintName(who, colorFor(m.fp));
      head.append(who, timeEl(m.t));
      wrap.append(head);
    }
    state.lastAuthor = m.fp;
    // The body has to be in the tree before the tombstone paints into it.
    const body = el('div', 'body');
    wrap.append(body);
    if (m.deleted) tombstone(wrap, m.deletedBy, m.handle);
    else fillBody(body, dec, m.room || (state.room && state.room.id), m.edited);
    const acts = el('div', 'msg-acts');
    if (own) {
      const b = el('button', 'act', 'Edit');
      b.type = 'button';
      b.dataset.act = 'edit';
      b.onclick = () => startEdit(wrap, m, dec);
      acts.append(b);
    }
    const del = el('button', 'act danger', 'Delete');
    del.type = 'button';
    del.dataset.act = 'delete';
    del.onclick = () => deleteMsg(m, wrap);
    acts.append(del);
    wrap.dataset.own = own ? '1' : '0';
    wrap.append(acts);
    refreshMsgActions(wrap);
    // Touch has no hover: a long press reveals the row, a tap anywhere else hides it.
    let hold = null;
    wrap.addEventListener('touchstart', () => { hold = setTimeout(() => wrap.classList.add('acts-on'), 420); }, { passive: true });
    for (const ev of ['touchend', 'touchmove', 'touchcancel']) {
      wrap.addEventListener(ev, () => { clearTimeout(hold); }, { passive: true });
    }
    return wrap;
  }

  // Policy and rank decide what is offered on each bubble, and both can change under an
  // open tab — so this runs whenever either does, instead of only at render time.
  function refreshMsgActions(scope) {
    const staff = staffHere();
    const canDel = state.settings.allowMsgDelete !== false;
    const canEdit = state.settings.allowMsgEdit !== false;
    const root = scope || document;
    const wraps = scope && scope.classList.contains('msg') ? [scope] : [...root.querySelectorAll('#msgs .msg[data-mid]')];
    for (const wrap of wraps) {
      if (wrap.classList.contains('deleted') || wrap.dataset.mid === undefined) continue;
      const own = wrap.dataset.own === '1';
      const acts = wrap.querySelector('.msg-acts');
      if (!acts) continue;
      const eb = acts.querySelector('[data-act="edit"]');
      const db = acts.querySelector('[data-act="delete"]');
      if (eb) eb.hidden = !(own && canEdit);
      if (db) db.hidden = !(own ? (canDel || staff) : staff);
      const any = [...acts.children].some(b => !b.hidden);
      acts.hidden = !any;
      if (!any) wrap.classList.remove('acts-on');
    }
  }

  function startEdit(wrap, m, dec) {
    const body = wrap.querySelector('.body');
    if (!body || body.dataset.editing) return;
    body.dataset.editing = '1';
    const back = body.innerHTML;
    body.innerHTML = '';
    const ta = el('textarea', 'input edit-box');
    ta.value = (dec && dec.text) || '';
    ta.rows = 2;
    const row = el('div', 'edit-row');
    const save = el('button', 'btn sm primary', 'Save');
    const cancel = el('button', 'btn sm', 'Cancel');
    const note = el('span', 'hint', '');
    row.append(save, cancel, note);
    body.append(ta, row);
    ta.focus();
    const abort = () => { body.innerHTML = back; delete body.dataset.editing; };
    cancel.onclick = abort;
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') abort(); });
    save.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { note.textContent = 'Nothing to save'; return; }
      const payload = dec && dec.file ? JSON.stringify({ text, file: dec.file }) : text;
      save.disabled = true;
      note.textContent = 'sealing…';
      try {
        const { ct, recipients } = await encryptFor(payload);
        await api(`/api/rooms/${state.room.id}/messages/${m.id}`, { method: 'POST', body: { ct, recipients } });
        const nd = await decryptFrom({ ct, fp: m.fp });
        m.edited = Date.now();
        delete body.dataset.editing;
        fillBody(body, nd, m.room || (state.room && state.room.id), true);
        toast('Message edited');
      } catch (e) {
        save.disabled = false;
        note.textContent = e.message;
      }
    };
  }

  async function deleteMsg(m, wrap) {
    const ok = await dialog({ title: 'Delete this message?', body: 'Its ciphertext is shredded on the relay right now. Everyone sees that something was there.', confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/api/rooms/${state.room.id}/messages/${m.id}`, { method: 'DELETE' });
      m.deleted = true;
      tombstone(wrap, state.me.handle, m.handle);
      toast('Message deleted');
    } catch (e) { toast(e.message, 4200); }
  }

  function renderMessage(m, dec, own, tmpId) {
    $('msgs').append(messageNode(m, dec, own, tmpId));
  }

  function addSys(text, t, notice) {
    const n = el('div', 'sys' + (notice ? ' notice' : ''));
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
    n.textContent = state.ttlMs == null
      ? 'Messages are kept until an admin clears them.'
      : `Messages delete themselves ${fmtWindow(state.ttlMs)} after sending — on this device and on the server.`;
  }

  function renderPresence() {
    const others = state.online.filter(o => o.fp !== (state.id && state.id.fp));
    $('onlineCount').textContent = `${state.online.length} online`;
    $('onlineCount').title = others.length ? `in this room: ${others.map(o => o.handle).join(', ')}` : '';
    const strip = $('presence');
    strip.innerHTML = '';
    if (!state.online.length) { strip.hidden = true; return; }
    strip.hidden = false;
    for (const o of state.online.slice(0, 24)) {
      const chip = el('span', 'pc');
      const sw = el('span', 'sw');
      sw.style.background = colorFor(o.fp);
      const nm = nameEl(o.handle, null);
      paintName(nm, colorFor(o.fp));
      chip.append(sw, nm);
      strip.append(chip);
    }
    if (state.online.length > 24) strip.append(el('span', 'pc', `+${state.online.length - 24} more`));
  }

  async function loadHistory() {
    const h = await api(`/api/rooms/${state.room.id}/history?fp=${state.id.fp}`);
    state.ttlMs = ttlFrom(h.retentionHours);
    setRetentionNote();
    renderLocked(h.lockedCount);
    for (const m of h.messages) {
      const dec = m.deleted ? null : await decryptFrom(m);
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
      if (ev.code === 1008) {
        // The kick frame already said why in the user's words ("your account was
        // deleted", "this room was closed"); the close reason is just the wire label.
        // Saying it twice, as a bare "removed" toast, reads like a second error.
        if (!state.saidBye) toast(ev.reason || 'disconnected', 4200);
        state.saidBye = false;
        // A kick either killed the session itself (frozen, signed out, deleted) or
        // just this seat in a room. Ask the relay which one before assuming.
        api('/api/me').then(() => { refreshRooms(); }).catch(e => {
          if (e.status === 401) showAuth('login');
          else refreshRooms();
        });
        return;
      }
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
      state.muted = !!m.muted;
      state.canPost = !!m.canPost;
      state.online = m.online || [];
      if (m.room) state.room = m.room;
      if (m.retentionHours !== undefined) { state.ttlMs = ttlFrom(m.retentionHours); setRetentionNote(); }
      setRoomBar();
      renderPresence();
      renderRooms();
      return;
    }
    if (m.t === 'msg') {
      const own = m.m.fp === state.id.fp && !!m.m.tmpId;
      if (own) {
        const node = document.querySelector(`[data-tmp-id="${m.m.tmpId}"]`);
        if (node) {
          // Replace the optimistic bubble with the real one: that is what puts an
          // attachment (and its key) into it once the relay has stored the blob.
          const dec = await decryptFrom(m.m);
          node.replaceWith(messageNode(m.m, dec, true));
          return;
        }
      }
      const dec = await decryptFrom(m.m);
      const sticky = atBottom();
      renderMessage(m.m, dec, m.m.fp === state.id.fp);
      scrollBottom(sticky);
      return;
    }
    if (m.t === 'msg-del') {
      const node = document.querySelector(`#msgs [data-mid="${m.id}"]`);
      if (node) tombstone(node, m.by, (node.querySelector('.who') || {}).textContent || null);
      return;
    }
    if (m.t === 'msg-edit') {
      const node = document.querySelector(`#msgs [data-mid="${m.id}"]`);
      if (!node) return;
      const dec = await decryptFrom({ ct: m.ct, fp: node.dataset.fp });
      const body = node.querySelector('.body');
      if (body && dec) fillBody(body, dec, state.room && state.room.id, true);
      return;
    }
    if (m.t === 'sys') { addSys(m.text, m.ts || Date.now(), m.notice); scrollBottom(); return; }
    if (m.t === 'presence') { state.online = m.online || []; renderPresence(); return; }
    if (m.t === 'fx') {
      if (m.fx) state.fx[m.username] = m.fx; else delete state.fx[m.username];
      // If it is about me, my own record moved too: keep the picker honest live.
      if (state.me && m.username === state.me.username) {
        state.me.fx = m.fx || null;
        if (typeof m.fxAllowed === 'boolean') state.me.fxAllowed = m.fxAllowed;
        renderMe();
      }
      rerenderNames(m.username);
      return;
    }
    if (m.t === 'settings') {
      state.settings = m.settings || state.settings;
      if (m.retentionHours !== undefined) { state.ttlMs = ttlFrom(m.retentionHours); setRetentionNote(); }
      applySettings();
      return;
    }
    if (m.t === 'evt') { onEvent(m.e); return; }
    if (m.t === 'key:add') { await addPoolKey(m.key); toast(`${m.key.handle} can now read new messages`); return; }
    if (m.t === 'room') {
      state.room = m.room;
      state.frozen = !!m.frozen;
      state.muted = !!m.muted;
      state.canPost = !!m.canPost;
      $('roomName').textContent = m.room.name;
      setRoomBar();
      renderRooms();
      refreshMsgActions();
      return;
    }
    if (m.t === 'err') { toast(m.msg, 3600); if (m.kind === 'info') refreshRooms(); return; }
    if (m.t === 'kick') {
      // Being moved out because the room itself was deleted needs no alarm: the client
      // lands in another room, and the banner would sit over it saying "room closed".
      if (m.reason !== 'room closed') banner(m.reason || 'removed', 'err');
      state.saidBye = true;   // the banner is the explanation; the close handler stays quiet
      refreshRooms();
      return;
    }
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
    const queued = pendingFile;
    if ((!text && !queued) || !state.canPost) return;
    input.value = '';
    autoGrow();
    updateComposerState();
    const tmpId = `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
    const wrap = el('div', 'msg own');
    wrap.dataset.tmpId = tmpId;
    const head = el('div', 'meta');
    const who = nameEl(state.me.handle, 'who');
    paintName(who, colorFor(state.id.fp));
    head.append(who, timeEl(Date.now()));
    const body = el('div', 'body');
    if (text) body.append(el('div', 'text', text));
    if (queued) {
      body.append(el('div', 'attach-note', `${queued.name} · ${fmtBytes(queued.size)} — sealing…`));
      setPending(null);
    }
    wrap.append(head, body);
    $('msgs').append(wrap);
    scrollBottom(true);
    try {
      let descriptor = null;
      if (queued) {
        const sealed = await sealFile(queued.file);
        const res = await fetch(`/api/rooms/${state.room.id}/files`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Kind': queued.kind },
          body: sealed.bytes,
        });
        const out = await res.json().catch(() => null);
        if (!res.ok) throw new Error((out && out.error) || `upload failed (${res.status})`);
        descriptor = {
          id: out.id, key: sealed.key, iv: sealed.iv,
          name: queued.name, type: queued.file.type || '', size: queued.size, kind: queued.kind,
        };
      }
      const payload = descriptor ? JSON.stringify({ text, file: descriptor }) : text;
      const { ct, recipients } = await encryptFor(payload);
      wsSend({ t: 'send', room: state.room.id, tmpId, ct, recipients });
    } catch (e) {
      wrap.remove();
      toast(`Could not send: ${e.message}`, 4200);
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

  /* ---------------- the account's key <-> this device ----------------
   * The key belongs to the account: it is made when the account is made (or claimed
   * from the device the account is made on), saved to the account as a password-
   * wrapped envelope, and restored onto every device that signs in. The relay only
   * ever holds that sealed envelope.
   */

  // Save this device's key to the account. Loud at registration (sync is part of the
  // promise made there), quiet as a self-heal at sign-in when the account holds none.
  // The failure is returned, not swallowed: "saved to your account" must not be a lie.
  async function syncKeyUp(password, { loud = false } = {}) {
    if (!password || !state.me || state.me.kind !== 'account') return { ok: false, reason: 'not-account' };
    if (state.me.syncKey) return { ok: true, already: true };
    if (state.me.syncOptOut) return { ok: false, reason: 'opted-out' };
    if ((state.settings || {}).keySyncDefault === false) return { ok: false, reason: 'site-off' };
    if (!state.id || !state.id.armoredPrivate) return { ok: false, reason: 'no-key' };
    try {
      const blob = await Identity.wrap(password, state.id.armoredPrivate);
      await api('/api/sync-key', { method: 'PUT', body: { enabled: true, blob } });
      Identity.save({ owner: state.me.username });
      await loadMe();
      renderMe();
      if (loud) toast('Key saved to your account — any device can unlock it with your password. Keep a backup file too.', 5600);
      return { ok: true };
    } catch (e) {
      // The account still works; the envelope is a second copy, not the only one.
      if (loud) toast('Your key could not be saved to your account — turn key sync on from Account settings to retry.', 7000);
      return { ok: false, reason: 'failed', error: e };
    }
  }

  // Sign-in: if the account holds an envelope, this device switches to the key inside
  // it — one account, one key, every device. The envelope is never overwritten, and a
  // local key is replaced only after the envelope opened with the password in hand.
  async function restoreAccountKey(password) {
    if (!state.me || state.me.kind !== 'account') return { ok: false, reason: 'not-account' };
    let syncKey;
    try { ({ syncKey } = await api('/api/sync-key')); } catch { return { ok: false, reason: 'fetch-failed' }; }
    if (!syncKey || !syncKey.enabled) return { ok: false, reason: 'no-envelope' };
    let armored;
    try { armored = await Identity.unwrap(password, syncKey.blob); }
    catch { return { ok: false, reason: 'unwrap-failed' }; }
    const fp = await Identity.fpOf(armored);
    const cur = Identity.raw();
    if (cur && cur.fp === fp) {
      Identity.save({ owner: state.me.username });
      return { ok: true, same: true };
    }
    state.id = await Identity.adoptPrivate(armored, state.me.username, state.me.username);
    return { ok: true, same: false };
  }

  // Registration: the key is made with the account. A device key that never belonged
  // to an account is claimed (continuity); one that belonged to a different account
  // must not follow this one. A key made for the account carries its name.
  async function ensureAccountKey(username) {
    const cur = Identity.raw();
    if (!cur || (cur.owner && cur.owner !== username)) {
      state.id = await Identity.create(username, username);
    } else {
      state.id = await Identity.ensure();
      Identity.save({ owner: username });
    }
    return state.id;
  }

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
        toast('Key sync is off — the envelope was deleted, and it stays off until you turn it back on.', 5200);
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
    if (state.adminPage) closePage();
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
    $('rsFilesHint').textContent = (state.settings.allowImages || state.settings.allowVideo || state.settings.allowFiles)
      ? 'Attachments are allowed site-wide; this switch is this room’s own gate. Files are sealed in the browser before upload.'
      : 'Attachments are switched off site-wide right now — an admin has to turn the site switch on first.';

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

  /* ---------------- manage pages (hamburger) ---------------- */

  // One page per job, reached from the menu. The minimum rank decides menu
  // visibility; the server enforces the same ladder on every call anyway.
  const ADMIN_PAGES = [
    ['dashboard', 'Dashboard', 'mod'],
    ['users', 'Users', 'mod'],
    ['activity', 'Activity', 'mod'],
    ['bans', 'Bans & mutes', 'mod'],
    ['rooms', 'Rooms', 'admin'],
    ['settings', 'Settings', 'admin'],
  ];
  const EVENT_FILTERS = [
    ['', 'Everything'],
    ['join,leave,evict', 'Presence'],
    ['register,guest,login,login-failed,password-change,sync-key,account-op,flair,fx', 'People'],
    ['room-create,room-update,room-delete,room-join,room-leave,member-op,room-purge,announce', 'Rooms'],
    ['ban,unban', 'Moderation'],
    ['settings,role,admin-claimed,lockdown', 'Admin'],
  ];

  function applyMenuVisibility() {
    const r = state.me ? rank(state.me.role) : -1;
    for (const b of document.querySelectorAll('[data-page]')) b.hidden = r < (RANK[b.dataset.min] ?? RANK.mod);
    const manage = $('railManage');
    if (manage) manage.hidden = r < RANK.mod;
  }

  function pageOpen(id) { return state.adminPage === id; }

  function openPage(id) {
    const page = ADMIN_PAGES.find(p => p[0] === id);
    if (!page) return;
    state.adminPage = id;
    $('pageTitle').textContent = page[1];
    $('pageView').hidden = false;
    renderPage().then(() => { $('pageBody').scrollTop = 0; });
  }

  function closePage() {
    state.adminPage = null;
    $('pageView').hidden = true;
  }

  async function renderPage() {
    if (!state.adminPage) return;
    const body = $('pageBody');
    body.innerHTML = '';
    let data;
    try { data = await api('/api/admin/overview'); } catch (e) { body.append(el('p', 'note', e.message)); return; }
    state.adminData = data;
    state.fx = data.fx || state.fx;
    if (state.adminPage === 'activity') return renderActivityTab(body, data);
    if (state.adminPage === 'users') return renderUsersTab(body, data);
    if (state.adminPage === 'rooms') return renderRoomsTab(body, data);
    if (state.adminPage === 'bans') return renderBansTab(body, data);
    if (state.adminPage === 'settings') return renderSettingsTab(body, data);
    return renderOverviewTab(body, data);
  }

  // ---- shared bits -----------------------------------------------------------

  function mkToggle(label, key, hint) {
    const settings = (state.adminData && state.adminData.settings) || state.settings;
    const row = el('label', 'toggle-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = settings[key] !== false;
    cb.onchange = async () => {
      try {
        const res = await api('/api/admin/settings', { method: 'PATCH', body: { [key]: cb.checked } });
        state.settings = res.settings;
        if (state.adminData) state.adminData.settings = res.settings;
        renderRooms();
        applySettings();
        toast(`${label}: ${cb.checked ? 'on' : 'off'}`);
      } catch (e) { cb.checked = !cb.checked; toast(e.message, 4200); }
    };
    const text = el('span', 'toggle-text');
    text.append(el('span', 'toggle-label', label), el('span', 'hint', hint));
    row.append(cb, text);
    return row;
  }

  function statCard(label, value) {
    const c = el('div', 'stat');
    c.append(el('span', 'stat-v', String(value)), el('span', 'stat-l', label));
    return c;
  }

  function sparkline(buckets) {
    const wrap = el('div', 'spark');
    const max = Math.max(1, ...buckets);
    for (const v of buckets) {
      const bar = el('span', 'spark-bar');
      bar.style.height = `${Math.max(4, Math.round((v / max) * 100))}%`;
      bar.title = `${v} events`;
      wrap.append(bar);
    }
    return wrap;
  }

  // Every event type the relay writes, in one line of plain English. No message
  // content can ever show up here: the relay has nothing readable to log.
  function fmtEvent(e) {
    const t = e.type;
    if (t === 'join') return { k: 'join', s: `${e.handle} joined ${e.room} · ${e.online} online` };
    if (t === 'leave') return { k: 'leave', s: `${e.handle} left ${e.room} · ${e.online} online` };
    if (t === 'evict') return { k: 'leave', s: `${e.handle} rotated out of ${e.room}` };
    if (t === 'key') return { k: 'key', s: `${e.handle} registered a key in ${e.room} (pool ${e.poolSize})` };
    if (t === 'register') return { k: 'acct', s: `${e.username} created an account${e.role === 'admin' ? ' — seated as admin' : ''}` };
    if (t === 'guest') return { k: 'acct', s: `${e.handle} entered as a guest` };
    if (t === 'login') return { k: 'auth', s: `${e.username} signed in` };
    if (t === 'login-failed') return { k: 'bad', s: `failed sign-in for “${e.username}”${e.reason === 'frozen' ? ' (account frozen)' : ''}` };
    if (t === 'password-change') return { k: 'auth', s: `${e.username} changed their password` };
    if (t === 'sync-key') return { k: 'key', s: `${e.username} turned key sync ${e.enabled ? 'on' : 'off'}` };
    if (t === 'ban') return { k: 'ban', s: `${e.by} banned ${e.target}${e.room ? ` from ${e.room}` : ' site-wide'} · ${e.hours ? `${e.hours}h` : 'permanent'}${e.reason ? ` · ${e.reason}` : ''}` };
    if (t === 'unban') return { k: 'ban', s: `${e.by || 'staff'} lifted a ban` };
    if (t === 'role') return { k: 'admin', s: `${e.by} made ${e.target} a ${e.role}` };
    if (t === 'settings') return { k: 'admin', s: `${e.by} changed the site settings` };
    if (t === 'admin-claimed') return { k: 'admin', s: `${e.username} took the admin seat` };
    if (t === 'lockdown') return { k: 'admin', s: `${e.by} turned lockdown ${e.on ? 'on' : 'off'}` };
    if (t === 'fx') return { k: 'me', s: `${e.username} ${e.fx ? `wears the ${fxLabel(e.fx)} name effect` : 'cleared their name effect'}${e.by && e.by !== e.username ? ` (by ${e.by})` : ''}${e.fxAllowed ? ' · can pick their own' : ''}` };
    if (t === 'flair') return { k: 'me', s: `${e.username} turned the rainbow name ${e.rainbow ? 'on' : 'off'}` };
    if (t === 'account-op') {
      if (e.op === 'signout') return { k: 'admin', s: `${e.by} signed ${e.target} out of every device` };
      if (e.op === 'delete') return { k: 'admin', s: `${e.by} deleted the account ${e.target}` };
      if (e.op === 'freeze') return { k: 'admin', s: `${e.by} ${e.frozen ? 'froze' : 'unfroze'} the account ${e.target}` };
      if (e.op === 'guest-purge') return { k: 'admin', s: `${e.by} cleared ${e.sessions} guest session${e.sessions === 1 ? '' : 's'}` };
      return { k: 'admin', s: `${e.by} ran ${e.op}` };
    }
    if (t === 'room-create') return { k: 'room', s: `${e.by} created the room “${e.name}”` };
    if (t === 'room-update') return { k: 'room', s: `${e.by} ${e.what} in ${e.room}` };
    if (t === 'room-delete') return { k: 'room', s: `${e.by} deleted the room “${e.name || e.room}”` };
    if (t === 'room-purge') return { k: 'room', s: `${e.by} cleared ${e.rows} stored row${e.rows === 1 ? '' : 's'} in ${e.room}` };
    if (t === 'room-join') return { k: 'room', s: `${e.who} ${e.pending ? 'asked to join' : 'joined'} ${e.room}` };
    if (t === 'room-leave') return { k: 'room', s: `${e.who} left ${e.room}` };
    if (t === 'member-op') return { k: 'room', s: `${e.by} ${e.op}ed ${e.target} in ${e.room}` };
    if (t === 'announce') return { k: 'admin', s: `${e.by} announced to ${e.room === 'all' ? 'every room' : e.room}: “${e.text}”` };
    return { k: 'other', s: t };
  }

  function eventRow(e, showIp) {
    const f = fmtEvent(e);
    const row = el('div', 'log-row');
    row.append(el('span', `badge ${f.k}`, f.k));
    const body = el('div', 'log-body');
    body.append(el('span', 'log-text', f.s));
    body.append(el('span', 'log-meta', `${relTime(e.t)}${showIp && e.ip ? ` · ${e.ip}` : ''}`));
    row.append(body);
    return row;
  }

  const matchesFilter = type => !state.eventFilter || state.eventFilter.split(',').includes(type);

  // Live tail: the relay pushes every event to staff sockets, so the log is never
  // stale and never polled.
  function onEvent(e) {
    if (!e || !e.type || !matchesFilter(e.type)) return;
    state.activity.unshift(e);
    if (state.activity.length > 400) state.activity.length = 400;
    if (pageOpen('activity') && $('eventList')) paintEvents();
  }

  function paintEvents() {
    const list = $('eventList');
    if (!list) return;
    const showIp = state.me && rank(state.me.role) >= RANK.admin;
    list.innerHTML = '';
    if (!state.activity.length) { list.append(el('p', 'note', 'Nothing logged for this filter yet.')); return; }
    for (const e of state.activity) list.append(eventRow(e, showIp));
    if (state.activityHasMore) list.append(el('p', 'hint', 'Older rows are in the download — the panel keeps the newest 250.'));
  }

  async function loadEvents() {
    const q = `?limit=250${state.eventFilter ? `&type=${encodeURIComponent(state.eventFilter)}` : ''}`;
    try {
      const res = await api(`/api/admin/events${q}`);
      state.activity = res.events || [];
      state.activityHasMore = !!res.hasMore;
    } catch (e) { state.activity = []; toast(e.message, 4200); }
  }

  async function refreshAdmin() {
    await refreshRooms();
    if (state.adminPage) await renderPage();
  }

  async function patchRoomAdmin(roomId, patch) {
    try { await api(`/api/rooms/${roomId}`, { method: 'PATCH', body: patch }); await refreshAdmin(); toast('Room updated'); }
    catch (e) { toast(e.message, 4200); }
  }

  // ---- tabs ------------------------------------------------------------------

  function renderOverviewTab(body, data) {
    const now = el('section', 'block');
    now.append(el('h3', null, 'Right now'));
    const onlineTotal = (data.online || []).reduce((n, r) => n + r.online.length, 0);
    const grid = el('div', 'stat-grid');
    grid.append(
      statCard('online', onlineTotal),
      statCard('keys', data.stats.keys),
      statCard('ciphertext rows', data.stats.messages),
      statCard('accounts', data.accounts.length),
      statCard('guest sessions', data.guestSessions),
      statCard('live sessions', data.sessions),
      statCard('bans', data.bans.length),
      statCard('rooms', data.rooms.length),
    );
    now.append(grid);
    if (data.lockdown) now.append(el('p', 'hint warn', 'Lockdown is on: every room is frozen, new rooms, signups and guests are stopped.'));
    body.append(now);

    const act = el('section', 'block');
    act.append(el('h3', null, `Activity — ${data.activity.total24h} events in the last 24h`));
    act.append(sparkline(data.activity.buckets));
    act.append(el('p', 'hint', 'Seven days, oldest on the left.'));
    const types = Object.entries(data.activity.byType24h || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (types.length) {
      const chips = el('div', 'chips');
      for (const [t, n] of types) chips.append(el('span', 'chip', `${t} ${n}`));
      act.append(chips);
    }
    body.append(act);

    const roomsBlock = el('section', 'block');
    roomsBlock.append(el('h3', null, `Rooms (${data.perRoom.length})`));
    for (const r of data.perRoom) {
      const row = el('div', 'row');
      row.append(el('span', 'row-name', `${r.name} · ${r.online} here · ${r.keys} keys · ${r.messages} rows`));
      if (r.frozen) row.append(el('span', 'room-tag frozen', 'frozen'));
      if (r.slowMs) row.append(el('span', 'room-tag', `slow ${Math.round(r.slowMs / 1000)}s`));
      roomsBlock.append(row);
    }
    body.append(roomsBlock);

    const here = el('section', 'block');
    here.append(el('h3', null, 'Online now'));
    const chips = el('div', 'chips');
    let any = false;
    for (const r of (data.online || [])) for (const h of r.online) { any = true; chips.append(nameEl(h)); }
    here.append(any ? chips : el('p', 'note', 'Nobody is sitting in a room right now.'));
    body.append(here);
  }

  async function renderActivityTab(body, data) {
    const head = el('section', 'block');
    head.append(el('h3', null, 'Activity log'));
    const filters = el('div', 'tabs');
    for (const [types, label] of EVENT_FILTERS) {
      const b = el('button', 'tab' + (state.eventFilter === types ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = async () => { state.eventFilter = types; await loadEvents(); await renderPage(); };
      filters.append(b);
    }
    head.append(filters);
    head.append(el('p', 'hint', 'Live — rows appear as they happen. Only metadata is ever logged: the relay cannot read a message, so there is nothing to log.'));
    const tools = el('div', 'row-actions');
    const reload = el('button', 'btn sm', 'Reload');
    reload.onclick = async () => { await loadEvents(); await renderPage(); };
    tools.append(reload);
    // The raw export is admin-only (server-enforced); mods read the live list.
    if (rank(state.me && state.me.role) >= RANK.admin) {
      const dl = el('button', 'btn sm', 'Download .jsonl');
      dl.onclick = () => { window.location.href = `/api/admin/events/export${state.eventFilter ? `?type=${encodeURIComponent(state.eventFilter)}` : ''}`; };
      tools.append(dl);
    }
    head.append(tools);
    body.append(head);

    const list = el('div', 'log-list');
    list.id = 'eventList';
    body.append(list);
    await loadEvents();
    paintEvents();
    const stats = el('section', 'block');
    stats.append(el('h3', null, 'Relay'));
    stats.append(el('p', 'note', `${data.stats.messages} ciphertext rows stored · ${data.stats.keys} keys · ${data.accounts.length} accounts · ${data.sessions} live sessions · retention ${fmtWindow(data.retentionHours * 3600000)}`));
    body.append(stats);
  }

  // The developer hands out name effects: apply one directly, or unlock the picker
  // so the account chooses its own. Both live in one dialog — one decision.
  async function openFxDialog(a) {
    const r = await dialog({
      title: `Name effect for ${a.username}`,
      body: 'Applied right away, for everyone in every room. Or unlock the picker and let them choose their own.',
      fields: [
        { name: 'fx', label: 'Effect', type: 'select', value: a.fx || '', options: [{ label: 'None', value: '' }, ...state.effects.map(n => ({ label: fxLabel(n), value: n }))] },
        { name: 'fxAllowed', label: 'Let them pick their own', type: 'select', value: a.fxAllowed ? 'yes' : 'no', options: [{ label: 'No', value: 'no' }, { label: 'Yes', value: 'yes' }] },
      ],
      confirm: 'Apply',
    });
    if (!r) return;
    try {
      await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'fx', fx: r.fx || null, fxAllowed: r.fxAllowed === 'yes' } });
      toast(`${a.username}: ${r.fx ? fxLabel(r.fx) : 'no effect'}${r.fxAllowed === 'yes' ? ' · picker unlocked' : ''}`);
      await renderPage();
    } catch (e) { toast(e.message, 4200); }
  }

  // The users dashboard: one card per account, straight actions. Rank decides
  // which buttons render; the server enforces the same lines on every call.
  function renderUsersTab(body, data) {
    const staff = rank(state.me && state.me.role) >= RANK.admin;
    const dev = rank(state.me && state.me.role) >= RANK.developer;
    const me = state.me || {};

    // A generated password is shown once, here, and never logged anywhere.
    if (state.lastReset) {
      const box = el('section', 'block');
      box.append(el('h3', null, `New password for ${state.lastReset.username}`));
      const field = el('input', 'input mono');
      field.value = state.lastReset.password;
      field.readOnly = true;
      field.onclick = () => field.select();
      box.append(field);
      box.append(el('p', 'hint', 'Hand it over, then ask them to change it. Their other sessions were dropped and their synced key envelope was cleared — it was wrapped with the old password.'));
      const done = el('button', 'btn sm', 'Done');
      done.onclick = () => { state.lastReset = null; renderPage(); };
      const act = el('div', 'row-actions');
      act.append(done);
      box.append(act);
      body.append(box);
    }

    const acct = el('section', 'block');
    acct.append(el('h3', null, `Accounts (${data.accounts.length})`));
    const search = el('input', 'input');
    search.type = 'search';
    search.placeholder = 'Find a user…';
    search.value = state.userFilter || '';
    search.autocapitalize = 'none';
    search.spellcheck = false;
    acct.append(search);
    const cards = el('div', 'acct-list');
    acct.append(cards);

    for (const a of data.accounts) {
      const card = el('div', 'acct-card');
      card.dataset.user = a.username;

      const top = el('div', 'acct-top');
      top.append(nameEl(a.username));
      const chip = el('span', 'role-chip', roleChipText(a.role));
      chip.dataset.role = a.role;
      top.append(chip);
      if (a.frozen) top.append(el('span', 'chip frozen-chip', 'frozen'));
      if (a.ban) top.append(el('span', 'ban-chip', a.ban.until ? `banned · ${fmtWhen(a.ban.until)}` : 'banned'));
      if (a.fx) top.append(el('span', 'chip', `fx · ${fxLabel(a.fx)}`));
      if (a.sessions) top.append(el('span', 'chip', `${a.sessions} session${a.sessions === 1 ? '' : 's'}`));
      card.append(top);
      card.append(el('p', 'acct-meta', `${a.lastLogin ? `seen ${relTime(a.lastLogin)}` : 'never signed in'}${a.keyFp ? ` · key ${a.keyFp.slice(0, 8)}` : ' · no key yet'}${a.syncKey ? ' · sync on' : ''}`));

      const actions = el('div', 'acct-acts');

      // Role — admin+, never your own seat; the developer seat is box-set only.
      if (staff && a.username !== me.username && a.role !== 'developer') {
        const sel = el('select', 'input sm');
        for (const [v, label] of [['user', 'Member'], ['mod', 'Mod'], ['admin', 'Admin']]) { const o = el('option', null, label); o.value = v; sel.append(o); }
        sel.value = a.role;
        sel.title = `Role for ${a.username}`;
        sel.onchange = async () => {
          try { await api('/api/admin/role', { method: 'POST', body: { username: a.username, role: sel.value } }); toast(`${a.username} is now ${roleChipText(sel.value)}`); await refreshAdmin(); }
          catch (e) { toast(e.message, 4200); await renderPage(); }
        };
        actions.append(sel);
      }

      // Freeze — locks the account door (sessions out, sign-in refused) without
      // touching messages, keys or rooms.
      if (staff && a.username !== me.username && a.role !== 'admin' && a.role !== 'developer') {
        const fr = el('button', 'btn sm', a.frozen ? 'Unfreeze' : 'Freeze');
        fr.onclick = async () => {
          if (a.frozen) {
            try { await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'freeze', frozen: false } }); toast(`${a.username} unfrozen — they can sign in again`); await renderPage(); }
            catch (e) { toast(e.message, 4200); }
          } else {
            const ok = await dialog({ title: `Freeze ${a.username}?`, body: 'They are signed out everywhere and cannot sign back in until you unfreeze. Messages, keys and rooms stay exactly as they are — this only locks the door.', confirm: 'Freeze' });
            if (!ok) return;
            try {
              const r = await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'freeze', frozen: true } });
              toast(`${a.username} frozen${r.sessions ? ` · ${r.sessions} session${r.sessions === 1 ? '' : 's'} dropped` : ''}`);
              await renderPage();
            } catch (e) { toast(e.message, 4200); }
          }
        };
        actions.append(fr);
      }

      // Moderation — mods and up, never against staff seats.
      if (a.username !== me.username && a.role !== 'admin' && a.role !== 'developer') {
        const mute = el('button', 'btn sm', 'Mute');
        mute.onclick = () => muteUser(a.username, null);
        actions.append(mute);
        if (a.ban) {
          const un = el('button', 'btn sm', 'Unban');
          un.onclick = () => unban({ kind: 'account', target: a.username, room: null });
          actions.append(un);
        } else {
          const bn = el('button', 'btn sm danger', 'Ban');
          bn.onclick = () => banUser(a.username, null);
          actions.append(bn);
        }
      }

      // Account tools — admin+, never against staff seats.
      if (staff && a.username !== me.username && a.role !== 'admin' && a.role !== 'developer') {
        const out = el('button', 'btn sm', 'Sign out');
        out.onclick = async () => {
          try { const r = await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'signout' } }); toast(`${a.username} signed out${r.sockets ? ` · ${r.sockets} socket dropped` : ''}`); await renderPage(); }
          catch (e) { toast(e.message, 4200); }
        };
        const pw = el('button', 'btn sm', 'Reset password');
        pw.onclick = async () => {
          const ok = await dialog({ title: `Reset ${a.username}'s password?`, body: 'A new password is generated and shown to you once. Their sessions are dropped and their synced key envelope is cleared.', confirm: 'Reset', danger: true });
          if (!ok) return;
          try {
            const r = await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'reset-password' } });
            state.lastReset = { username: a.username, password: r.password };
            await renderPage();
            toast(`New password ready for ${a.username}`);
          } catch (e) { toast(e.message, 4200); }
        };
        const del = el('button', 'btn sm danger', 'Delete');
        del.onclick = async () => {
          const ok = await dialog({ title: `Delete ${a.username}?`, body: 'The account is removed, their sessions are dropped and any room they owned passes to you. This cannot be undone.', confirm: 'Delete', danger: true });
          if (!ok) return;
          try { const r = await api('/api/admin/account', { method: 'POST', body: { username: a.username, op: 'delete' } }); toast(`${a.username} deleted${r.rooms.length ? ` · took over ${r.rooms.join(', ')}` : ''}`); await refreshAdmin(); }
          catch (e) { toast(e.message, 4200); }
        };
        actions.append(out, pw, del);
      }

      if (dev && a.username !== me.username) {
        const fb = el('button', 'btn sm', 'Effect…');
        fb.onclick = () => openFxDialog(a);
        actions.append(fb);
      }

      if (actions.children.length) card.append(actions);
      cards.append(card);
    }

    // The filter runs over the cards as you type — no refetch, so the field keeps focus.
    const applyFilter = () => {
      const q = (state.userFilter || '').toLowerCase();
      for (const c of cards.children) c.hidden = !!q && !c.dataset.user.includes(q);
    };
    search.oninput = () => { state.userFilter = search.value.trim(); applyFilter(); };
    applyFilter();

    body.append(acct);

    // Live sessions: admins only — mods get an empty list from the server.
    if (!staff) return;
    const sess = el('section', 'block');
    const list = data.sessionList || [];
    sess.append(el('h3', null, `Live sessions (${list.length})`));
    const dl = el('button', 'btn sm', 'Download accounts .jsonl');
    dl.onclick = () => { window.location.href = '/api/admin/accounts/export'; };
    const sessActions = el('div', 'row-actions');
    sessActions.append(dl);
    sess.append(sessActions);
    if (!list.length) sess.append(el('p', 'note', 'Nobody is signed in.'));
    for (const s of list.slice(0, 40)) {
      const row = el('div', 'row');
      row.append(el('span', 'row-name', `${s.username || s.handle || 'someone'} · ${s.role || s.kind}`));
      row.append(el('span', 'log-meta', `${s.kind}${s.ip ? ` · ${s.ip}` : ''} · seen ${relTime(s.lastSeen)}`));
      const kill = el('button', 'btn sm', 'Revoke');
      kill.onclick = async () => {
        try { const r = await api('/api/admin/sessions', { method: 'POST', body: { id: s.id } }); toast(`Session revoked${r.sockets ? ` · ${r.sockets} socket dropped` : ''}`); await renderPage(); }
        catch (e) { toast(e.message, 4200); }
      };
      row.append(kill);
      sess.append(row);
    }
    body.append(sess);
  }

  async function muteUser(username, roomId) {
    const r = await dialog({
      title: `Mute ${username}`,
      body: roomId ? `They keep reading “${roomId}” but cannot post there until the mute expires.` : 'They keep reading and keep their connection — they just cannot post anywhere until it expires.',
      fields: [
        { name: 'hours', label: 'How long', type: 'select', options: [
          { value: '0.25', label: '15 minutes' }, { value: '1', label: '1 hour' },
          { value: '6', label: '6 hours' }, { value: '24', label: '24 hours' }, { value: '168', label: '7 days' },
        ] },
        { name: 'reason', label: 'Reason (shown to them)', type: 'text', placeholder: 'optional' },
      ],
      confirm: 'Mute',
    });
    if (!r) return;
    try {
      const res = await api('/api/mod/ban', { method: 'POST', body: { target: username, kind: 'account', room: roomId || null, hours: Number(r.hours) || 1, reason: r.reason, mute: true } });
      toast(`${username} muted · ${res.kicked ? 'now' : 'until it expires'}`);
      await refreshAdmin();
    } catch (e) { toast(e.message, 4200); }
  }

  function renderRoomsTab(body, data) {
    for (const r of data.rooms) {
      const card = el('section', 'block');
      const head = el('h3', null, r.name);
      card.append(head);
      const meta = el('p', 'hint', `${r.builtin ? 'the public room' : r.private ? 'private' : 'public'} · ${r.memberCount} member${r.memberCount === 1 ? '' : 's'} · ${r.keys} keys · ${r.online} online${r.frozen ? ' · frozen' : ''}${r.allowFiles ? ' · files allowed' : ''}${r.owner ? ` · owned by ${r.owner}` : ''}`);
      card.append(meta);

      const aboutLabel = el('label', 'field');
      aboutLabel.append(el('span', 'field-label', 'About'));
      const about = el('input', 'input');
      about.value = r.about || '';
      about.placeholder = 'shown under the room name';
      aboutLabel.append(about);
      card.append(aboutLabel);

      const slowLabel = el('label', 'field');
      slowLabel.append(el('span', 'field-label', 'Slow mode'));
      const slow = el('select', 'input sm');
      for (const [v, l] of [['0', 'off'], ['5000', '5s between posts'], ['15000', '15s'], ['30000', '30s'], ['60000', '1 min'], ['300000', '5 min']]) { const o = el('option', null, l); o.value = v; slow.append(o); }
      slow.value = String(r.slowMs || 0);
      slowLabel.append(slow);
      slowLabel.append(el('span', 'hint', 'One identity cannot post faster than this. Mods and the room staff are exempt.'));
      card.append(slowLabel);

      const save = el('button', 'btn sm primary', 'Save room');
      save.onclick = () => patchRoomAdmin(r.id, { about: about.value, slowMs: Number(slow.value) });
      const freeze = el('button', 'btn sm', r.frozen ? 'Unfreeze' : 'Freeze');
      freeze.onclick = () => patchRoomAdmin(r.id, { frozen: !r.frozen });
      const guests = el('button', 'btn sm', r.guestOk ? 'Guests off' : 'Guests on');
      guests.onclick = () => patchRoomAdmin(r.id, { guestOk: !r.guestOk });
      const purge = el('button', 'btn sm', 'Clear history now');
      purge.onclick = async () => {
        const ok = await dialog({ title: `Clear ${r.name}?`, body: 'Every stored ciphertext row for this room is shredded immediately — disk and memory, no waiting for the retention window.', confirm: 'Clear now', danger: true });
        if (!ok) return;
        try { const res = await api('/api/admin/purge', { method: 'POST', body: { room: r.id } }); toast(`Cleared ${res.purgedRows} row${res.purgedRows === 1 ? '' : 's'}`); await renderPage(); }
        catch (e) { toast(e.message, 4200); }
      };
      const actions = el('div', 'row-actions');
      const files = el('button', 'btn sm', r.allowFiles ? 'Attachments off here' : 'Attachments on here');
      files.onclick = () => patchRoomAdmin(r.id, { allowFiles: !r.allowFiles });
      actions.append(save, freeze, guests, files, purge);
      const takeOver = el('button', 'btn sm', 'Give to me');
      takeOver.onclick = async () => {
        try { await api('/api/admin/room', { method: 'POST', body: { room: r.id, op: 'owner' } }); toast(`You own “${r.name}” now`); await refreshAdmin(); }
        catch (e) { toast(e.message, 4200); }
      };
      const kickAll = el('button', 'btn sm', 'Clear everyone out');
      kickAll.onclick = async () => {
        try { const res = await api('/api/admin/room', { method: 'POST', body: { room: r.id, op: 'kickall' } }); toast(`Cleared ${res.sockets} connection${res.sockets === 1 ? '' : 's'}`); }
        catch (e) { toast(e.message, 4200); }
      };
      actions.append(takeOver, kickAll);
      if (!r.builtin) {
        const priv = el('button', 'btn sm', r.private ? 'Make public' : 'Make private');
        priv.onclick = () => patchRoomAdmin(r.id, { private: !r.private });
        actions.append(priv);
      }
      if (r.canDelete) {
        const del = el('button', 'btn sm danger', 'Delete room');
        del.onclick = async () => {
          const ok = await dialog({ title: `Delete “${r.name}”?`, body: 'Its key pool and every ciphertext row in it are shredded for good.', confirm: 'Delete', danger: true });
          if (!ok) return;
          try {
            const wasCurrent = state.room && state.room.id === r.id;
            await api(`/api/rooms/${r.id}`, { method: 'DELETE' });
            toast('Room deleted');
            if (wasCurrent) { closeSheets(); await refreshRooms(); const next = state.rooms[0]; if (next) await enterRoom(next.id); }
            else await refreshAdmin();
          } catch (e) { toast(e.message, 4200); }
        };
        actions.append(del);
      }
      card.append(actions);
      body.append(card);
    }
  }

  function renderBansTab(body, data) {
    let muteBox = null;
    const mk = el('section', 'block');
    mk.append(el('h3', null, 'Place a ban'));
    const kindLabel = el('label', 'field');
    kindLabel.append(el('span', 'field-label', 'Against'));
    const kind = el('select', 'input sm');
    for (const [v, l] of [['account', 'an account'], ['fp', 'a device fingerprint']]) { const o = el('option', null, l); o.value = v; kind.append(o); }
    // Banning by address stays an admin tool.
    if (rank(state.me && state.me.role) >= RANK.admin) { const o = el('option', null, 'an IP address'); o.value = 'ip'; kind.append(o); }
    kindLabel.append(kind);
    mk.append(kindLabel);

    const targetLabel = el('label', 'field');
    targetLabel.append(el('span', 'field-label', 'Who'));
    const target = el('input', 'input');
    target.placeholder = 'username, or a 40-character fingerprint';
    targetLabel.append(target);
    mk.append(targetLabel);

    const scopeLabel = el('label', 'field');
    scopeLabel.append(el('span', 'field-label', 'Where'));
    const scope = el('select', 'input sm');
    const siteOpt = el('option', null, 'site-wide'); siteOpt.value = ''; scope.append(siteOpt);
    for (const r of data.rooms) { const o = el('option', null, `only in ${r.name}`); o.value = r.id; scope.append(o); }
    scopeLabel.append(scope);
    mk.append(scopeLabel);

    const hoursLabel = el('label', 'field');
    hoursLabel.append(el('span', 'field-label', 'How long'));
    const hours = el('select', 'input sm');
    for (const [v, l] of [['1', '1 hour'], ['24', '24 hours'], ['168', '7 days'], ['720', '30 days'], ['', 'permanent']]) { const o = el('option', null, l); o.value = v; hours.append(o); }
    hours.value = '24';
    hoursLabel.append(hours);
    mk.append(hoursLabel);

    const reasonLabel = el('label', 'field');
    reasonLabel.append(el('span', 'field-label', 'Reason (they are shown this)'));
    const reason = el('input', 'input');
    reason.placeholder = 'optional';
    reasonLabel.append(reason);
    mk.append(reasonLabel);

    const go = el('button', 'btn sm danger', 'Place ban');
    go.onclick = async () => {
      const payload = { kind: kind.value, target: target.value.trim().toLowerCase(), room: scope.value || null, hours: hours.value === '' ? null : Number(hours.value), reason: reason.value, mute: muteBox.checked };
      if (!payload.target) { toast('Who should I ban?'); return; }
      try {
        const res = await api('/api/mod/ban', { method: 'POST', body: payload });
        toast(payload.mute ? `Muted · ${payload.target}` : `Banned · ${res.kicked} connection${res.kicked === 1 ? '' : 's'} dropped`);
        target.value = '';
        reason.value = '';
        muteBox.checked = false;
        await refreshAdmin();
      } catch (e) { toast(e.message, 4200); }
    };
    const mkActions = el('div', 'row-actions');
    mkActions.append(go);
    mk.append(mkActions);
    const muteRow = el('label', 'toggle-row');
    muteBox = el('input');
    muteBox.type = 'checkbox';
    const muteText = el('span', 'toggle-text');
    muteText.append(el('span', 'toggle-label', 'Mute instead of ban'),
      el('span', 'hint', 'A timeout: they keep reading and keep their connection, they just cannot post until it expires.'));
    muteRow.append(muteBox, muteText);
    mk.append(muteRow);
    body.append(mk);

    const list = el('section', 'block');
    list.append(el('h3', null, `Active bans (${data.bans.length})`));
    if (rank(state.me && state.me.role) >= RANK.admin) {
      const clear = el('button', 'btn sm danger', 'Lift every ban');
      clear.onclick = async () => {
        const ok = await dialog({ title: 'Lift every ban?', body: 'Every ban and mute in the list goes away at once, site-wide and per room.', confirm: 'Lift all', danger: true });
        if (!ok) return;
        try { const res = await api('/api/admin/bans', { method: 'POST', body: {} }); toast(`Lifted ${res.removed} ban${res.removed === 1 ? '' : 's'}`); await refreshAdmin(); }
        catch (e) { toast(e.message, 4200); }
      };
      const head = el('div', 'row-actions');
      head.append(clear);
      list.append(head);
    }
    if (!data.bans.length) list.append(el('p', 'note', 'Nobody is banned or muted.'));
    for (const b of data.bans) {
      const row = el('div', 'row');
      const who = b.kind === 'account' ? b.target : b.kind === 'ip' ? `${b.target} (address)` : `${b.target.slice(0, 12)}… (device)`;
      row.append(el('span', 'row-name', who));
      if (b.mute) row.append(el('span', 'chip', 'muted'));
      row.append(el('span', 'log-meta', `${b.room ? `only in ${b.room}` : 'site-wide'} · ${b.until ? `until ${fmtWhen(b.until)}` : 'permanent'}${b.reason ? ` · ${b.reason}` : ''} · by ${b.by || 'system'}`));
      const un = el('button', 'btn sm', 'Lift');
      un.onclick = () => unban({ id: b.id });
      row.append(un);
      list.append(row);
    }
    body.append(list);
  }

  function renderSettingsTab(body, data) {
    const policy = el('section', 'block');
    policy.append(el('h3', null, 'Site policy'));
    policy.append(
      mkToggle('Allow new rooms', 'allowNewRooms', 'Admins can always create rooms.'),
      mkToggle('Allow guests', 'guestAccess', 'Anonymous visitors may enter rooms that welcome them.'),
      mkToggle('Allow signups', 'allowRegistration', 'Off = nobody new can create an account. The first account on an empty relay can still register.'),
      mkToggle('Pictures (images)', 'allowImages', 'Pictures can be attached at all. Every room has its own switch on top of this.'),
      mkToggle('Video', 'allowVideo', 'Video attachments, same two gates as pictures.'),
      mkToggle('Other files', 'allowFiles', 'Documents, archives, audio — anything that is not an image or video.'),
    );
    body.append(policy);

    // What people may do to a message they already sent. Deleting is moderation too,
    // so staff keep it either way; editing is always the author's own words only.
    const msgs = el('section', 'block');
    msgs.append(el('h3', null, 'Messages'));
    msgs.append(
      mkToggle('Let people delete their own messages', 'allowMsgDelete', 'Off = only staff can delete. A deleted message leaves a “deleted” mark where it was.'),
      mkToggle('Let people edit their own messages', 'allowMsgEdit', 'Off = sent messages are final for everyone. Nobody but the author can rewrite a message, ever.'),
    );
    body.append(msgs);

    // How long ciphertext (and the attachments that belong to it) lives. Shortening the
    // window deletes immediately; "keep" leaves it until somebody clears it by hand.
    const life = el('section', 'block');
    life.append(el('h3', null, 'Message lifetime'));
    life.append(el('p', 'hint', 'Applies to messages and attachments alike. Shortening it sweeps the relay at once.'));
    const lifeSel = el('select', 'input sm');
    const configLabel = `follow config.json (${fmtWindow((data.settings.configRetentionHours || 0) * 3600000)})`;
    for (const [v, l] of [
      ['config', configLabel], ['1', '1 hour'], ['6', '6 hours'], ['12', '12 hours'], ['24', '24 hours'],
      ['72', '3 days'], ['168', '7 days'], ['720', '30 days'], ['forever', 'keep until cleared by hand'],
    ]) { const o = el('option', null, l); o.value = v; lifeSel.append(o); }
    lifeSel.value = data.settings.keepForever ? 'forever' : (data.settings.retentionHours == null ? 'config' : String(data.settings.retentionHours));
    const lifeApply = el('button', 'btn sm primary', 'Apply lifetime');
    lifeApply.onclick = async () => {
      const payload = lifeSel.value === 'forever' ? { keepForever: true }
        : lifeSel.value === 'config' ? { retentionHours: null, keepForever: false }
        : { retentionHours: Number(lifeSel.value), keepForever: false };
      try {
        const res = await api('/api/admin/settings', { method: 'PATCH', body: payload });
        state.settings = res.settings;
        state.ttlMs = ttlFrom(res.retentionHours);
        setRetentionNote();
        toast(res.retentionHours == null ? 'Messages are now kept until cleared' : `Messages now delete after ${fmtWindow(res.retentionHours * 3600000)}`);
        await renderPage();
      } catch (e) { toast(e.message, 4200); }
    };
    life.append(lifeSel);
    const lifeActions = el('div', 'row-actions');
    lifeActions.append(lifeApply);
    life.append(lifeActions);
    body.append(life);

    const motd = el('section', 'block');
    motd.append(el('h3', null, 'Notice board'));
    const motdInput = el('input', 'input');
    motdInput.value = data.settings.motd || '';
    motdInput.maxLength = 300;
    motdInput.placeholder = 'Shown to everybody at the top of the app — rules, downtime, whatever';
    const motdSave = el('button', 'btn sm primary', 'Save notice');
    motdSave.onclick = async () => {
      try {
        const res = await api('/api/admin/settings', { method: 'PATCH', body: { motd: motdInput.value } });
        state.settings = res.settings;
        applySettings();
        toast(motdInput.value.trim() ? 'Notice saved' : 'Notice cleared');
      } catch (e) { toast(e.message, 4200); }
    };
    const motdClear = el('button', 'btn sm', 'Clear');
    motdClear.onclick = async () => {
      motdInput.value = '';
      try { const res = await api('/api/admin/settings', { method: 'PATCH', body: { motd: '' } }); state.settings = res.settings; applySettings(); toast('Notice cleared'); }
      catch (e) { toast(e.message, 4200); }
    };
    motd.append(motdInput);
    const motdActions = el('div', 'row-actions');
    motdActions.append(motdSave, motdClear);
    motd.append(motdActions);
    body.append(motd);

    const ann = el('section', 'block');
    ann.append(el('h3', null, 'Announce'));
    const annRoom = el('select', 'input sm');
    const allOpt = el('option', null, 'every room'); allOpt.value = 'all'; annRoom.append(allOpt);
    for (const r of data.rooms) { const o = el('option', null, r.name); o.value = r.id; annRoom.append(o); }
    const annText = el('input', 'input');
    annText.placeholder = 'Heads up — the box reboots in ten minutes';
    annText.maxLength = 300;
    const annGo = el('button', 'btn sm primary', 'Send notice');
    annGo.onclick = async () => {
      try {
        const res = await api('/api/admin/announce', { method: 'POST', body: { room: annRoom.value, text: annText.value } });
        toast(`Notice delivered to ${res.rooms} room${res.rooms === 1 ? '' : 's'} · ${res.delivered} reading`);
        annText.value = '';
      } catch (e) { toast(e.message, 4200); }
    };
    ann.append(annRoom, annText);
    const annActions = el('div', 'row-actions');
    annActions.append(annGo);
    ann.append(annActions);
    ann.append(el('p', 'hint', 'Pushed as a relay notice line in the room. It is not a message: it is never encrypted, never stored, and everyone sees it is from the relay.'));
    body.append(ann);

    const danger = el('section', 'block');
    danger.append(el('h3', null, 'Lockdown'));
    danger.append(el('p', 'hint', data.lockdown
      ? 'Lockdown is on: every room is frozen, new rooms, signups and guests are stopped.'
      : 'One switch: freeze every room, stop new rooms, close signups, stop guests. Use it when something is going wrong.'));
    const lock = el('button', 'btn sm danger', data.lockdown ? 'Lift lockdown' : 'Lock everything down');
    lock.onclick = async () => {
      try {
        const res = await api('/api/admin/lockdown', { method: 'POST', body: { on: !data.lockdown } });
        state.settings = res.settings;
        toast(`Lockdown ${res.lockdown ? 'on — every room frozen' : 'lifted'}`);
        await refreshAdmin();
      } catch (e) { toast(e.message, 4200); }
    };
    const guests = el('button', 'btn sm', `Clear guest sessions (${data.guestSessions})`);
    guests.onclick = async () => {
      try { const r = await api('/api/admin/guests', { method: 'POST', body: {} }); toast(`Cleared ${r.sessions} guest session${r.sessions === 1 ? '' : 's'}`); await renderPage(); }
      catch (e) { toast(e.message, 4200); }
    };
    const actions = el('div', 'row-actions');
    actions.append(lock, guests);
    danger.append(actions);
    body.append(danger);
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
      if (state.adminPage) renderPage();
      if (!$('roomSheet').hidden) renderRoomSheet();
    } catch (e) { toast(e.message, 4200); }
  }

  async function unban(payload) {
    try {
      const res = await api('/api/mod/unban', { method: 'POST', body: payload });
      toast(res.removed ? 'Ban lifted' : 'Nothing to lift');
      if (state.adminPage) renderPage();
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
        await loadMe();
        // The account's key first: it is what this device registers in the room, reads
        // history with and signs with. The password is still in hand from the sign-in.
        const restored = await restoreAccountKey(password).catch(() => ({ ok: false, reason: 'failed' }));
        if (restored.ok && !restored.same) toast('Your account key is now on this device', 4600);
        else if (!restored.ok && restored.reason === 'unwrap-failed') toast('The synced key did not unlock with that password — this device keeps its own key', 6000);
        await syncKeyUp(password);   // an account with no envelope gets this device's key saved to it
        await afterAuth();
      } catch (e) {
        $('authNote').textContent = e.body && (e.body.banned || e.body.frozen) ? e.message : 'Wrong username or password.';
        if (!$('appScreen').hidden) toast(`Sign-in failed: ${e.message}`, 5000);
      }
    };
    $('btnRegister').onclick = async () => {
      const username = $('regUser').value.trim().toLowerCase();
      const password = $('regPass').value;
      try {
        await api('/api/auth/register', { method: 'POST', body: { username, password } });
        $('regPass').value = '';
        await loadMe();
        // The way it is meant to be: the key is made when the account is made, saved
        // to the account while the password is in hand, and only then goes to a room.
        await ensureAccountKey(username);
        await syncKeyUp(password, { loud: true });
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
    $('btnAccountSheet').onclick = () => { closeSheets(); renderMe(); openSheet($('accountSheet')); };
    for (const b of document.querySelectorAll('[data-page]')) b.onclick = () => { closeRail(); openPage(b.dataset.page); };
    $('pageBack').onclick = closePage;
    $('btnClaimSheet').onclick = () => { closeSheets(); openSheet($('claimSheet')); };
    $('fxSelect').onchange = async () => {
      const fx = $('fxSelect').value || null;
      try {
        const res = await api('/api/me/fx', { method: 'POST', body: { fx } });
        state.me = res.me;
        state.fx = res.fx || {};
        rerenderNames(state.me.username);
        renderMe();
        toast(fx ? `Name effect: ${fxLabel(fx)}` : 'Name effect cleared');
      } catch (e) { renderMe(); toast(e.message, 4200); }
    };
    $('btnNewRoom').onclick = () => { closeSheets(); openSheet($('newRoomSheet')); };
    $('btnSignOut').onclick = signOut;
    $('roomSheetBtn').onclick = () => { renderRoomSheet(); openSheet($('roomSheet')); };
    $('scrim').onclick = closeSheets;
    for (const s of document.querySelectorAll('.sheet')) {
      const close = s.querySelector('.sheet-close');
      if (close) close.onclick = closeSheets;
    }

    $('attachInput').onchange = e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const kind = kindOf(f);
      const kinds = allowedKinds();
      if (!kinds[kind]) {
        toast(kind === 'image' ? 'Pictures are switched off right now' : kind === 'video' ? 'Video is switched off right now' : 'File sending is switched off right now', 4200);
        return;
      }
      if (state.maxFileBytes && f.size > state.maxFileBytes) {
        toast(`That file is ${fmtBytes(f.size)} — the cap is ${fmtBytes(state.maxFileBytes)}`, 4600);
        return;
      }
      setPending({ file: f, name: f.name, size: f.size, kind });
      $('input').focus();
    };
    $('attachBtn').onclick = pickFile;
    $('saveHandle').onclick = saveHandle;
    $('backupKey').onclick = () => Identity.backup(state.id);
    $('restoreKey').onchange = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const armored = await f.text();
        state.id = await Identity.adoptPrivate(armored, state.me.kind === 'guest' ? state.me.handle : state.me.username, state.me.kind === 'account' ? state.me.username : undefined);
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
        await loadMe();
        renderMe();
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
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('scrim').hidden) closeSheets();
      else if (state.adminPage) closePage();
    });
    // Tapping anywhere but the bubble puts a revealed action row away again.
    document.addEventListener('touchstart', e => {
      for (const n of document.querySelectorAll('#msgs .msg.acts-on')) {
        if (!n.contains(e.target)) n.classList.remove('acts-on');
      }
    }, { passive: true });
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
