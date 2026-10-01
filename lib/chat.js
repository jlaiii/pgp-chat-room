'use strict';
/*
 * Per-room key pools and ciphertext storage.
 *
 * Everything in this module treats message bodies as opaque strings. There is no
 * OpenPGP dependency and no decryption path — the process can store and route
 * ciphertext, nothing more.
 *
 * Layout:
 *   data/rooms/<roomId>/keys.json              { keys: [ {fp,keyId,handle,publicKey,...} ] }
 *   data/rooms/<roomId>/messages/<UTC-day>.jsonl   one ciphertext row per line
 */

const fs = require('node:fs');
const path = require('node:path');
const { FP_RE, KEYID_RE, HANDLE_RE, ARMOR_HEAD, MSG_HEAD, now, dayOf, readJson, readLines, secureErase, clampInt } = require('./util');

const MAX_MEM_MSG = 20000;

class Chat {
  constructor(dataDir, cfg = {}) {
    this.dataDir = dataDir;
    this.roomsDir = path.join(dataDir, 'rooms');
    this.maxPool = clampInt(cfg.maxPool, 10, 5000, 500);
    this.maxMsgBytes = clampInt(cfg.maxMsgBytes, 1024, 262144, 131072);
    this.maxRecipients = clampInt(cfg.maxRecipients, 2, 1000, 300);
    this.maxKeyBytes = clampInt(cfg.maxKeyBytes, 512, 65536, 8192);
    this.retentionMs = Math.max(0, Number(cfg.retentionHours != null ? cfg.retentionHours : 48)) * 3600000;
    this.historyLimit = clampInt(cfg.historyLimit, 10, 2000, 400);
    this.maxFileBytes = clampInt(cfg.maxFileBytes, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024);
    this.maxFilesPerRoom = clampInt(cfg.maxFilesPerRoom, 10, 100000, 2000);
    this.pools = new Map();     // roomId -> Map(fp -> key record)
    this.messages = new Map();  // roomId -> array of records
    this.seq = new Map();       // roomId -> int
    this.keySaveTimers = new Map();
  }

  /* ---------- paths ---------- */

  roomDir(roomId) { return path.join(this.roomsDir, safeRoom(roomId)); }
  keysFile(roomId) { return path.join(this.roomDir(roomId), 'keys.json'); }
  msgDir(roomId) { return path.join(this.roomDir(roomId), 'messages'); }
  segPath(roomId, day) { return path.join(this.msgDir(roomId), `${day}.jsonl`); }
  filesDir(roomId) { return path.join(this.roomDir(roomId), 'files'); }
  filePath(roomId, fileId) { return path.join(this.filesDir(roomId), `${safeFileId(fileId)}.bin`); }
  pool(roomId) { if (!this.pools.has(roomId)) this.pools.set(roomId, new Map()); return this.pools.get(roomId); }

  /* ---------- legacy layout -> per-room ---------- */

  // The single-room deployment kept data/keys.json + data/messages/*.jsonl.
  // Those become the lounge's, so existing handles keep working untouched.
  migrateLegacy(loungeId = 'lounge') {
    const legacyKeys = path.join(this.dataDir, 'keys.json');
    const legacyMsgs = path.join(this.dataDir, 'messages');
    const migrated = [];
    if (fs.existsSync(legacyKeys) && !fs.existsSync(this.keysFile(loungeId))) {
      fs.mkdirSync(this.roomDir(loungeId), { recursive: true });
      fs.renameSync(legacyKeys, this.keysFile(loungeId));
      migrated.push('keys');
    }
    if (fs.existsSync(legacyMsgs) && !fs.existsSync(this.msgDir(loungeId))) {
      fs.mkdirSync(this.roomDir(loungeId), { recursive: true });
      fs.renameSync(legacyMsgs, this.msgDir(loungeId));
      migrated.push('messages');
    }
    return migrated;
  }

  /* ---------- load / persist ---------- */

  // Prepare on-disk + in-memory state for a room that was just created.
  ensureRoom(roomId) {
    fs.mkdirSync(this.msgDir(roomId), { recursive: true });
    fs.mkdirSync(this.filesDir(roomId), { recursive: true });
    this.pool(roomId);
    if (!this.messages.has(roomId)) this.messages.set(roomId, []);
    if (!this.seq.has(roomId)) this.seq.set(roomId, 0);
    return { pool: this.poolSize(roomId) };
  }

  load(roomIds) {
    fs.mkdirSync(this.roomsDir, { recursive: true });
    const cutoff = now() - this.retentionMs;
    for (const roomId of roomIds) {
      fs.mkdirSync(this.msgDir(roomId), { recursive: true });
      const pool = this.pool(roomId);
      const raw = readJson(this.keysFile(roomId), { keys: [] });
      for (const k of raw.keys || []) {
        if (k && FP_RE.test(k.fp || '') && typeof k.publicKey === 'string') pool.set(k.fp, normalizeKey(k));
      }
      const rows = [];
      for (const f of this.segmentFiles(roomId)) {
        for (const line of readLines(path.join(this.msgDir(roomId), f))) {
          try {
            const m = JSON.parse(line);
            if (m && typeof m.ct === 'string' && Array.isArray(m.recipients) && m.t >= cutoff) rows.push(m);
          } catch { /* skip corrupt line */ }
        }
      }
      rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      this.messages.set(roomId, rows.length > MAX_MEM_MSG ? rows.slice(-MAX_MEM_MSG) : rows);
      this.seq.set(roomId, rows.reduce((a, m) => Math.max(a, m.seq || 0), 0));
    }
    return Object.fromEntries(roomIds.map(id => [id, { keys: this.pool(id).size, messages: (this.messages.get(id) || []).length }]));
  }

  // Persisted pool rows never carry the transient online flag: a restart reloads
  // every key as offline, which is what the eviction order should assume.
  poolJson(roomId) {
    return JSON.stringify({
      keys: [...this.pool(roomId).values()].map(({ online, ...k }) => k),
      savedAt: now(),
    }, null, 0);
  }

  saveKeys(roomId) {
    if (this.keySaveTimers.has(roomId)) return;
    const t = setTimeout(() => {
      this.keySaveTimers.delete(roomId);
      try {
        const file = this.keysFile(roomId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, this.poolJson(roomId));
        fs.renameSync(tmp, file);
      } catch { /* retried on the next change */ }
    }, 800);
    if (t.unref) t.unref();
    this.keySaveTimers.set(roomId, t);
  }

  saveAllKeys() { for (const roomId of this.pools.keys()) { try { this.flushKeys(roomId); } catch { /* ignore */ } } }
  flushKeys(roomId) {
    const file = this.keysFile(roomId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, this.poolJson(roomId));
    fs.renameSync(tmp, file);
  }

  /* ---------- key pool ---------- */

  segmentFiles(roomId) {
    try { return fs.readdirSync(this.msgDir(roomId)).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); }
    catch { return []; }
  }

  keys(roomId) {
    return [...this.pool(roomId).values()].map(k => ({ fp: k.fp, handle: k.handle, publicKey: k.publicKey, joinedAt: k.joinedAt }));
  }
  poolSize(roomId) { return this.pool(roomId).size; }
  hasKey(roomId, fp) { return this.pool(roomId).has(fp); }
  touchKey(roomId, fp) { const k = this.pool(roomId).get(fp); if (k) { k.lastSeen = now(); this.saveKeys(roomId); } }

  // Recipients must be keys this room actually knows: a sender cannot fan a
  // message out to fingerprints from somewhere else.
  allowedRecipients(roomId, list) {
    const pool = this.pool(roomId);
    return list.filter(fp => FP_RE.test(fp) && pool.has(fp)).slice(0, this.maxRecipients);
  }

  validateKey({ fp, keyId, handle, publicKey }) {
    if (!FP_RE.test(fp)) return 'bad fingerprint';
    if (!KEYID_RE.test(keyId)) return 'bad key id';
    if (!HANDLE_RE.test(handle)) return 'bad handle';
    if (typeof publicKey !== 'string' || !publicKey.startsWith(ARMOR_HEAD) || !publicKey.includes('END PGP PUBLIC KEY BLOCK')) return 'bad public key';
    if (publicKey.length > this.maxKeyBytes) return 'public key too large';
    if (publicKey.toUpperCase().includes('PRIVATE KEY')) return 'private key rejected';
    return null;
  }

  registerKey(roomId, { fp, keyId, handle, publicKey }) {
    const err = this.validateKey({ fp, keyId, handle, publicKey });
    if (err) return { error: err };
    const pool = this.pool(roomId);
    const existing = pool.get(fp);
    if (existing) {
      const renamed = existing.handle !== handle;
      const oldHandle = existing.handle;
      existing.lastSeen = now();
      existing.handle = handle;
      existing.keyId = keyId;
      this.saveKeys(roomId);
      return { isNew: false, joinedAt: existing.joinedAt, poolSize: pool.size, renamed, oldHandle };
    }
    if (pool.size >= this.maxPool) {
      let victim = null;
      for (const k of pool.values()) {
        if (k.online) continue;
        if (!victim || k.lastSeen < victim.lastSeen) victim = k;
      }
      if (!victim) return { error: 'key pool full' };
      pool.delete(victim.fp);
    }
    const rec = { fp, keyId, handle, publicKey, joinedAt: now(), lastSeen: now(), online: false };
    pool.set(fp, rec);
    this.saveKeys(roomId);
    return { isNew: true, joinedAt: rec.joinedAt, poolSize: pool.size };
  }

  markOnline(roomId, fp, online) {
    const k = this.pool(roomId).get(fp);
    if (k) { k.online = !!online; if (online) k.lastSeen = now(); }
  }

  /* ---------- messages ---------- */

  append(roomId, rec) {
    const file = this.segPath(roomId, dayOf(rec.t));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  }

  add(roomId, { fp, handle, ct, recipients, id }) {
    if (typeof ct !== 'string' || !ct.startsWith(MSG_HEAD) || !ct.includes('END PGP MESSAGE')) return { error: 'bad ciphertext' };
    if (ct.length > this.maxMsgBytes) return { error: 'ciphertext too large' };
    const allowed = this.allowedRecipients(roomId, recipients);
    if (!allowed.includes(fp)) allowed.push(fp);              // the author can always read their own message
    const rec = { id: id || require('node:crypto').randomUUID(), seq: (this.seq.get(roomId) || 0) + 1, t: now(), fp, handle, recipients: allowed, ct };
    this.seq.set(roomId, rec.seq);
    const list = this.messages.get(roomId) || [];
    list.push(rec);
    if (list.length > MAX_MEM_MSG) list.splice(0, list.length - MAX_MEM_MSG);
    this.messages.set(roomId, list);
    this.append(roomId, rec);
    return { message: rec };
  }

  history(roomId, fp, limit) {
    const pool = this.pool(roomId);
    const lim = clampInt(limit, 1, 2000, this.historyLimit);
    const mine = [];
    let locked = 0;
    for (const m of this.messages.get(roomId) || []) {
      if (m.recipients.includes(fp)) mine.push(m); else locked++;
    }
    const you = pool.get(fp);
    return {
      joinedAt: you ? you.joinedAt : null,
      poolSize: pool.size,
      lockedCount: locked,
      messages: mine.slice(-lim).map(m => ({ id: m.id, seq: m.seq, t: m.t, fp: m.fp, handle: m.handle, ct: m.ct })),
    };
  }

  /* ---------- attachments (sealed blobs) ---------- */

  // An attachment is opaque bytes: the browser encrypted it with a one-off AES-GCM key
  // which travels inside the room's OpenPGP message. Nothing here can open a file, and
  // the filename never reaches the server — only a size and a timestamp.
  addFile(roomId, { id, data }) {
    if (!data || !data.length) return { error: 'empty upload' };
    if (data.length > this.maxFileBytes) return { error: `file too large — the cap is ${Math.round(this.maxFileBytes / 1048576)} MB` };
    if (this.fileCount(roomId) >= this.maxFilesPerRoom) return { error: 'this room is holding too many files right now' };
    const dir = this.filesDir(roomId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.filePath(roomId, id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, file);
    return { id: safeFileId(id), size: data.length, at: now() };
  }

  hasFile(roomId, fileId) {
    try { return fs.statSync(this.filePath(roomId, fileId)).isFile(); } catch { return false; }
  }

  fileCount(roomId) {
    try { return fs.readdirSync(this.filesDir(roomId)).filter(f => f.endsWith('.bin')).length; } catch { return 0; }
  }

  fileStats(roomId) {
    let bytes = 0, count = 0;
    for (const f of safeReaddir(this.filesDir(roomId))) {
      if (!f.endsWith('.bin')) continue;
      try { bytes += fs.statSync(path.join(this.filesDir(roomId), f)).size; count += 1; } catch { /* raced away */ }
    }
    return { count, bytes };
  }

  /* ---------- retention is policy, not a constant ---------- */

  // Infinity (set from `retentionHours: null`) means keep everything until an admin
  // clears it by hand. Shortening the window takes effect on the next sweep, which
  // server.js triggers immediately after the change.
  setRetentionMs(ms) {
    this.retentionMs = ms;
    return this.retentionMs;
  }

  get retentionHours() {
    return Number.isFinite(this.retentionMs) ? this.retentionMs / 3600000 : null;
  }

  countFor(roomId) { return (this.messages.get(roomId) || []).length; }
  oldest(roomId) { const l = this.messages.get(roomId) || []; return l.length ? l[0].t : null; }

  /* ---------- retention: shred expired ciphertext ---------- */

  cleanup() {
    const cutoff = now() - this.retentionMs;
    let disk = 0, mem = 0, files = 0;
    const detail = [];
    for (const roomId of this.pools.keys()) {
      for (const f of this.segmentFiles(roomId)) {
        const full = this.segPath(roomId, f.slice(0, 10));
        const endOfDay = Date.parse(`${f.slice(0, 10)}T23:59:59.999Z`);
        if (endOfDay < cutoff) { if (secureErase(full)) disk += 1; continue; }
        const lines = readLines(full);
        const kept = [];
        for (const line of lines) {
          try { if (JSON.parse(line).t >= cutoff) kept.push(line); } catch { /* drop corrupt */ }
        }
        if (kept.length !== lines.length) {
          disk += lines.length - kept.length;
          const tmp = `${full}.tmp`;
          fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
          const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
          secureErase(full);
          fs.renameSync(tmp, full);
        }
      }
      // Attachments ride the same window as the rows that point at them.
      const fdir = this.filesDir(roomId);
      for (const f of safeReaddir(fdir)) {
        if (!f.endsWith('.bin')) continue;
        const full = path.join(fdir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        if (mtime < cutoff && secureErase(full)) files += 1;
      }
      const list = this.messages.get(roomId) || [];
      const survivors = list.filter(m => m.t >= cutoff);
      if (survivors.length !== list.length) {
        mem += list.length - survivors.length;
        this.messages.set(roomId, survivors);
      }
      if (disk || mem) detail.push(`${roomId}:disk=${disk},mem=${mem}`);
    }
    return { expiredDisk: disk, expiredMemory: mem, expiredFiles: files, detail };
  }

  // "Burn this room now": the admin panel's instant version of the retention sweep.
  // Same shredding, no waiting for the window — ciphertext gone from disk and memory.
  purge(roomId) {
    let rows = 0, files = 0;
    for (const f of this.segmentFiles(roomId)) {
      const full = this.segPath(roomId, f.slice(0, 10));
      rows += readLines(full).length;
      if (secureErase(full)) { files += 1; try { fs.writeFileSync(full, ''); } catch { /* recreated on next append */ } }
    }
    let blobs = 0;
    const fdir = this.filesDir(roomId);
    for (const f of safeReaddir(fdir)) {
      if (f.endsWith('.bin') && secureErase(path.join(fdir, f))) blobs += 1;
    }
    const had = (this.messages.get(roomId) || []).length;
    this.messages.set(roomId, []);
    return { purgedRows: rows, purgedFiles: files, purgedBlobs: blobs, clearedMemory: had };
  }

  // A deleted room takes its pool and its ciphertext with it.
  dropRoom(roomId) {
    const dir = this.roomDir(roomId);
    try {
      for (const f of this.segmentFiles(roomId)) secureErase(this.segPath(roomId, f.slice(0, 10)));
      const kf = this.keysFile(roomId);
      if (fs.existsSync(kf)) secureErase(kf);
      for (const extra of safeReaddir(dir)) {
        const p = path.join(dir, extra);
        try {
          if (fs.statSync(p).isDirectory()) { for (const f of safeReaddir(p)) secureErase(path.join(p, f)); fs.rmdirSync(p); }
          else secureErase(p);
        } catch { /* best effort */ }
      }
      fs.rmdirSync(dir);
    } catch { /* already gone */ }
    this.pools.delete(roomId);
    this.messages.delete(roomId);
    this.seq.delete(roomId);
  }

  stats() {
    let keys = 0, messages = 0;
    for (const p of this.pools.values()) keys += p.size;
    for (const l of this.messages.values()) messages += l.length;
    return { keys, messages, rooms: this.pools.size };
  }

  // Per-room picture for the admin panel: rows, keys, attachments and bytes on disk.
  roomStats(roomId) {
    const f = this.fileStats(roomId);
    return { messages: this.countFor(roomId), keys: this.poolSize(roomId), files: f.count, fileBytes: f.bytes };
  }
}

function safeReaddir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function safeRoom(id) { return String(id).replace(/[^a-z0-9-]/g, '').slice(0, 32); }
function safeFileId(id) { return String(id).replace(/[^a-z0-9]/g, '').slice(0, 32); }
function normalizeKey(k) {
  return { fp: k.fp, keyId: k.keyId || '', handle: k.handle || 'unknown', publicKey: k.publicKey, joinedAt: k.joinedAt || now(), lastSeen: k.lastSeen || now(), online: false };
}

module.exports = { Chat };
