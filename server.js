#!/usr/bin/env node
'use strict';
/*
 * PGP Room — relay server.
 *
 * Design constraint, unchanged: this process stores and forwards ciphertext ONLY.
 * It has no OpenPGP library, no private keys and no decryption code path, so the
 * operator of this box cannot read anyone's messages.
 *
 * What it does know (added for rooms, roles and moderation): who signed in, which
 * room they may enter, and whether they are banned. That is metadata, and it is the
 * price of a moderated multi-room chat. Passwords are hashed with scrypt and are
 * never used to key message encryption; the optional "sync my key" blob is wrapped
 * in the browser with a password-derived key the server never learns.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const { FP_RE, HANDLE_RE, MSG_HEAD, now, parseCookies, serializeCookie, originAllowed, clampInt, uuid, randomHandle } = require('./lib/util');
const { Settings } = require('./lib/settings');
const { Auth, RANK } = require('./lib/auth');
const { EFFECTS } = require('./lib/effects');
const { Rooms, LOUNGE_ID } = require('./lib/rooms');
const { Chat } = require('./lib/chat');

const ROOT = __dirname;
const CONFIG_PATH = process.env.PGPCHAT_CONFIG || path.join(ROOT, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DATA = path.resolve(ROOT, CFG.dataDir || 'data');
const PUB = path.resolve(ROOT, CFG.publicDir || 'public');
const EVT_FILE = path.join(DATA, 'events.log');
const LEGACY_MSG_FILE = path.join(DATA, 'messages.jsonl');
const PUBLIC_URL = CFG.publicUrl || '';
const COOKIE = 'pgp_session';
const COOKIE_SECURE = /^https:/i.test(PUBLIC_URL);
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600;

const log = (...a) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg: a.join(' ') }));
const settings = new Settings(DATA, CFG);
const auth = new Auth(DATA, CFG.auth || {});
const rooms = new Rooms(DATA, settings);
const chat = new Chat(DATA, CFG);
const CLEANUP_MS = Math.max(1, Number(CFG.cleanupMinutes != null ? CFG.cleanupMinutes : 5)) * 60000;

/* ---------- live state (never persisted) ---------- */

const online = new Map();          // roomId -> Map(fp -> {handle, username, socks:Set<ws>})
const leaveTimers = new Map();     // `${roomId}|${fp}` -> timeout
const lastPost = new Map();        // `${roomId}|${fp}` -> ts, for per-room slow mode
const byIp = new Map();            // ip -> {msgs,keys,conns,auth,guest,api:[]}

function roomOnline(roomId) { if (!online.has(roomId)) online.set(roomId, new Map()); return online.get(roomId); }
function roomOnlineList(roomId) {
  return [...roomOnline(roomId).entries()].map(([fp, o]) => ({ fp, handle: o.handle, username: o.username || null }));
}
function liveFor(roomId) { return { online: roomOnline(roomId).size, keys: chat.poolSize(roomId) }; }

function event(type, extra) {
  const rec = { t: now(), type, ...extra };
  try { fs.appendFileSync(EVT_FILE, JSON.stringify(rec) + '\n'); }
  catch (e) { log('event-write-failed', e.message); }
  pushEvent(rec);
}

// Live tail for the admin log: staff sockets receive every event as it happens, so
// the website's log needs no polling. Admins see the IPs, mods do not; the bootstrap
// code is never included for anyone.
function pushEvent(rec) {
  if (!wss || SECRET_EVENTS.has(rec.type)) return;
  let adminPayload = null, modPayload = null;
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    const rank = RANK[c.__role] ?? -1;
    if (rank < RANK.mod) continue;
    if (rank >= RANK.admin) {
      if (!adminPayload) adminPayload = JSON.stringify({ t: 'evt', e: rec });
      try { c.send(adminPayload); } catch { /* ignore */ }
    } else {
      if (ADMIN_ONLY_EVENTS.has(rec.type)) continue;
      if (!modPayload) { const e = { ...rec }; delete e.ip; modPayload = JSON.stringify({ t: 'evt', e }); }
      try { c.send(modPayload); } catch { /* ignore */ }
    }
  }
}

function clientIp(req) {
  if (CFG.trustProxy) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function rateOk(ip, kind, limit) {
  const t = now();
  let b = byIp.get(ip);
  if (!b) { b = { msgs: [], keys: [], conns: [], auth: [], guest: [], api: [] }; byIp.set(ip, b); }
  if (!b[kind]) b[kind] = [];
  const arr = b[kind];
  while (arr.length && t - arr[0] > 60000) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(t);
  return true;
}
setInterval(() => {
  const t = now();
  for (const [ip, b] of byIp) {
    for (const k of Object.keys(b)) b[k] = b[k].filter(x => t - x < 60000);
    if (!Object.values(b).some(v => v.length)) byIp.delete(ip);
  }
}, 120000).unref();

/* ---------- identity resolution ---------- */

function sessionFrom(req) {
  const cookies = parseCookies(req.headers.cookie);
  let tok = cookies[COOKIE] || null;
  const az = req.headers.authorization;
  if (!tok && typeof az === 'string' && /^bearer /i.test(az)) tok = az.slice(7).trim();
  if (!tok) return null;
  const s = auth.resolve(auth.sessions.get(tok));
  if (!s) return null;
  s.token = tok;
  return s;
}
function actorOf(session) {
  if (!session) return null;
  return { kind: session.kind, username: session.username || null, handle: session.handle || null, role: session.role || 'user', fp: session.fp || null };
}
function meView(session) {
  const a = actorOf(session);
  if (!a) return null;
  return {
    kind: a.kind, username: a.username, handle: a.handle, role: a.role,
    keyFp: a.kind === 'account' ? (auth.get(a.username) || {}).keyFp || null : a.fp,
    syncKey: a.kind === 'account' ? !!(auth.get(a.username) || {}).syncKey : false,
    syncOptOut: a.kind === 'account' ? !!(auth.get(a.username) || {}).syncOptOut : false,
    fx: a.kind === 'account' ? (auth.get(a.username) || {}).fx || null : null,
    fxAllowed: a.kind === 'account' ? !!(auth.get(a.username) || {}).fxAllowed : false,
    createdAt: session.createdAt,
  };
}
function banFor(actor, roomId = null, opts = {}) {
  return auth.banFor({
    username: actor.kind === 'account' ? actor.username : null,
    fp: actor.fp || null, ip: opts.ip || null, room: roomId, forPost: !!opts.forPost,
  });
}
function setCookie(res, session) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, session.token, {
    maxAge: SESSION_COOKIE_MAX_AGE, secure: COOKIE_SECURE, sameSite: 'Lax', httpOnly: true,
  }));
}

/* ---------- HTTP plumbing ---------- */

const WS_ORIGIN = (() => {
  try {
    if (!PUBLIC_URL) return '';
    const u = new URL(PUBLIC_URL);
    return ` ${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  } catch { return ''; }
})();
const secHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; font-src 'self'; " +
    `connect-src 'self'${WS_ORIGIN}; base-uri 'none'; form-action 'none'; ` +
    "frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
};
function send(res, code, body, headers = {}) {
  const h = { ...secHeaders, ...headers };
  if (body && typeof body === 'object') {
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Cache-Control'] = 'no-store';
    body = JSON.stringify(body);
  }
  res.writeHead(code, h);
  res.end(body);
}
const fail = (res, code, error) => send(res, code, { error });
function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > 262144) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Attachments arrive as raw bytes (they are already ciphertext — there is nothing to
// parse). Over the cap we stop buffering but keep draining, so the client still gets a
// clean answer instead of a reset connection.
function readBinary(req, maxBytes) {
  return new Promise(resolve => {
    let n = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > maxBytes) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooBig
      ? { error: `that upload is over the ${Math.round(maxBytes / 1048576)} MB cap` }
      : (chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0))));
    req.on('error', () => resolve({ error: 'upload interrupted' }));
  });
}
const banMessage = ban => {
  const until = ban.until ? ` until ${new Date(ban.until).toISOString().slice(0, 16).replace('T', ' ')}Z` : ' permanently';
  const what = ban.mute ? 'muted' : 'banned';
  return `you are ${what}${ban.room ? ` in ${ban.room}` : ''}${until}${ban.reason ? ` — ${ban.reason}` : ''}`;
};

/* ---------- broadcast helpers ---------- */

function socketsIn(roomId, pred = null) {
  const out = [];
  for (const c of wss.clients) {
    if (!c.__room || c.__room !== roomId || c.readyState !== 1) continue;
    if (pred && !pred(c)) continue;
    out.push(c);
  }
  return out;
}
function broadcastRoom(roomId, obj, except = null) {
  const s = JSON.stringify(obj);
  for (const c of socketsIn(roomId, c => c !== except)) { try { c.send(s); } catch { /* ignore */ } }
}
function broadcastPresence(roomId) {
  broadcastRoom(roomId, { t: 'presence', room: roomId, online: roomOnlineList(roomId), count: roomOnline(roomId).size });
}
function broadcastRoomState(roomId, note = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (note) broadcastRoom(roomId, { t: 'sys', room: roomId, text: note, ts: now() });
  for (const c of socketsIn(roomId)) {
    const actor = actorFromSocket(c);
    const view = rooms.view(room, actor, liveFor(roomId));
    const muted = !!banFor(actor, roomId, { forPost: true, ip: c.__ip });
    try { c.send(JSON.stringify({ t: 'room', room: view, frozen: room.frozen, muted, canPost: rooms.can(actor, 'post', room) && !muted })); } catch { /* ignore */ }
  }
}
function actorFromSocket(ws) {
  return {
    kind: ws.__kind || 'guest', username: ws.__username || null, handle: ws.__handle || null,
    role: ws.__role || 'guest', fp: ws.__fp || null,
  };
}
function kickSockets(pred, reason) {
  let n = 0;
  for (const c of [...wss.clients]) {
    if (c.readyState !== 1 || !pred(c)) continue;
    try { c.send(JSON.stringify({ t: 'kick', reason })); } catch { /* ignore */ }
    // The close reason travels on the wire too, so keep it meaningful rather than a
    // constant "removed" that shows up in a client's logs and toasts.
    c.close(1008, String(reason || 'removed').slice(0, 100));
    n++;
  }
  return n;
}

/* ---------- audit log (the website's admin log) ---------- */

// Event types only an admin may read. Everything else in the log is staff-readable:
// moving presence out of Telegram is only useful if mods can see the same trail.
const ADMIN_ONLY_EVENTS = new Set(['settings', 'role', 'admin-claimed', 'admin-claim', 'lockdown', 'account-op', 'flair', 'fx', 'claim-failed']);
const SECRET_EVENTS = new Set(['admin-claim']);   // the bootstrap code never leaves the box

function tailEvents(bytes = 1024 * 1024) {
  let raw = '';
  try {
    const size = fs.statSync(EVT_FILE).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(EVT_FILE, 'r');
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);   // the window can cut a line in half
  } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.type && !SECRET_EVENTS.has(e.type)) out.push(e);
    } catch { /* torn or corrupt line */ }
  }
  return out;
}

function readEvents(params, isAdmin) {
  const limit = clampInt(params.get('limit'), 1, 500, 200);
  const before = Number(params.get('before')) || 0;
  const want = String(params.get('type') || '').split(',').map(s => s.trim()).filter(Boolean);
  let list = tailEvents();
  if (want.length) list = list.filter(e => want.includes(e.type));
  if (before) list = list.filter(e => e.t < before);
  if (!isAdmin) list = list.filter(e => !ADMIN_ONLY_EVENTS.has(e.type));
  list.sort((a, b) => b.t - a.t);
  const events = list.slice(0, limit).map(e => { const c = { ...e }; if (!isAdmin) delete c.ip; return c; });
  return { events, hasMore: list.length > limit, window: list.length, serverTime: now() };
}

function exportEvents(params) {
  const want = String(params.get('type') || '').split(',').map(s => s.trim()).filter(Boolean);
  let list = tailEvents(4 * 1024 * 1024);
  if (want.length) list = list.filter(e => want.includes(e.type));
  return list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '');
}

// Per-day event counts for the admin dashboard's sparkline, plus what happened in
// the last 24h broken down by kind.
function activitySeries(days = 7) {
  const list = tailEvents(2 * 1024 * 1024);
  const dayMs = 86400e3;
  const today = Math.floor(now() / dayMs);
  const buckets = new Array(days).fill(0);
  const byType24h = {};
  let total24h = 0;
  for (const e of list) {
    const idx = days - 1 - (today - Math.floor(e.t / dayMs));
    if (idx >= 0 && idx < days) buckets[idx] += 1;
    if (now() - e.t < dayMs) { byType24h[e.type] = (byType24h[e.type] || 0) + 1; total24h += 1; }
  }
  return { days, buckets, byType24h, total24h, scanned: list.length };
}

/* ---------- cosmetic name effects ---------- */

// A rendering hint only: it never touches keys, ciphertext or permissions. The
// payload carries fxAllowed so the target's own open tab can refresh its picker.
function applyFx(username, fx, fxAllowed) {
  for (const c of wss.clients) if (c.readyState === 1 && c.__username === username) c.__fx = fx || null;
  const payload = JSON.stringify({ t: 'fx', username, fx: fx || null, fxAllowed: !!fxAllowed });
  for (const c of wss.clients) if (c.readyState === 1) { try { c.send(payload); } catch { /* ignore */ } }
}

function broadcastSettings() {
  const payload = JSON.stringify({ t: 'settings', settings: settings.publicView(), retentionHours: chat.retentionHours });
  for (const c of wss.clients) if (c.readyState === 1) { try { c.send(payload); } catch { /* ignore */ } }
}

/* ---------- presence ---------- */

function joinPresence(ws, roomId, actor) {
  const key = `${roomId}|${actor.fp}`;
  const timer = leaveTimers.get(key);
  if (timer) { clearTimeout(timer); leaveTimers.delete(key); }
  const map = roomOnline(roomId);
  let o = map.get(actor.fp);
  const first = !o;
  if (!o) { o = { handle: actor.handle, username: actor.username, socks: new Set() }; map.set(actor.fp, o); }
  o.handle = actor.handle;
  o.username = actor.username;
  o.socks.add(ws);
  chat.markOnline(roomId, actor.fp, true);
  if (first) {
    broadcastRoom(roomId, { t: 'sys', room: roomId, text: `${actor.handle} joined`, ts: now() }, ws);
    event('join', { room: roomId, handle: actor.handle, username: actor.username, fp: (actor.fp || '').slice(0, 8), online: map.size });
    log('join', roomId, actor.handle, `online=${map.size}`);
  }
  broadcastPresence(roomId);
}
function leavePresence(ws) {
  const roomId = ws.__room;
  const fp = ws.__fp;
  if (!roomId || !fp) return;
  const map = roomOnline(roomId);
  const o = map.get(fp);
  if (!o) return;
  o.socks.delete(ws);
  if (o.socks.size) { broadcastPresence(roomId); return; }
  const key = `${roomId}|${fp}`;
  const timer = setTimeout(() => {
    leaveTimers.delete(key);
    const cur = roomOnline(roomId).get(fp);
    if (cur && cur.socks.size === 0) {
      roomOnline(roomId).delete(fp);
      chat.markOnline(roomId, fp, false);
      broadcastRoom(roomId, { t: 'sys', room: roomId, text: `${cur.handle} left`, ts: now() });
      broadcastPresence(roomId);
      event('leave', { room: roomId, handle: cur.handle, fp: fp.slice(0, 8), online: roomOnline(roomId).size });
    }
  }, 8000);
  if (timer.unref) timer.unref();
  leaveTimers.set(key, timer);
}

/* ---------- HTTP ---------- */

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/identity.js': ['identity.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/style.css': ['style.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/vendor/openpgp.min.js': ['vendor/openpgp.min.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
};

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;
  const ip = clientIp(req);

  /* ---- static ---- */
  if ((method === 'GET' || method === 'HEAD') && STATIC[p]) {
    const [rel, ctype, cc] = STATIC[p];
    const file = path.join(PUB, rel);
    if (!file.startsWith(PUB)) return fail(res, 403, 'forbidden');
    if (!fs.existsSync(file)) return fail(res, 404, 'not found');
    if (method === 'HEAD') { res.writeHead(200, { ...secHeaders, 'Content-Type': ctype, 'Cache-Control': cc }); return res.end(); }
    res.writeHead(200, { ...secHeaders, 'Content-Type': ctype, 'Cache-Control': cc, 'Content-Length': fs.statSync(file).size });
    return res.end(fs.readFileSync(file));
  }
  if (method === 'GET' && p === '/robots.txt') {
    return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
  }
  if (method === 'GET' && p === '/healthz') {
    const s = chat.stats();
    const files = rooms.all().reduce((acc, r) => {
      const f = chat.fileStats(r.id);
      acc.count += f.count; acc.bytes += f.bytes;
      return acc;
    }, { count: 0, bytes: 0 });
    return send(res, 200, {
      ok: true, rooms: rooms.all().length, messages: s.messages, keys: s.keys, online: wss ? wss.clients.size : 0,
      accounts: auth.count(), sessions: auth.sessionCount(), bans: auth.activeBans().length,
      files: files.count, fileBytes: files.bytes,
      uptime: Math.round(process.uptime()), retentionHours: chat.retentionHours,
      adminClaimable: !auth.hasAdmin(),
    });
  }

  /* ---- auth ---- */
  if (p.startsWith('/api/')) {
    const needOrigin = method !== 'GET' && method !== 'HEAD';
    if (needOrigin && !originAllowed(req)) return fail(res, 403, 'bad origin');
    if (!rateOk(ip, 'api', 240)) return fail(res, 429, 'slow down');

    // -- register --
    if (method === 'POST' && p === '/api/auth/register') {
      if (!rateOk(ip, 'auth', (CFG.rate && CFG.rate.authPerMin) || 10)) return fail(res, 429, 'slow down');
      // "Signups closed" binds everyone except the very first account on an empty
      // relay — an operator who closes the door before signing up must still get in.
      if (settings.data.allowRegistration === false && auth.count() > 0) return fail(res, 403, 'signups are closed right now');
      const b = await readJson(req);
      // Bootstrap: the first account on a relay that has no accounts at all seats the
      // admin, so a fresh install has an operator in one step. Every later account is a
      // plain `user` — after the first signup the seat is only claimed (one-shot code)
      // or granted (admin panel), never assumed.
      const firstAccount = auth.count() === 0;
      const r = auth.createAccount(b.username, b.password, firstAccount ? 'admin' : 'user');
      if (r.error) return fail(res, 400, r.error);
      if (firstAccount) settings.clearClaimCode();   // the seat is taken: drop the fallback code
      const session = auth.createSession({ kind: 'account', username: r.account.username, handle: r.account.username, role: r.account.role, ip });
      setCookie(res, session);
      event('register', { username: r.account.username, ip, role: r.account.role });
      log('register', r.account.username, `role=${r.account.role}`);
      if (firstAccount) { event('admin-claimed', { username: r.account.username, ip, first: true }); log('admin-seated', r.account.username); }
      return send(res, 201, { ok: true, me: meView(session), claimable: !auth.hasAdmin() });
    }

    // -- login --
    if (method === 'POST' && p === '/api/auth/login') {
      if (!rateOk(ip, 'auth', (CFG.rate && CFG.rate.authPerMin) || 10)) return fail(res, 429, 'slow down');
      const b = await readJson(req);
      const rec = auth.verify(b.username, b.password);
      if (!rec) { event('login-failed', { username: String(b.username || '').slice(0, 24), ip }); return fail(res, 401, 'wrong username or password'); }
      // A frozen account is locked out at the door: no session, no rooms.
      if (rec.frozen) { event('login-failed', { username: rec.username, ip, reason: 'frozen' }); return send(res, 403, { error: 'this account is frozen — an admin can unfreeze it', frozen: true }); }
      const ban = auth.banFor({ username: rec.username, ip });
      if (ban) return send(res, 403, { error: banMessage(ban), banned: true, until: ban.until });
      rec.lastLogin = now();
      const session = auth.createSession({ kind: 'account', username: rec.username, handle: rec.username, role: rec.role, ip });
      setCookie(res, session);
      auth.save();
      event('login', { username: rec.username, ip });
      return send(res, 200, { ok: true, me: meView(session), claimable: !auth.hasAdmin() });
    }

    // -- logout --
    if (method === 'POST' && p === '/api/auth/logout') {
      const s = sessionFrom(req);
      if (s) auth.destroySession(s.token);
      res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0, secure: COOKIE_SECURE }));
      return send(res, 200, { ok: true });
    }

    // -- change password (re-wraps the synced key on the client) --
    if (method === 'POST' && p === '/api/auth/password') {
      const s = sessionFrom(req);
      if (!s || s.kind !== 'account') return fail(res, 401, 'login required');
      const b = await readJson(req);
      if (!auth.verify(s.username, b.current)) return fail(res, 403, 'current password is wrong');
      const r = auth.setPassword(s.username, b.next);
      if (r.error) return fail(res, 400, r.error);
      auth.dropSessionsFor(s.username, s.token);
      event('password-change', { username: s.username, ip });
      return send(res, 200, { ok: true });
    }

    // -- claim the first admin (one-shot bootstrap code) --
    if (method === 'POST' && p === '/api/auth/claim') {
      if (!rateOk(ip, 'auth', (CFG.rate && CFG.rate.authPerMin) || 10)) return fail(res, 429, 'slow down');
      const s = sessionFrom(req);
      if (!s || s.kind !== 'account') return fail(res, 401, 'create an account first');
      if (auth.hasAdmin()) return fail(res, 409, 'an admin already exists');
      const b = await readJson(req);
      const code = String(b.code || '').trim().toUpperCase();
      const expected = settings.data.adminClaim;
      if (!expected || code.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
        event('claim-failed', { username: s.username, ip });
        return fail(res, 403, 'wrong code');
      }
      auth.setRole(s.username, 'admin');
      settings.clearClaimCode();
      const fresh = auth.resolve(s);
      event('admin-claimed', { username: s.username, ip });
      log('admin-claimed', s.username);
      return send(res, 200, { ok: true, me: meView(fresh) });
    }

    // -- guest session --
    if (method === 'POST' && p === '/api/guest') {
      if (settings.data.guestAccess === false) return fail(res, 403, 'guest access is off');
      if (!rateOk(ip, 'guest', (CFG.rate && CFG.rate.guestPerMin) || 10)) return fail(res, 429, 'slow down');
      const b = await readJson(req);
      let handle = String(b.handle || '').toLowerCase().trim();
      if (!handle) handle = randomHandle();
      if (!HANDLE_RE.test(handle)) return fail(res, 400, 'handle must be 2-24 chars: a-z, 0-9 or -');
      const fp = String(b.fp || '').toLowerCase();
      if (fp && !FP_RE.test(fp)) return fail(res, 400, 'bad fingerprint');
      if (fp && auth.banFor({ fp, ip })) return send(res, 403, { error: 'this device is banned', banned: true });
      if (!fp && settings.data.guestAccess !== false && auth.banFor({ ip })) return send(res, 403, { error: 'this address is banned', banned: true });
      const old = sessionFrom(req);
      if (old && old.kind === 'guest') auth.destroySession(old.token);
      const session = auth.createSession({ kind: 'guest', handle, role: 'guest', fp: fp || null, ip });
      setCookie(res, session);
      event('guest', { handle, fp: fp.slice(0, 8), ip });
      return send(res, 201, { ok: true, me: meView(session) });
    }

    /* ---- everything below needs a session ---- */
    const session = sessionFrom(req);
    const actor = actorOf(session);
    if (!actor) return fail(res, 401, 'login required');
    if (session.kind === 'account') auth.touch(session);

    // -- who am I + what may I see --
    if (method === 'GET' && p === '/api/me') {
      return send(res, 200, {
        me: meView(session),
        settings: settings.publicView(),
        claimable: !auth.hasAdmin(),
        retentionHours: chat.retentionHours,
        maxFileBytes: chat.maxFileBytes,
        serverTime: now(),
        fx: auth.fxMap(),
        effects: EFFECTS,
        rooms: rooms.list(actor, liveFor),
      });
    }

    // -- cosmetic name effect: self-pick (staff, or anyone the developer unlocked) --
    if (method === 'POST' && p === '/api/me/fx') {
      if (actor.kind !== 'account') return fail(res, 403, 'accounts only');
      const rec = auth.get(actor.username) || {};
      if ((RANK[actor.role] ?? 0) < RANK.admin && !rec.fxAllowed) return fail(res, 403, 'the developer unlocks name effects for you first');
      const b = await readJson(req);
      const fx = b.fx === null || b.fx === undefined || b.fx === '' ? null : String(b.fx);
      const r = auth.setFx(actor.username, fx);
      if (r.error) return fail(res, 400, r.error);
      applyFx(actor.username, r.account.fx, r.account.fxAllowed);
      event('fx', { username: actor.username, fx: r.account.fx, by: actor.username });
      return send(res, 200, { ok: true, me: meView(auth.resolve(session)), fx: auth.fxMap() });
    }

    // -- my synced key blob (opaque envelope; the server cannot open it) --
    if (p === '/api/sync-key') {
      if (actor.kind !== 'account') return fail(res, 403, 'accounts only');
      if (method === 'GET') {
        const rec = auth.get(actor.username);
        return send(res, 200, { syncKey: rec.syncKey ? { enabled: true, blob: rec.syncKey.blob, updatedAt: rec.syncKey.updatedAt } : { enabled: false } });
      }
      if (method === 'PUT' || method === 'POST') {
        const b = await readJson(req);
        const r = auth.setSyncKey(actor.username, b.enabled !== false, b.blob);
        if (r.error) return fail(res, 400, r.error);
        event('sync-key', { username: actor.username, enabled: !!b.enabled });
        return send(res, 200, { ok: true, syncKey: r.syncKey, syncOptOut: r.syncOptOut });
      }
      if (method === 'DELETE') {
        const r = auth.setSyncKey(actor.username, false);
        return send(res, 200, { ok: true, syncKey: { enabled: false }, syncOptOut: r.syncOptOut });
      }
    }

    // -- rooms --
    if (method === 'GET' && p === '/api/rooms') {
      return send(res, 200, { rooms: rooms.list(actor, liveFor) });
    }
    if (method === 'POST' && p === '/api/rooms') {
      const b = await readJson(req);
      const r = rooms.create({ name: b.name, about: b.about, private: b.private, guestOk: b.guestOk }, actor);
      if (r.error) return fail(res, 403, r.error);
      chat.ensureRoom(r.room.id);
      event('room-create', { room: r.room.id, name: r.room.name, by: actor.username || actor.handle });
      log('room-create', r.room.id, actor.username || actor.handle);
      return send(res, 201, { ok: true, room: rooms.view(rooms.get(r.room.id), actor, liveFor(r.room.id)) });
    }

    // One message: edit it (the author only, and only while the site allows editing)
    // or delete it (the author, or staff moderating). A deletion leaves a tombstone
    // row without its ciphertext, so the timeline keeps its place.
    const msgMatch = p.match(/^\/api\/rooms\/([a-z0-9-]{1,32})\/messages\/([a-z0-9-]{8,64})$/);
    if (msgMatch && (method === 'DELETE' || method === 'POST' || method === 'PATCH')) {
      const roomId = msgMatch[1];
      const mid = msgMatch[2];
      const room = rooms.get(roomId);
      if (!room) return fail(res, 404, 'no such room');
      if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
      const row = chat.find(roomId, mid);
      if (!row) return fail(res, 404, 'no such message');
      const me = [actor.fp, actor.username ? (auth.get(actor.username) || {}).keyFp : null].filter(Boolean);
      const mine = me.includes(row.fp);
      // Approving is the "staff in this room" bit: owner, room mod, mod, admin.
      const staff = rooms.can(actor, 'approve', room) || rooms.can(actor, 'delete', room);
      const who = actor.username || actor.handle || 'someone';
      if (method === 'DELETE') {
        if (!mine && !staff) return fail(res, 403, 'you can only delete your own messages');
        if (mine && !staff && settings.data.allowMsgDelete === false) return fail(res, 403, 'deleting messages is switched off right now');
        const r = chat.removeMessage(roomId, mid, who);
        if (r.error) return fail(res, 409, r.error);
        event('msg-delete', { room: roomId, id: mid, author: row.handle, by: who });
        broadcastRoom(roomId, { t: 'msg-del', room: roomId, id: mid, by: who, ts: now() });
        return send(res, 200, { ok: true, id: mid });
      }
      if (!mine) return fail(res, 403, 'you can only edit your own messages');
      if (settings.data.allowMsgEdit === false) return fail(res, 403, 'editing messages is switched off right now');
      const b = await readJson(req);
      const r = chat.editMessage(roomId, mid, { ct: (b || {}).ct, recipients: (b || {}).recipients, fp: me[0] });
      if (r.error) return fail(res, 400, r.error);
      event('msg-edit', { room: roomId, id: mid, author: row.handle, by: who });
      broadcastRoom(roomId, { t: 'msg-edit', room: roomId, id: mid, ct: r.message.ct, edited: r.message.edited, ts: now() });
      return send(res, 200, { ok: true, id: mid, edited: r.message.edited });
    }

    const fileMatch = p.match(/^\/api\/rooms\/([a-z0-9-]{1,32})\/files\/([a-z0-9]{8,32})$/);
    if (fileMatch) {
      const roomId = fileMatch[1];
      const fileId = fileMatch[2];
      const room = rooms.get(roomId);
      if (!room) return fail(res, 404, 'no such room');
      if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'not allowed');
      if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
      if (!chat.hasFile(roomId, fileId)) return fail(res, 404, 'that attachment is gone');
      const full = chat.filePath(roomId, fileId);
      const size = fs.statSync(full).size;
      res.writeHead(200, {
        ...secHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': size,
        'Cache-Control': 'no-store', 'Content-Disposition': 'attachment',
      });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(full).pipe(res);
    }

    const roomMatch = p.match(/^\/api\/rooms\/([a-z0-9-]{1,32})(?:\/(join|leave|state|keys|pool|history|members|files))?$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const sub = roomMatch[2] || '';
      const room = rooms.get(roomId);
      if (!room) return fail(res, 404, 'no such room');

      if (sub === '' && method === 'GET') {
        if (!rooms.can(actor, 'view', room)) return fail(res, 403, 'not allowed');
        return send(res, 200, { room: rooms.view(room, actor, liveFor(roomId)) });
      }
      if (sub === '' && (method === 'PATCH' || method === 'POST')) {
        const b = await readJson(req);
        const r = rooms.update(roomId, b || {}, actor);
        if (r.error) return fail(res, 403, r.error);
        const what = typeof b.frozen === 'boolean' ? (b.frozen ? 'froze the room' : 'unfroze the room')
          : typeof b.private === 'boolean' ? (b.private ? 'made the room private' : 'made the room public')
          : b.slowMs !== undefined ? (Number(b.slowMs) > 0 ? 'turned on slow mode' : 'turned off slow mode')
          : 'changed the room settings';
        event('room-update', { room: roomId, by: actor.username || actor.handle, what, patch: Object.keys(b || {}) });
        broadcastRoomState(roomId, `${actor.handle} ${what}`);
        return send(res, 200, { ok: true, room: r.room });
      }
      if (sub === '' && method === 'DELETE') {
        const r = rooms.remove(roomId, actor);
        if (r.error) return fail(res, 403, r.error);
        kickSockets(c => c.__room === roomId, 'room closed');
        chat.dropRoom(roomId);
        online.delete(roomId);
        event('room-delete', { room: roomId, name: r.room.name, by: actor.username || actor.handle });
        log('room-delete', roomId, actor.username || actor.handle);
        return send(res, 200, { ok: true, room: r.room });
      }
      if (sub === 'join' && method === 'POST') {
        const ban = banFor(actor, roomId);
        if (ban) return send(res, 403, { error: banMessage(ban), banned: true });
        const r = rooms.join(roomId, actor, actor.fp);
        if (r.error) return fail(res, 403, r.error);
        event('room-join', { room: roomId, who: actor.username || actor.handle, pending: r.pending });
        if (r.pending) {
          const sys = `${actor.handle} asked to join`;
          broadcastRoom(roomId, { t: 'sys', room: roomId, text: sys, ts: now() });
          for (const name of room.mods.concat(room.owner ? [room.owner] : [])) {
            // notify moderators who are online elsewhere
            for (const c of wss.clients) {
              if (c.readyState === 1 && c.__username === name) { try { c.send(JSON.stringify({ t: 'err', msg: `${actor.handle} wants into ${room.name}`, kind: 'info' })); } catch { /* ignore */ } }
            }
          }
        }
        broadcastRoomState(roomId);
        return send(res, 200, { ok: true, pending: r.pending, room: rooms.view(rooms.get(roomId), actor, liveFor(roomId)) });
      }
      if (sub === 'leave' && method === 'POST') {
        const r = rooms.leave(roomId, actor);
        if (r.error) return fail(res, 403, r.error);
        event('room-leave', { room: roomId, who: actor.username || actor.handle });
        broadcastRoomState(roomId, `${actor.handle} left the room`);
        return send(res, 200, { ok: true });
      }
      if (sub === 'state' && method === 'GET') {
        if (!rooms.can(actor, 'view', room)) return fail(res, 403, 'not allowed');
        return send(res, 200, { room: rooms.view(room, actor, liveFor(roomId)), online: roomOnlineList(roomId) });
      }
      if (sub === 'members' && method === 'POST') {
        const b = await readJson(req);
        const r = rooms.memberOp(roomId, b.username, b.op, actor);
        if (r.error) return fail(res, 403, r.error);
        event('member-op', { room: roomId, op: b.op, target: r.target, by: actor.username || actor.handle });
        if (b.op === 'kick') {
          kickSockets(c => c.__room === roomId && c.__username === r.target, 'removed from the room');
          broadcastRoomState(roomId, `${r.target} was removed from the room`);
        } else if (b.op === 'approve') {
          broadcastRoomState(roomId, `${r.target} was let in`);
        } else if (b.op === 'mod') {
          broadcastRoomState(roomId, `${r.target} is now a room mod`);
        } else if (b.op === 'unmod') {
          broadcastRoomState(roomId, `${r.target} is no longer a room mod`);
        } else {
          broadcastRoomState(roomId);
        }
        return send(res, 200, { ok: true, room: r.room });
      }
      if (sub === 'pool' && method === 'GET') {
        if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
        return send(res, 200, {
          serverTime: now(), retentionHours: chat.retentionHours, room: roomId,
          frozen: room.frozen, private: room.private,
          keys: chat.keys(roomId),
        });
      }
      if (sub === 'keys' && method === 'POST') {
        if (!rateOk(ip, 'keys', (CFG.rate && CFG.rate.keysPerMin) || 8)) return fail(res, 429, 'slow down');
        const ban = banFor(actor, roomId);
        if (ban) return send(res, 403, { error: banMessage(ban), banned: true });
        if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed in this room');
        const b = await readJson(req);
        return registerRoomKey({ roomId, body: b, session, actor, res });
      }
      if (sub === 'files' && method === 'POST') {
        if (!rateOk(ip, 'files', (CFG.rate && CFG.rate.filesPerMin) || 10)) return fail(res, 429, 'slow down');
        const postBan = banFor(actor, roomId, { ip, forPost: true });
        if (postBan) return send(res, 403, { error: banMessage(postBan), banned: true });
        if (!rooms.can(actor, 'post', room)) return fail(res, 403, room.frozen ? 'this room is frozen' : 'you cannot post in this room');
        // Two gates, both default off: the site switch for this kind of content, and the
        // room's own switch. The relay cannot inspect ciphertext, so the sender's declared
        // kind is what gets checked — this is a policy control for honest clients, not a
        // content firewall (there is nothing to filter: the bytes are sealed).
        const kind = String(req.headers['x-content-kind'] || 'file').toLowerCase();
        if (!['image', 'video', 'file'].includes(kind)) return fail(res, 400, 'unknown content kind');
        if (!settings.allowsKind(kind)) return fail(res, 403, kind === 'file' ? 'attachments are switched off site-wide' : `${kind}s are switched off site-wide`);
        if (!room.allowFiles) return fail(res, 403, 'attachments are switched off in this room');
        // Refuse an oversize body before reading a single byte of it.
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > chat.maxFileBytes) return fail(res, 413, `that upload is over the ${Math.round(chat.maxFileBytes / 1048576)} MB cap`);
        const body = await readBinary(req, chat.maxFileBytes);
        if (body.error) return fail(res, 413, body.error);
        const r = chat.addFile(roomId, { id: crypto.randomUUID().replace(/-/g, ''), data: body });
        if (r.error) return fail(res, 400, r.error);
        event('file', { room: roomId, by: actor.username || actor.handle, kind, bytes: r.size });
        log('file', roomId, kind, `${Math.round(r.size / 1024)}kb`);
        return send(res, 201, { ok: true, id: r.id, size: r.size });
      }
      if (sub === 'history' && method === 'GET') {
        if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
        const fp = (url.searchParams.get('fp') || '').toLowerCase();
        if (!FP_RE.test(fp)) return fail(res, 400, 'bad fp');
        const h = chat.history(roomId, fp, clampInt(url.searchParams.get('limit'), 1, 2000, chat.historyLimit));
        return send(res, 200, { ...h, room: roomId, retentionHours: chat.retentionHours, serverTime: now(), frozen: room.frozen });
      }
    }

    // -- legacy single-room endpoints, still routed to the lounge --
    if (method === 'GET' && p === '/api/pool') {
      const roomId = String(url.searchParams.get('room') || LOUNGE_ID);
      const room = rooms.get(roomId);
      if (!room || !rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
      return send(res, 200, { serverTime: now(), retentionHours: chat.retentionHours, room: roomId, keys: chat.keys(roomId) });
    }
    if (method === 'POST' && p === '/api/keys') {
      const b = await readJson(req);
      const roomId = String(b.room || LOUNGE_ID).toLowerCase();
      const room = rooms.get(roomId);
      if (!room) return fail(res, 404, 'no such room');
      if (!rateOk(ip, 'keys', (CFG.rate && CFG.rate.keysPerMin) || 8)) return fail(res, 429, 'slow down');
      const ban = banFor(actor, roomId);
      if (ban) return send(res, 403, { error: banMessage(ban), banned: true });
      if (!rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed in this room');
      return registerRoomKey({ roomId, body: b, session, actor, res });
    }
    if (method === 'GET' && p === '/api/history') {
      const roomId = String(url.searchParams.get('room') || LOUNGE_ID);
      const room = rooms.get(roomId);
      if (!room || !rooms.can(actor, 'read', room)) return fail(res, 403, 'not allowed');
      const fp = (url.searchParams.get('fp') || '').toLowerCase();
      if (!FP_RE.test(fp)) return fail(res, 400, 'bad fp');
      const h = chat.history(roomId, fp, clampInt(url.searchParams.get('limit'), 1, 2000, chat.historyLimit));
      return send(res, 200, { ...h, room: roomId, retentionHours: chat.retentionHours, serverTime: now(), frozen: room.frozen });
    }

    /* ---- moderation ---- */
    if (method === 'POST' && p === '/api/mod/ban') {
      const b = await readJson(req);
      const roomId = b.room ? String(b.room) : null;
      let kind = ['fp', 'ip'].includes(b.kind) ? b.kind : 'account';
      const target = String(b.target || '').toLowerCase().trim();
      if (!target) return fail(res, 400, 'no target');
      if (kind === 'ip' && (RANK[actor.role] ?? 0) < RANK.admin) return fail(res, 403, 'only an admin bans by address');
      if (auth.banFor({ username: actor.kind === 'account' ? actor.username : null, fp: actor.fp || null, room: roomId })) return fail(res, 403, 'you are banned');
      // permission + target rank
      if (roomId) {
        const room = rooms.get(roomId);
        if (!room) return fail(res, 404, 'no such room');
        if (!rooms.can(actor, 'ban', room)) return fail(res, 403, 'not allowed');
      } else if ((RANK[actor.role] ?? 0) < RANK.mod) return fail(res, 403, 'not allowed');

      if (kind === 'account') {
        const rec = auth.get(target);
        if (!rec) return fail(res, 404, 'no such account');
        if (!rooms.canModerate(actor, rec.role, rec.username)) return fail(res, 403, 'cannot act on that account');
      } else if (!FP_RE.test(target)) return fail(res, 400, 'bad fingerprint');

      const hours = b.hours == null ? null : clampInt(b.hours, 1, 720, null);
      const mute = !!b.mute;      // a timeout: they keep reading, they just cannot post
      const r = auth.addBan({ kind, target, room: roomId, until: hours ? now() + hours * 3600e3 : null, reason: b.reason, by: actor.username || actor.handle, mute });
      if (r.error) return fail(res, 400, r.error);
      event('ban', { kind, target, room: roomId, hours, mute, reason: String(b.reason || '').slice(0, 120), by: actor.username || actor.handle });
      log(mute ? 'mute' : 'ban', kind, target, roomId || 'site-wide', hours ? `${hours}h` : 'permanent');
      let kicked = 0;
      if (!mute) kicked = kickSockets(c => (kind === 'account' ? c.__username === target : kind === 'fp' ? c.__fp === target : false) && (!roomId || c.__room === roomId), banMessage(r.ban));
      if (roomId) broadcastRoomState(roomId, mute ? `${target} was muted in this room` : `${target} was banned from this room`);
      if (mute) {
        // A muted account is still connected, so its composer has to learn about it.
        const rec2 = auth.get(target);
        if (rec2) refreshActorSockets(target, rec2.role);
      }
      return send(res, 200, { ok: true, ban: r.ban, kicked, mute });
    }
    if (method === 'POST' && p === '/api/mod/unban') {
      if ((RANK[actor.role] ?? 0) < RANK.mod) return fail(res, 403, 'not allowed');
      const b = await readJson(req);
      const r = auth.liftBan({ id: b.id || null, kind: b.kind, target: b.target, room: b.room === undefined ? undefined : (b.room || null) });
      event('unban', { by: actor.username || actor.handle, ...b, removed: r.removed });
      return send(res, 200, { ok: true, removed: r.removed });
    }
    if (method === 'GET' && p === '/api/mod/bans') {
      if ((RANK[actor.role] ?? 0) < RANK.mod) return fail(res, 403, 'not allowed');
      return send(res, 200, { bans: auth.activeBans() });
    }

    /* ---- admin ---- */
    if (p.startsWith('/api/admin/')) {
      const rankNow = RANK[actor.role] ?? 0;
      const isAdmin = rankNow >= RANK.admin;

      // The audit log is read by staff: mods get the same trail with admin-only rows
      // and IP addresses removed, admins get everything except the bootstrap code.
      if (method === 'GET' && p === '/api/admin/events') {
        if (rankNow < RANK.mod) return fail(res, 403, 'staff only');
        return send(res, 200, readEvents(url.searchParams, isAdmin));
      }
      if (method === 'GET' && p === '/api/admin/events/export') {
        if (!isAdmin) return fail(res, 403, 'admin only');
        const name = `pgp-room-events-${new Date().toISOString().slice(0, 10)}.jsonl`;
        return send(res, 200, exportEvents(url.searchParams), {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
        });
      }

      if (method === 'GET' && p === '/api/admin/accounts/export') {
        if (!isAdmin) return fail(res, 403, 'admin only');
        const rows = auth.list().map(a => JSON.stringify({
          username: a.username, role: a.role, createdAt: a.createdAt, createdAtISO: new Date(a.createdAt).toISOString(),
          lastLogin: a.lastLogin, lastLoginISO: a.lastLogin ? new Date(a.lastLogin).toISOString() : null,
          keyFp: a.keyFp, syncKey: a.syncKey, fx: a.fx, fxAllowed: a.fxAllowed, frozen: a.frozen, sessions: a.sessions, banned: !!a.ban,
        }));
        return send(res, 200, rows.join('\n') + (rows.length ? '\n' : ''), {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="pgp-room-accounts-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        });
      }

      // The overview powers every staff page. Mods get the same read with the
      // session list (token hashes, IPs) stripped; only admins see live sessions.
      if (method === 'GET' && p === '/api/admin/overview') {
        const fileTotals = rooms.all().reduce((acc, r) => {
          const s = chat.fileStats(r.id);
          acc.count += s.count; acc.bytes += s.bytes;
          return acc;
        }, { count: 0, bytes: 0 });
        const data = {
          accounts: auth.list(),
          rooms: rooms.all().map(r => rooms.view(r, actor, liveFor(r.id))),
          bans: auth.activeBans(),
          settings: settings.publicView(),
          sessions: auth.sessionCount(),
          sessionList: isAdmin ? auth.listSessions() : [],
          guestSessions: [...auth.sessions.values()].filter(s => s.kind === 'guest').length,
          online: [...online.entries()].map(([room, m]) => ({ room, online: [...m.values()].map(o => o.handle) })),
          stats: chat.stats(),
          files: fileTotals,
          maxFileBytes: chat.maxFileBytes,
          perRoom: rooms.all().map(r => {
            const s = chat.roomStats(r.id);
            return {
              id: r.id, name: r.name, messages: s.messages, keys: s.keys, files: s.files, fileBytes: s.fileBytes,
              online: roomOnline(r.id).size, frozen: !!r.frozen, slowMs: r.slowMs || 0, owner: r.owner || null,
            };
          }),
          activity: activitySeries(7),
          fx: auth.fxMap(),
          retentionHours: chat.retentionHours,
          lockdown: !!settings.data.lockdown,
        };
        return send(res, 200, data);
      }

      if (!isAdmin) return fail(res, 403, 'admin only');

      if (method === 'GET' && p === '/api/admin/sessions') {
        return send(res, 200, { sessions: auth.listSessions() });
      }

      if (method === 'PATCH' || method === 'POST') {
        const b = await readJson(req);
        if (p === '/api/admin/settings') {
          const beforeMs = chat.retentionMs;
          const r = settings.patch(b, actor.role);
          if (r.error) return fail(res, 403, r.error);
          // Retention is policy now: shortening it takes effect at once, and the shredder
          // runs immediately so "24h instead of 48h" actually deletes the extra day.
          const afterMs = settings.retentionMs();
          if (afterMs !== beforeMs) {
            chat.setRetentionMs(afterMs);
            const swept = sweep();
            log('retention-change', `${beforeMs}->${afterMs}`, `rows=${swept.expiredDisk}`, `files=${swept.expiredFiles}`, `mem=${swept.expiredMemory}`);
          }
          event('settings', { by: actor.username, ...settings.publicView(), retentionHours: chat.retentionHours });
          log('settings', JSON.stringify(settings.publicView()));
          broadcastSettings();
          return send(res, 200, { ok: true, settings: r.settings, retentionHours: chat.retentionHours });
        }
        if (p === '/api/admin/role') {
          const target = String(b.username || '').toLowerCase();
          const rec = auth.get(target);
          if (!rec) return fail(res, 404, 'no such account');
          const role = String(b.role);
          // The developer seat exists to be above admin; it is set on the box, never
          // minted over the wire (a stolen session must not be able to create one).
          if (role === 'developer') return fail(res, 403, 'the developer seat is set on the box');
          if (!['user', 'mod', 'admin'].includes(role)) return fail(res, 400, 'bad role');
          if (rec.username === actor.username) return fail(res, 400, 'you cannot change your own role');
          // Rank ladder: act on someone strictly below you, or demote a peer; never
          // mint a rank above your own and never touch the developer.
          const a = RANK[actor.role] ?? -1;
          const t = RANK[rec.role] ?? -1;
          const want = RANK[role] ?? -1;
          const allowed = (t < a && want <= a) || (t === a && want < a && a < RANK.developer);
          if (!allowed) return fail(res, 403, 'not allowed');
          const r = auth.setRole(target, role);
          if (r.error) return fail(res, 400, r.error);
          // Name effects are the developer's to give and take; a role change leaves
          // them alone (they are no longer an admin badge).
          event('role', { target, role, by: actor.username });
          log('role', target, role, 'by', actor.username);
          refreshActorSockets(target, role);
          return send(res, 200, { ok: true, account: { username: target, role } });
        }

        // One switch that closes the room: freeze everything, stop new rooms, stop
        // guests, close signups. Lifting it clears every freeze (deliberate — that is
        // the undo); the policy switches stay where the lockdown left them.
        if (p === '/api/admin/lockdown') {
          const on = b.on !== false;
          settings.data.lockdown = on;
          if (on) { settings.data.allowNewRooms = false; settings.data.guestAccess = false; settings.data.allowRegistration = false; }
          settings.saveNow();
          for (const room of rooms.all()) room.frozen = on;
          rooms.saveNow();
          broadcastSettings();
          for (const room of rooms.all()) {
            broadcastRoomState(room.id, on ? 'the relay is in lockdown — only staff can post' : 'lockdown lifted');
          }
          event('lockdown', { on, by: actor.username, rooms: rooms.all().length });
          log('lockdown', on ? 'on' : 'off', `rooms=${rooms.all().length}`);
          return send(res, 200, { ok: true, lockdown: on, rooms: rooms.list(actor, liveFor), settings: settings.publicView() });
        }

        // Relay notice: pushed as a `sys` line, never stored as a message, never
        // encrypted — it is operator text, not somebody's chat.
        if (p === '/api/admin/announce') {
          const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
          if (text.length < 2) return fail(res, 400, 'write something to announce');
          const target = String(b.room || 'all');
          const ids = target === 'all' ? rooms.all().map(r => r.id) : [target];
          let delivered = 0;
          for (const id of ids) {
            if (!rooms.get(id)) continue;
            broadcastRoom(id, { t: 'sys', room: id, notice: true, text: `Relay notice — ${text}`, ts: now() });
            delivered += roomOnline(id).size;
          }
          event('announce', { by: actor.username, room: target, text });
          log('announce', target, text.slice(0, 60));
          return send(res, 200, { ok: true, rooms: ids.length, delivered });
        }

        // Per-account actions. Admins and the developer are never a target: the seat
        // cannot be removed by another admin, and nobody may act on themselves.
        if (p === '/api/admin/account') {
          const target = String(b.username || '').toLowerCase();
          const rec = auth.get(target);
          if (!rec) return fail(res, 404, 'no such account');
          const op = String(b.op || '');
          if (op === 'fx') {
            // The developer hands out name effects — applied to someone, or unlocked so
            // they pick their own. Cosmetic; it never touches keys or permissions.
            if ((RANK[actor.role] ?? 0) < RANK.developer) return fail(res, 403, 'the developer sets name effects');
            const fx = b.fx === null || b.fx === undefined || b.fx === '' ? null : String(b.fx);
            const r = auth.setFx(target, fx);
            if (r.error) return fail(res, 400, r.error);
            const allow = auth.setFxAllowed(target, !!b.fxAllowed);
            if (allow.error) return fail(res, 400, allow.error);
            applyFx(target, r.account.fx, r.account.fxAllowed);
            event('fx', { username: target, fx: r.account.fx, fxAllowed: !!r.account.fxAllowed, by: actor.username });
            return send(res, 200, { ok: true, fx: r.account.fx, fxAllowed: !!r.account.fxAllowed, fxMap: auth.fxMap() });
          }
          if (rec.username === actor.username) return fail(res, 400, 'that is your own account');
          if (rec.role === 'admin' || rec.role === 'developer') return fail(res, 403, 'admin and developer seats are never a target');
          if (op === 'signout') {
            const sessions = auth.dropSessionsFor(target);
            const sockets = kickSockets(c => c.__username === target, 'signed out by an admin');
            event('account-op', { op, target, by: actor.username, sessions, sockets });
            log('account-op', op, target, `sessions=${sessions}`);
            return send(res, 200, { ok: true, sessions, sockets });
          }
          if (op === 'freeze') {
            // Lock the account itself: sessions dropped, sign-in refused — until
            // unfrozen. Messages, keys and rooms are untouched (that is ban's job).
            const frozen = !!b.frozen;
            const r = auth.setFrozen(target, frozen);
            if (r.error) return fail(res, 400, r.error);
            const sockets = frozen ? kickSockets(c => c.__username === target, 'account frozen by an admin') : 0;
            event('account-op', { op: 'freeze', target, frozen, by: actor.username, sessions: r.sessionsDropped, sockets });
            log('account-op', frozen ? 'freeze' : 'unfreeze', target, `sessions=${r.sessionsDropped}`);
            return send(res, 200, { ok: true, frozen, sessions: r.sessionsDropped, sockets });
          }
          if (op === 'reset-password') {
            // The new password is generated here, handed to the admin once, and never
            // logged. The synced envelope is dropped: it was wrapped with the old one.
            const temp = crypto.randomBytes(10).toString('base64url');
            const r = auth.setPassword(target, temp);
            if (r.error) return fail(res, 400, r.error);
            auth.setSyncKey(target, false);
            const sessions = auth.dropSessionsFor(target);
            const sockets = kickSockets(c => c.__username === target, 'password reset by an admin');
            event('account-op', { op, target, by: actor.username, sessions, sockets });
            log('account-op', op, target, `sessions=${sessions}`);
            return send(res, 200, { ok: true, password: temp, sessions, sockets });
          }
          if (op === 'delete') {
            // Hand over anything they owned so rooms are never orphaned.
            const took = [];
            for (const room of rooms.all()) {
              if (room.owner === target) { room.owner = actor.username; room.members = [...new Set([...room.members, actor.username])]; took.push(room.id); }
              room.members = room.members.filter(u => u !== target);
              room.mods = room.mods.filter(u => u !== target);
              room.pending = room.pending.filter(u => u !== target);
            }
            rooms.saveNow();
            const r = auth.deleteAccount(target);
            if (r.error) return fail(res, 400, r.error);
            const sockets = kickSockets(c => c.__username === target, 'account deleted');
            for (const id of took) broadcastRoomState(id, 'the room changed hands');
            event('account-op', { op, target, by: actor.username, rooms: took.join(',') || null, sockets });
            log('account-op', op, target, `rooms=${took.length}`);
            return send(res, 200, { ok: true, rooms: took, sessions: r.sessionsDropped, sockets });
          }
          return fail(res, 400, 'unknown op');
        }

        if (p === '/api/admin/sessions') {
          const id = String(b.id || '').toLowerCase();
          if (!id) return fail(res, 400, 'no session id');
          const r = auth.revokeSession(id);
          if (r.error) return fail(res, 404, r.error);
          const sockets = kickSockets(c => c.__tok === r.session.token, 'session revoked by an admin');
          event('account-op', { op: 'revoke-session', target: r.session.username || r.session.handle || 'guest', by: actor.username, sockets });
          log('session-revoked', id, `sockets=${sockets}`);
          return send(res, 200, { ok: true, sockets });
        }

        // Clear every anonymous guest session in one move.
        if (p === '/api/admin/guests') {
          let sessions = 0;
          for (const [tok, s] of [...auth.sessions]) if (s.kind === 'guest') { auth.sessions.delete(tok); sessions++; }
          if (sessions) auth.saveNow();
          const sockets = kickSockets(c => c.__kind === 'guest', 'guest sessions were cleared');
          event('account-op', { op: 'guest-purge', by: actor.username, sessions, sockets });
          log('guest-purge', `sessions=${sessions}`, `sockets=${sockets}`);
          return send(res, 200, { ok: true, sessions, sockets });
        }

        // Burn a room's stored ciphertext now instead of waiting for the window.
        if (p === '/api/admin/purge') {
          const roomId = String(b.room || '');
          if (!rooms.get(roomId)) return fail(res, 404, 'no such room');
          const r = chat.purge(roomId);
          event('room-purge', { room: roomId, by: actor.username, rows: r.purgedRows, files: r.purgedFiles, blobs: r.purgedBlobs });
          log('room-purge', roomId, `rows=${r.purgedRows}`, `blobs=${r.purgedBlobs}`);
          broadcastRoomState(roomId, 'the relay cleared this room’s stored ciphertext');
          return send(res, 200, { ok: true, ...r });
        }

        // Room ownership and clearing a room out in one move.
        if (p === '/api/admin/room') {
          const roomId = String(b.room || '');
          const room = rooms.get(roomId);
          if (!room) return fail(res, 404, 'no such room');
          const op = String(b.op || '');
          if (op === 'owner') {
            const who = b.username ? String(b.username).toLowerCase() : actor.username;
            const rec = auth.get(who);
            if (!rec) return fail(res, 404, 'no such account');
            room.owner = rec.username;
            room.members = [...new Set([...room.members, rec.username])];
            rooms.saveNow();
            event('room-owner', { room: roomId, owner: rec.username, by: actor.username });
            log('room-owner', roomId, rec.username);
            broadcastRoomState(roomId, `${rec.username} now owns this room`);
            return send(res, 200, { ok: true, owner: rec.username });
          }
          if (op === 'kickall') {
            const sockets = kickSockets(c => c.__room === roomId, 'an admin cleared the room');
            event('room-kickall', { room: roomId, by: actor.username, sockets });
            log('room-kickall', roomId, `sockets=${sockets}`);
            return send(res, 200, { ok: true, sockets });
          }
          return fail(res, 400, 'unknown op');
        }

        // Lift every ban at once.
        if (p === '/api/admin/bans') {
          const r = auth.clearBans();
          event('unban', { by: actor.username, all: true, removed: r.removed });
          log('bans-cleared', `removed=${r.removed}`);
          for (const room of rooms.all()) broadcastRoomState(room.id);
          return send(res, 200, { ok: true, removed: r.removed });
        }
      }
      return fail(res, 404, 'not found');
    }

    return fail(res, 404, 'not found');
  }

  return fail(res, 404, 'not found');
}

/* ---------- room key registration (shared by the room route and /api/keys) ---------- */

function registerRoomKey({ roomId, body, session, actor, res }) {
  const b = body || {};
  const fp = String(b.fp || '').toLowerCase();
  const handle = String(b.handle || '').toLowerCase();
  const r = chat.registerKey(roomId, {
    fp, keyId: String(b.keyId || '').toLowerCase(), handle, publicKey: String(b.publicKey || ''),
  });
  if (r.error) return fail(res, 400, r.error);
  if (session.fp !== fp) { session.fp = fp; auth.save(); }
  if (actor.kind === 'account' && actor.username) auth.bindKey(actor.username, fp);
  event('key', { room: roomId, handle, fp: fp.slice(0, 8), poolSize: r.poolSize, isNew: r.isNew });
  if (r.isNew) {
    broadcastRoom(roomId, { t: 'key:add', room: roomId, key: { fp, handle, publicKey: String(b.publicKey || ''), joinedAt: r.joinedAt } });
    log('key-add', roomId, handle, fp.slice(0, 8), `pool=${r.poolSize}`);
  } else {
    log('key-seen', roomId, handle, fp.slice(0, 8));
    if (r.renamed) broadcastRoom(roomId, { t: 'sys', room: roomId, text: `${r.oldHandle} is now ${handle}`, ts: now() });
  }
  broadcastPresence(roomId);
  return send(res, 200, { ok: true, isNew: r.isNew, joinedAt: r.joinedAt, poolSize: r.poolSize });
}

// A role change applies to sockets that are already connected: refresh their actor
// fields and their view of every room they are sitting in.
function refreshActorSockets(username, role) {
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (c.__username === username) c.__role = role;
    const room = c.__room ? rooms.get(c.__room) : null;
    if (!room) continue;
    const actor = actorFromSocket(c);
    if (actor.username !== username && !rooms.can(actor, 'view', room)) { c.close(1008, 'no longer allowed'); continue; }
    const muted = !!banFor(actor, room.id, { forPost: true, ip: c.__ip });
    try {
      c.send(JSON.stringify({ t: 'room', room: rooms.view(room, actor, liveFor(room.id)), frozen: room.frozen, muted, canPost: rooms.can(actor, 'post', room) && !muted }));
    } catch { /* ignore */ }
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(e => {
    log('http-error', String(e && e.message));
    if (!res.headersSent) fail(res, 400, 'bad request');
  });
});

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 262144 });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  if (!rateOk(ip, 'conns', (CFG.rate && CFG.rate.connsPerMin) || 40)) { ws.close(1008, 'rate'); return; }
  ws.isAlive = true;
  ws.__room = null;
  ws.__fp = null;
  ws.__ip = ip;
  const helloTimer = setTimeout(() => { if (!ws.__room) ws.close(1008, 'no hello'); }, 12000);
  if (helloTimer.unref) helloTimer.unref();

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      const cookies = parseCookies(req.headers.cookie);
      let tok = cookies[COOKIE] || (typeof m.token === 'string' ? m.token : null);
      const session = auth.resolve(tok ? auth.sessions.get(tok) : null);
      if (!session) { ws.send(JSON.stringify({ t: 'err', msg: 'login required' })); ws.close(1008, 'login required'); return; }
      const actor = actorOf(session);
      const roomId = String(m.room || LOUNGE_ID).toLowerCase();
      const room = rooms.get(roomId);
      if (!room) { ws.send(JSON.stringify({ t: 'err', msg: 'no such room' })); ws.close(1008, 'no such room'); return; }
      const ban = banFor(actor, roomId, { ip });
      if (ban) { ws.send(JSON.stringify({ t: 'kick', reason: banMessage(ban) })); ws.close(1008, 'banned'); return; }
      if (!rooms.can(actor, 'read', room)) { ws.send(JSON.stringify({ t: 'err', msg: 'not allowed in this room' })); ws.close(1008, 'not allowed'); return; }
      if (!rooms.can(actor, 'join', room)) { ws.send(JSON.stringify({ t: 'err', msg: 'this room is locked' })); ws.close(1008, 'locked'); return; }
      if (actor.kind === 'account') rooms.join(roomId, actor, null);          // idempotent for public rooms

      const fp = String(m.fp || session.fp || '').toLowerCase();
      if (!FP_RE.test(fp)) { ws.send(JSON.stringify({ t: 'err', msg: 'bad fingerprint' })); ws.close(1008, 'bad fp'); return; }
      if (!chat.hasKey(roomId, fp)) { ws.send(JSON.stringify({ t: 'err', msg: 'register your key first' })); ws.close(1008, 'unknown key'); return; }
      const handle = actor.kind === 'account' ? actor.username : String(m.handle || actor.handle || '').toLowerCase();
      if (!HANDLE_RE.test(handle)) { ws.send(JSON.stringify({ t: 'err', msg: 'bad handle' })); ws.close(1008, 'bad handle'); return; }

      clearTimeout(helloTimer);
      ws.__room = roomId;
      ws.__fp = fp;
      ws.__handle = handle;
      ws.__username = actor.username;
      ws.__kind = actor.kind;
      ws.__role = actor.role;
      ws.__tok = session.token;
      auth.touch(session);
      chat.touchKey(roomId, fp);
      joinPresence(ws, roomId, { ...actor, fp, handle });
      const view = rooms.view(room, actor, liveFor(roomId));
      const muted = !!banFor(actor, roomId, { forPost: true, ip });
      ws.send(JSON.stringify({
        t: 'welcome',
        you: { fp, handle, kind: actor.kind, username: actor.username, role: actor.role, joinedAt: (chat.pool(roomId).get(fp) || {}).joinedAt || null },
        room: view, online: roomOnlineList(roomId), poolSize: chat.poolSize(roomId),
        serverTime: now(), retentionHours: chat.retentionHours, frozen: room.frozen,
        muted,
        canPost: rooms.can(actor, 'post', room) && !muted,
      }));
      return;
    }

    if (m.t === 'send') {
      if (!ws.__room) return;
      const roomId = ws.__room;
      const room = rooms.get(roomId);
      if (!room) return;
      const actor = actorFromSocket(ws);
      if (!rateOk(ip, 'msgs', (CFG.rate && CFG.rate.msgsPerMin) || 25)) { ws.send(JSON.stringify({ t: 'err', msg: 'rate limit — slow down' })); return; }
      const postBan = banFor(actor, roomId, { forPost: true, ip: ws.__ip });
      if (postBan) {
        if (postBan.mute) { ws.send(JSON.stringify({ t: 'err', msg: banMessage(postBan) })); return; }
        ws.send(JSON.stringify({ t: 'kick', reason: 'you are banned' })); ws.close(1008, 'banned'); return;
      }
      if (!rooms.can(actor, 'post', room)) {
        ws.send(JSON.stringify({ t: 'err', msg: room.frozen ? 'this room is frozen' : 'you cannot post in this room' }));
        return;
      }
      const ct = String(m.ct || '');
      if (!ct.startsWith(MSG_HEAD) || !ct.includes('END PGP MESSAGE') || ct.length > chat.maxMsgBytes) {
        ws.send(JSON.stringify({ t: 'err', msg: 'bad ciphertext' })); return;
      }
      // Slow mode: a per-room floor between one identity's messages. Mods and the
      // room's own staff are exempt (they are the ones who set it).
      if (room.slowMs && !(rooms.can(actor, 'freeze', room))) {
        const key = `${roomId}|${ws.__fp}`;
        const wait = room.slowMs - (now() - (lastPost.get(key) || 0));
        if (wait > 0) { ws.send(JSON.stringify({ t: 'err', msg: `slow mode — ${Math.ceil(wait / 1000)}s to go` })); return; }
      }
      const recipients = Array.isArray(m.recipients)
        ? [...new Set(m.recipients.map(r => String(r).toLowerCase()).filter(r => FP_RE.test(r)))]
        : [];
      const r = chat.add(roomId, { fp: ws.__fp, handle: ws.__handle, ct, recipients, id: uuid() });
      if (r.error) { ws.send(JSON.stringify({ t: 'err', msg: r.error })); return; }
      if (room.slowMs) lastPost.set(`${roomId}|${ws.__fp}`, now());
      const rec = r.message;
      const base = { id: rec.id, seq: rec.seq, t: rec.t, fp: rec.fp, handle: rec.handle, ct: rec.ct, room: roomId };
      const selfPayload = JSON.stringify({ t: 'msg', m: { ...base, tmpId: m.tmpId || null } });
      const otherPayload = JSON.stringify({ t: 'msg', m: base });
      for (const c of socketsIn(roomId)) {
        try { c.send(c === ws ? selfPayload : otherPayload); } catch { /* ignore */ }
      }
      return;
    }

    // room switch without dropping the socket
    if (m.t === 'switch') {
      const roomId = String(m.room || '').toLowerCase();
      const room = rooms.get(roomId);
      if (!room || !ws.__room) return;
      const actor = actorFromSocket(ws);
      if (!rooms.can(actor, 'read', room) || !rooms.can(actor, 'join', room)) { ws.send(JSON.stringify({ t: 'err', msg: 'not allowed in this room' })); return; }
      if (banFor(actor, roomId)) { ws.send(JSON.stringify({ t: 'kick', reason: 'you are banned' })); ws.close(1008, 'banned'); return; }
      leavePresence(ws);
      ws.__room = roomId;
      if (actor.kind === 'account') rooms.join(roomId, actor, null);
      joinPresence(ws, roomId, { ...actor, fp: ws.__fp, handle: ws.__handle });
      const view = rooms.view(room, actor, liveFor(roomId));
      ws.send(JSON.stringify({
        t: 'welcome', you: { fp: ws.__fp, handle: ws.__handle, kind: actor.kind, username: actor.username, role: actor.role },
        room: view, online: roomOnlineList(roomId), poolSize: chat.poolSize(roomId), serverTime: now(),
        retentionHours: chat.retentionHours, frozen: room.frozen, canPost: rooms.can(actor, 'post', room),
      }));
      return;
    }

    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }
  });

  ws.on('close', () => { clearTimeout(helloTimer); leavePresence(ws); });
  ws.on('error', () => { /* ignore */ });
});

const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
hb.unref();
wss.on('close', () => clearInterval(hb));

/* ---------- boot ---------- */

function load() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'rooms'), { recursive: true });
  const s = settings.load();
  const a = auth.load();
  const r = rooms.load();
  const migrated = chat.migrateLegacy(LOUNGE_ID);
  if (fs.existsSync(LEGACY_MSG_FILE)) { try { fs.renameSync(LEGACY_MSG_FILE, `${LEGACY_MSG_FILE}.migrated`); } catch { /* leave it */ } }
  const c = chat.load(rooms.all().map(x => x.id));
  // How long ciphertext lives is policy (settings.json), not a constant: config.json is
  // only the fallback for a relay where nobody has touched the panel yet.
  chat.setRetentionMs(settings.retentionMs());
  for (const room of rooms.all()) {
    fs.mkdirSync(chat.msgDir(room.id), { recursive: true });
    fs.mkdirSync(chat.filesDir(room.id), { recursive: true });
  }

  // Bootstrap: while no admin exists, keep a one-shot claim code on hand as the
  // fallback way to seat one. It is written to settings.json and emitted as an event
  // (the root-run notifier DMs it to the operator) — never to stdout, which is what
  // journald keeps. On an empty relay the first account to register is seated as admin
  // and clears the code: that path needs no code, and a live secret is dead weight.
  if (!auth.hasAdmin()) {
    const { code, created } = settings.ensureClaimCode();
    if (created) event('admin-claim', { code, note: 'claim the first admin account with this code (app -> Admin)' });
  }
  log('loaded',
    `rooms=${r.rooms}`, `accounts=${a.accounts}`, `sessions=${a.sessions}`, `bans=${a.bans}`,
    `keys=${c ? Object.values(c).reduce((n, x) => n + x.keys, 0) : 0}`, `ttl=${chat.retentionHours == null ? 'forever' : `${chat.retentionHours}h`}`,
    `migrated=${migrated.join('+') || 'none'}`, `guestAccess=${s.guestAccess}`, `admin=${auth.hasAdmin()}`,
    `uploads=${['images', 'video', 'files'].filter(k => settings.filePolicy()[k === 'images' ? 'images' : k]).join(',') || 'off'}`);
}

function shutdown(sig) {
  log('shutdown', sig);
  try { auth.saveNow(); chat.saveAllKeys(); settings.saveNow(); rooms.saveNow(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log('uncaught', String(e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled-rejection', String(e && e.message || e)));

load();
sweep();
setInterval(() => {
  try {
    sweep();
    auth.prune();
  } catch (e) { log('cleanup-error', e.message); }
}, CLEANUP_MS).unref();

function sweep() {
  const r = chat.cleanup();
  if (r.expiredDisk || r.expiredMemory || r.expiredFiles) {
    log('retention-sweep', `expired_disk=${r.expiredDisk}`, `expired_memory=${r.expiredMemory}`, `expired_files=${r.expiredFiles}`);
  }
  return r;
}

server.listen(CFG.port || 8788, CFG.bind || '127.0.0.1', () => {
  log('listening', `${CFG.bind || '127.0.0.1'}:${CFG.port || 8788}`, PUBLIC_URL);
});
