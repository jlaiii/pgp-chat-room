#!/usr/bin/env node
'use strict';
/*
 * PGP Room — relay server.
 *
 * Design constraint: this process stores and forwards ciphertext ONLY.
 * It has no OpenPGP library, no private keys and no decryption code path,
 * so the operator of this box cannot read the room's messages. `ws` is the
 * only dependency.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const CONFIG_PATH = process.env.PGPCHAT_CONFIG || path.join(ROOT, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DATA = path.resolve(ROOT, CFG.dataDir || 'data');
const PUB = path.resolve(ROOT, CFG.publicDir || 'public');
const MSG_DIR = path.join(DATA, 'messages');           // per-UTC-day segment files
const LEGACY_MSG_FILE = path.join(DATA, 'messages.jsonl'); // pre-retention layout
const KEY_FILE = path.join(DATA, 'keys.json');
const EVT_FILE = path.join(DATA, 'events.log');
const PUBLIC_URL = CFG.publicUrl || '';

const FP_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KEYID_RE = /^[a-f0-9]{8,16}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
const ARMOR_HEAD = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const MSG_HEAD = '-----BEGIN PGP MESSAGE-----';

// ---------- in-memory state (mirrored to disk) ----------
let keys = new Map();      // fp -> {fp,keyId,handle,publicKey,joinedAt,lastSeen}
let messages = [];         // {id,seq,t,fp,handle,recipients[],ct}
let seq = 0;
const online = new Map();  // fp -> {handle, socks:Set<ws>}
const byIp = new Map();    // ip -> {msgs:[],keys:[],conns:[]} rolling timestamps
const leaveTimers = new Map();

const MAX_MEM_MSG = 20000;
// Message lifetime: after RETENTION_MS the ciphertext is removed from memory and
// from disk (overwritten, then unlinked). Clients apply the same window locally.
const RETENTION_MS = Math.max(0, Number(CFG.retentionHours != null ? CFG.retentionHours : 48)) * 3600000;
const CLEANUP_MS = Math.max(1, Number(CFG.cleanupMinutes != null ? CFG.cleanupMinutes : 5)) * 60000;

function log(...a) { console.log(JSON.stringify({ ts: new Date().toISOString(), msg: a.join(' ') })); }
function segPath(day) { return path.join(MSG_DIR, day + '.jsonl'); }
function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function segmentFiles() {
  try { return fs.readdirSync(MSG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); }
  catch { return []; }
}
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}
// Best-effort secure erase: overwrite the file's blocks with random bytes (2 passes),
// fsync, then unlink. On a journalled/CoW filesystem this is not a forensic guarantee —
// the real guarantee is that the bytes are ciphertext nobody (not even root) can read.
function secureErase(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r+');
      const chunkSize = 1 << 16;
      for (let pass = 0; pass < 2; pass++) {
        let pos = 0;
        while (pos < size) {
          const n = Math.min(chunkSize, size - pos);
          fs.writeSync(fd, crypto.randomBytes(n), 0, n, pos);
          pos += n;
        }
        fs.fsyncSync(fd);
      }
      fs.closeSync(fd);
    }
    fs.unlinkSync(file);
    log('shredded', path.basename(file), `bytes=${size}`);
    return true;
  } catch (e) { log('shred-failed', path.basename(file), e.message); return false; }
}
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_MSG_FILE)) return;
  const lines = readLines(LEGACY_MSG_FILE);
  const buckets = new Map();
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      const day = dayOf(m.t);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(line);
    } catch { /* drop corrupt */ }
  }
  for (const [day, ls] of buckets) fs.appendFileSync(segPath(day), ls.join('\n') + '\n');
  secureErase(LEGACY_MSG_FILE);
  log('migrated-legacy-messages', `lines=${lines.length}`, `days=${buckets.size}`);
}
function load() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(MSG_DIR, { recursive: true });
  migrateLegacy();
  const cutoff = Date.now() - RETENTION_MS;
  for (const f of segmentFiles()) {
    for (const line of readLines(path.join(MSG_DIR, f))) {
      try {
        const m = JSON.parse(line);
        if (m && typeof m.ct === 'string' && Array.isArray(m.recipients) && m.t >= cutoff) messages.push(m);
      } catch { /* skip corrupt line */ }
    }
  }
  messages.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (messages.length > MAX_MEM_MSG) messages = messages.slice(-MAX_MEM_MSG);
  seq = messages.reduce((a, m) => Math.max(a, m.seq || 0), 0);
  try {
    const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    for (const k of raw.keys || []) if (FP_RE.test(k.fp || '')) keys.set(k.fp, k);
  } catch { /* first boot */ }
  log('loaded', `messages=${messages.length}`, `keys=${keys.size}`, `ttl=${RETENTION_MS / 3600000}h`);
}
// Retention sweep: whole day-segments past the window are shredded outright; the
// boundary segments are rewritten without the expired lines (old file shredded).
function cleanup() {
  const cutoff = Date.now() - RETENTION_MS;
  let expiredDisk = 0;
  for (const f of segmentFiles()) {
    const full = path.join(MSG_DIR, f);
    const endOfDay = Date.parse(f.slice(0, 10) + 'T23:59:59.999Z');
    if (endOfDay < cutoff) { secureErase(full); continue; }
    const lines = readLines(full);
    const kept = [];
    for (const line of lines) {
      try { if (JSON.parse(line).t >= cutoff) kept.push(line); } catch { /* drop corrupt */ }
    }
    if (kept.length !== lines.length) {
      expiredDisk += lines.length - kept.length;
      const tmp = full + '.tmp';
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
      const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
      secureErase(full);
      fs.renameSync(tmp, full);
    }
  }
  const expiredMem = messages.filter(m => m.t < cutoff).length;
  if (expiredMem) messages = messages.filter(m => m.t >= cutoff);
  if (expiredDisk || expiredMem) {
    log('retention-sweep', `expired_disk=${expiredDisk}`, `expired_memory=${expiredMem}`, `live=${messages.length}`);
  }
  return expiredDisk + expiredMem;
}
let keySaveTimer = null;
function saveKeys() {
  if (keySaveTimer) return;
  keySaveTimer = setTimeout(() => {
    keySaveTimer = null;
    const tmp = KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ keys: [...keys.values()], savedAt: Date.now() }, null, 0));
    fs.renameSync(tmp, KEY_FILE);
  }, 800);
}
function appendMessage(m) { fs.appendFileSync(segPath(dayOf(m.t)), JSON.stringify(m) + '\n'); }
function event(type, extra) {
  try { fs.appendFileSync(EVT_FILE, JSON.stringify({ t: Date.now(), type, ...extra }) + '\n'); }
  catch (e) { log('event-write-failed', e.message); }
}

// ---------- helpers ----------
function clientIp(req) {
  if (CFG.trustProxy) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function rateOk(ip, kind, limit) {
  const now = Date.now();
  let b = byIp.get(ip);
  if (!b) { b = { msgs: [], keys: [], conns: [] }; byIp.set(ip, b); }
  const arr = b[kind];
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (b.msgs.length > 4000) return false; // runaway map guard
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}
setInterval(() => { // prune ip buckets
  const now = Date.now();
  for (const [ip, b] of byIp) {
    for (const k of ['msgs', 'keys', 'conns']) b[k] = b[k].filter(t => now - t < 60000);
    if (!b.msgs.length && !b.keys.length && !b.conns.length) byIp.delete(ip);
  }
}, 120000).unref();

// CSP: same-origin only, plus the WebSocket origin derived from publicUrl when set
// (some browsers don't treat 'self' as covering WebSocket URLs).
const WS_ORIGIN = (() => {
  try {
    if (!PUBLIC_URL) return '';
    const u = new URL(PUBLIC_URL);
    return ` ${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  } catch { return ''; }
})();
const secHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
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
  if (typeof body === 'object' && body !== null) {
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Cache-Control'] = 'no-store';
    body = JSON.stringify(body);
  }
  res.writeHead(code, h);
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > (CFG.maxMsgBytes || 65536) + 4096) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// ---------- presence ----------
function presenceList() {
  return [...online.entries()].map(([fp, o]) => ({ fp, handle: o.handle }));
}
function broadcast(obj, except) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) {
    // only sockets that completed hello get room traffic
    if (c.__fp && c.readyState === 1 && c !== except) { try { c.send(s); } catch { /* ignore */ } }
  }
}
function broadcastPresence() {
  broadcast({ t: 'presence', online: presenceList(), count: online.size });
}
function joinRoom(ws, ident) {
  const { fp, handle } = ident;
  const t = leaveTimers.get(fp);
  if (t) { clearTimeout(t); leaveTimers.delete(fp); }
  let o = online.get(fp);
  const firstSocket = !o;
  if (!o) { o = { handle, socks: new Set() }; online.set(fp, o); }
  o.handle = handle;
  o.socks.add(ws);
  if (firstSocket) {
    broadcast({ t: 'sys', text: `${handle} joined` }, ws);
    event('join', { handle, fp: fp.slice(0, 8), online: online.size });
    log('join', handle, fp.slice(0, 8), `online=${online.size}`);
  }
  broadcastPresence();
}
function leaveRoom(ws) {
  const fp = ws.__fp;
  if (!fp) return;
  const o = online.get(fp);
  if (!o) return;
  o.socks.delete(ws);
  if (o.socks.size) { broadcastPresence(); return; }
  // grace period: page reloads / phone lock shouldn't spam "left"
  const timer = setTimeout(() => {
    leaveTimers.delete(fp);
    const cur = online.get(fp);
    if (cur && cur.socks.size === 0) {
      online.delete(fp);
      broadcast({ t: 'sys', text: `${cur.handle} left` });
      broadcastPresence();
      event('leave', { handle: cur.handle, fp: fp.slice(0, 8), online: online.size });
      log('leave', cur.handle, fp.slice(0, 8), `online=${online.size}`);
    }
  }, 8000);
  leaveTimers.set(fp, timer);
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/style.css': ['style.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/vendor/openpgp.min.js': ['vendor/openpgp.min.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[p]) {
      const [rel, ctype, cc] = STATIC[p];
      const file = path.join(PUB, rel);
      if (!file.startsWith(PUB)) return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
      if (!fs.existsSync(file)) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
      res.writeHead(200, { ...secHeaders, 'Content-Type': ctype, 'Cache-Control': cc, 'Content-Length': fs.statSync(file).size });
      if (req.method === 'HEAD') return res.end();
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && p === '/robots.txt') {
      return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
    }
    if (req.method === 'GET' && p === '/healthz') {
      return send(res, 200, {
        ok: true, messages: messages.length, keys: keys.size, online: online.size,
        uptime: Math.round(process.uptime()), retentionHours: RETENTION_MS / 3600000,
        oldestMessageT: messages.length ? messages[0].t : null,
      });
    }
    if (req.method === 'GET' && p === '/api/pool') {
      return send(res, 200, {
        serverTime: Date.now(),
        retentionHours: RETENTION_MS / 3600000,
        keys: [...keys.values()].map(k => ({ fp: k.fp, handle: k.handle, publicKey: k.publicKey, joinedAt: k.joinedAt })),
      });
    }
    if (req.method === 'GET' && p === '/api/history') {
      const fp = (url.searchParams.get('fp') || '').toLowerCase();
      if (!FP_RE.test(fp)) return send(res, 400, { error: 'bad fp' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '400', 10) || 400, 1000);
      const mine = [], locked = [];
      for (const m of messages) (m.recipients.includes(fp) ? mine : locked).push(m);
      const you = keys.get(fp);
      return send(res, 200, {
        serverTime: Date.now(),
        retentionHours: RETENTION_MS / 3600000,
        joinedAt: you ? you.joinedAt : null,
        poolSize: keys.size,
        lockedCount: locked.length,
        messages: mine.slice(-limit).map(m => ({ id: m.id, seq: m.seq, t: m.t, fp: m.fp, handle: m.handle, ct: m.ct })),
      });
    }
    if (req.method === 'POST' && p === '/api/keys') {
      const ip = clientIp(req);
      if (!rateOk(ip, 'keys', (CFG.rate && CFG.rate.keysPerMin) || 8)) return send(res, 429, { error: 'slow down' });
      const b = await readJson(req);
      const fp = String(b.fp || '').toLowerCase();
      const keyId = String(b.keyId || '').toLowerCase();
      let handle = String(b.handle || '').toLowerCase();
      const publicKey = String(b.publicKey || '');
      if (!FP_RE.test(fp)) return send(res, 400, { error: 'bad fingerprint' });
      if (!KEYID_RE.test(keyId)) return send(res, 400, { error: 'bad key id' });
      if (!HANDLE_RE.test(handle)) return send(res, 400, { error: 'bad handle' });
      if (!publicKey.startsWith(ARMOR_HEAD) || publicKey.length > (CFG.maxKeyBytes || 8192) || !publicKey.includes('END PGP PUBLIC KEY BLOCK')) {
        return send(res, 400, { error: 'bad public key' });
      }
      if (publicKey.toUpperCase().includes('PRIVATE KEY')) return send(res, 400, { error: 'private key rejected' });
      const existing = keys.get(fp);
      if (existing) {
        existing.lastSeen = Date.now();
        if (existing.handle !== handle) {
          const oldHandle = existing.handle;
          existing.handle = handle;
          if (online.has(fp)) online.get(fp).handle = handle;
          const me = online.get(fp);
          if (me) for (const s of me.socks) s.__handle = handle;
          broadcast({ t: 'sys', text: `${oldHandle} is now ${handle}` });
          broadcastPresence();
        }
        saveKeys();
        return send(res, 200, { isNew: false, joinedAt: existing.joinedAt, poolSize: keys.size });
      }
      // evict oldest idle key if the pool is at cap
      if (keys.size >= (CFG.maxPool || 500)) {
        let victim = null;
        for (const k of keys.values()) {
          if (online.has(k.fp)) continue;
          if (!victim || k.lastSeen < victim.lastSeen) victim = k;
        }
        if (victim) {
          keys.delete(victim.fp);
          event('evict', { handle: victim.handle, fp: victim.fp.slice(0, 8), poolSize: keys.size });
          log('evicted', victim.handle, victim.fp.slice(0, 8));
        } else {
          return send(res, 503, { error: 'key pool full' });
        }
      }
      const rec = { fp, keyId, handle, publicKey, joinedAt: Date.now(), lastSeen: Date.now() };
      keys.set(fp, rec);
      saveKeys();
      event('key', { handle, fp: fp.slice(0, 8), poolSize: keys.size });
      broadcast({ t: 'key:add', key: { fp, handle, publicKey, joinedAt: rec.joinedAt } });
      log('key-add', handle, fp.slice(0, 8), `pool=${keys.size}`);
      return send(res, 200, { isNew: true, joinedAt: rec.joinedAt, poolSize: keys.size });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log('http-error', String(e.message));
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: (CFG.maxMsgBytes || 65536) + 8192 });
wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  if (!rateOk(ip, 'conns', (CFG.rate && CFG.rate.connsPerMin) || 40)) { ws.close(1008, 'rate'); return; }
  ws.isAlive = true;
  ws.__fp = null;
  const helloTimer = setTimeout(() => { if (!ws.__fp) ws.close(1008, 'no hello'); }, 10000);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      const fp = String(m.fp || '').toLowerCase();
      const handle = String(m.handle || '').toLowerCase();
      if (!keys.has(fp) || !HANDLE_RE.test(handle)) { ws.send(JSON.stringify({ t: 'err', msg: 'identify first' })); ws.close(1008, 'bad hello'); return; }
      clearTimeout(helloTimer);
      ws.__fp = fp;
      ws.__handle = handle;
      keys.get(fp).lastSeen = Date.now();
      saveKeys();
      joinRoom(ws, { fp, handle });
      ws.send(JSON.stringify({ t: 'welcome', you: { fp, handle, joinedAt: keys.get(fp).joinedAt }, online: presenceList(), poolSize: keys.size, serverTime: Date.now() }));
      return;
    }

    if (m.t === 'send') {
      if (!ws.__fp) return;
      if (!rateOk(ip, 'msgs', (CFG.rate && CFG.rate.msgsPerMin) || 25)) { ws.send(JSON.stringify({ t: 'err', msg: 'rate limit — slow down' })); return; }
      const ct = String(m.ct || '');
      if (!ct.startsWith(MSG_HEAD) || ct.length > (CFG.maxMsgBytes || 65536) || !ct.includes('END PGP MESSAGE')) {
        ws.send(JSON.stringify({ t: 'err', msg: 'bad ciphertext' })); return;
      }
      let recipients = Array.isArray(m.recipients) ? [...new Set(m.recipients.map(r => String(r).toLowerCase()).filter(r => FP_RE.test(r)))] : [];
      if (!recipients.includes(ws.__fp)) recipients.push(ws.__fp); // always readable by its author
      if (recipients.length > (CFG.maxRecipients || 500)) recipients = recipients.slice(0, CFG.maxRecipients || 500);
      const rec = {
        id: crypto.randomUUID(),
        seq: ++seq,
        t: Date.now(),
        fp: ws.__fp,
        handle: ws.__handle || keys.get(ws.__fp).handle,
        recipients,
        ct,
      };
      messages.push(rec);
      appendMessage(rec);
      // Tell the author first (same socket, so it has the tmpId->id map), then fan
      // out: the author's own copy carries tmpId so the client finalizes the
      // optimistic bubble instead of rendering a duplicate.
      const base = { id: rec.id, seq: rec.seq, t: rec.t, fp: rec.fp, handle: rec.handle, ct: rec.ct };
      const othersPayload = JSON.stringify({ t: 'msg', m: base });
      const selfPayload = JSON.stringify({ t: 'msg', m: { ...base, tmpId: m.tmpId || null } });
      for (const c of wss.clients) {
        if (!c.__fp || c.readyState !== 1) continue;
        try { c.send(c === ws ? selfPayload : othersPayload); } catch { /* ignore */ }
      }
      return;
    }

    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }
  });

  ws.on('close', () => { clearTimeout(helloTimer); leaveRoom(ws); });
  ws.on('error', () => { });
});

const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on('close', () => clearInterval(hb));

process.on('SIGTERM', () => { log('shutdown'); try { saveKeys(); } catch { } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });

load();
cleanup();
setInterval(() => { try { cleanup(); } catch (e) { log('cleanup-error', e.message); } }, CLEANUP_MS).unref();
server.listen(CFG.port || 8788, CFG.bind || '127.0.0.1', () => {
  log('listening', `${CFG.bind || '127.0.0.1'}:${CFG.port || 8788}`, PUBLIC_URL);
});
