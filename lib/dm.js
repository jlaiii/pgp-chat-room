'use strict';
/*
 * Direct messages — a per-pair ciphertext store, the same shape as rooms.
 *
 *   data/dms/<a>__<b>/messages/<UTC-day>.jsonl   rows { id, seq, t, from, ct }
 *   data/dms/<a>__<b>/meta.json                  { read: { user: ts } }
 *   data/dms/<a>__<b>/files/<id>.bin             sealed blobs (voice, pictures, files)
 *
 * Every row is sealed by the sender to *both* participants' PGP keys, so the pair
 * shares one timeline and there is no per-row recipient list to enforce — being one
 * of the two names in the pair id is the whole access rule, and that is checked in
 * server.js on both sides of the wire.
 *
 * The process stores and routes ciphertext; there is no key and no decryption path
 * here either. Pair reads are honest about read marks (server-side unread counts),
 * so both devices agree on what has been seen.
 */

const fs = require('node:fs');
const path = require('node:path');
const { MSG_HEAD, now, dayOf, readJson, readLines, secureErase, clampInt, uuid } = require('./util');

const MAX_MEM_MSG = 20000;

class DM {
  constructor(dataDir, cfg = {}) {
    this.dmsDir = path.join(dataDir, 'dms');
    this.maxMsgBytes = clampInt(cfg.maxMsgBytes, 1024, 262144, 131072);
    this.maxFileBytes = clampInt(cfg.maxFileBytes, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024);
    this.maxFilesPerPair = clampInt(cfg.maxFilesPerPair, 10, 100000, 2000);
    this.retentionMs = Math.max(0, Number(cfg.retentionHours != null ? cfg.retentionHours : 48)) * 3600000;
    this.historyLimit = clampInt(cfg.historyLimit, 10, 2000, 400);
    this.pairs = new Map();   // pairId -> { a, b, seq, messages: [] }
  }

  /* ---------- paths ---------- */

  // Usernames are [a-z0-9_-] by USERNAME_RE, so they are filesystem-safe as-is.
  pairId(a, b) { return [a, b].sort().join('__'); }
  pairDir(a, b) { return path.join(this.dmsDir, this.pairId(a, b)); }
  msgDir(a, b) { return path.join(this.pairDir(a, b), 'messages'); }
  segPath(a, b, day) { return path.join(this.msgDir(a, b), `${day}.jsonl`); }
  filesDir(a, b) { return path.join(this.pairDir(a, b), 'files'); }
  filePath(a, b, fileId) { return path.join(this.filesDir(a, b), `${safeFileId(fileId)}.bin`); }
  metaPath(a, b) { return path.join(this.pairDir(a, b), 'meta.json'); }

  segments(a, b) {
    try { return fs.readdirSync(this.msgDir(a, b)).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); }
    catch { return []; }
  }

  /* ---------- load ---------- */

  ensure(a, b) {
    const id = this.pairId(a, b);
    let rec = this.pairs.get(id);
    if (rec) return rec;
    fs.mkdirSync(this.msgDir(a, b), { recursive: true });
    fs.mkdirSync(this.filesDir(a, b), { recursive: true });
    const [x, y] = [a, b].sort();
    rec = { a: x, b: y, seq: 0, messages: [] };
    const cutoff = now() - this.retentionMs;
    const rows = [];
    for (const f of this.segments(a, b)) {
      for (const line of readLines(this.segPath(a, b, f.slice(0, 10)))) {
        try {
          const m = JSON.parse(line);
          if (m && typeof m.ct === 'string' && m.t >= cutoff) rows.push(m);
        } catch { /* skip corrupt line */ }
      }
    }
    rows.sort((p, q) => (p.seq || 0) - (q.seq || 0));
    rec.messages = rows.length > MAX_MEM_MSG ? rows.slice(-MAX_MEM_MSG) : rows;
    rec.seq = rows.reduce((acc, m) => Math.max(acc, m.seq || 0), 0);
    this.pairs.set(id, rec);
    return rec;
  }

  // Boot-time scan: load every pair dir on disk so the retention sweeper sees them.
  load() {
    let names = [];
    try { names = fs.readdirSync(this.dmsDir).filter(f => f.includes('__')); } catch { /* none yet */ }
    for (const f of names) {
      const [a, b] = f.split('__');
      if (a && b) this.ensure(a, b);
    }
    return { pairs: this.pairs.size };
  }

  /* ---------- messages ---------- */

  append(a, b, rec) {
    const file = this.segPath(a, b, dayOf(rec.t));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  }

  add(a, b, { from, ct }) {
    if (typeof ct !== 'string' || !ct.startsWith(MSG_HEAD) || !ct.includes('END PGP MESSAGE')) return { error: 'bad ciphertext' };
    if (ct.length > this.maxMsgBytes) return { error: 'ciphertext too large' };
    const pair = this.ensure(a, b);
    const rec = { id: uuid(), seq: pair.seq + 1, t: now(), from, ct };
    pair.seq = rec.seq;
    pair.messages.push(rec);
    if (pair.messages.length > MAX_MEM_MSG) pair.messages.splice(0, pair.messages.length - MAX_MEM_MSG);
    this.append(a, b, rec);
    return { message: rec };
  }

  history(a, b, limit) {
    const rec = this.ensure(a, b);
    const lim = clampInt(limit, 1, 2000, this.historyLimit);
    const meta = readJson(this.metaPath(a, b), { read: {} });
    return {
      read: meta.read || {},
      messages: rec.messages.slice(-lim).map(m => ({ id: m.id, seq: m.seq, t: m.t, from: m.from, ct: m.ct })),
    };
  }

  markRead(a, b, who) {
    const meta = readJson(this.metaPath(a, b), { read: {} });
    meta.read = meta.read || {};
    meta.read[who] = now();
    fs.mkdirSync(this.pairDir(a, b), { recursive: true });
    const tmp = `${this.metaPath(a, b)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, this.metaPath(a, b));
    return { ok: true };
  }

  unreadFor(a, b, who) {
    const rec = this.ensure(a, b);
    const meta = readJson(this.metaPath(a, b), { read: {} });
    const since = (meta.read || {})[who] || 0;
    let n = 0;
    for (const m of rec.messages) if (m.from !== who && m.t > since) n += 1;
    return n;
  }

  lastFrom(a, b, who) {
    const rec = this.ensure(a, b);
    for (let i = rec.messages.length - 1; i >= 0; i--) if (rec.messages[i].from === who) return rec.messages[i].t;
    return null;
  }

  lastTs(a, b) {
    const rec = this.ensure(a, b);
    return rec.messages.length ? rec.messages[rec.messages.length - 1].t : null;
  }

  /* ---------- attachments (sealed blobs, same contract as rooms) ---------- */

  addFile(a, b, { id, data }) {
    if (!data || !data.length) return { error: 'empty upload' };
    if (data.length > this.maxFileBytes) return { error: `file too large — the cap is ${Math.round(this.maxFileBytes / 1048576)} MB` };
    if (this.fileCount(a, b) >= this.maxFilesPerPair) return { error: 'this conversation is holding too many files right now' };
    const dir = this.filesDir(a, b);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.filePath(a, b, id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, file);
    return { id: safeFileId(id), size: data.length, at: now() };
  }

  hasFile(a, b, fileId) {
    try { return fs.statSync(this.filePath(a, b, fileId)).isFile(); } catch { return false; }
  }

  fileCount(a, b) {
    try { return fs.readdirSync(this.filesDir(a, b)).filter(f => f.endsWith('.bin')).length; } catch { return 0; }
  }

  /* ---------- retention ---------- */

  setRetentionMs(ms) { this.retentionMs = ms; return this.retentionMs; }

  cleanup() {
    const cutoff = now() - this.retentionMs;
    let disk = 0, mem = 0, files = 0;
    for (const rec of this.pairs.values()) {
      for (const f of this.segments(rec.a, rec.b)) {
        const full = this.segPath(rec.a, rec.b, f.slice(0, 10));
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
      const fdir = this.filesDir(rec.a, rec.b);
      for (const f of safeReaddir(fdir)) {
        if (!f.endsWith('.bin')) continue;
        const full = path.join(fdir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        if (mtime < cutoff && secureErase(full)) files += 1;
      }
      const survivors = rec.messages.filter(m => m.t >= cutoff);
      if (survivors.length !== rec.messages.length) {
        mem += rec.messages.length - survivors.length;
        rec.messages = survivors;
      }
    }
    return { expiredDisk: disk, expiredMemory: mem, expiredFiles: files };
  }

  // Deleting an account takes its conversations with it — rows, marks, blobs.
  // The caller (an admin op) gets the counts so the audit can say what happened
  // without ever naming a message.
  dropUser(u) {
    let pairs = 0, messages = 0, files = 0;
    for (const [id, rec] of [...this.pairs]) {
      if (rec.a !== u && rec.b !== u) continue;
      messages += (rec.messages || []).length;
      for (const f of this.segments(rec.a, rec.b)) secureErase(this.segPath(rec.a, rec.b, f.slice(0, 10)));
      const kf = this.metaPath(rec.a, rec.b);
      if (fs.existsSync(kf)) secureErase(kf);
      const dir = this.pairDir(rec.a, rec.b);
      for (const extra of safeReaddir(dir)) {
        const p = path.join(dir, extra);
        try {
          if (fs.statSync(p).isDirectory()) { for (const f of safeReaddir(p)) { if (secureErase(path.join(p, f))) files += 1; } fs.rmdirSync(p); }
          else secureErase(p);
        } catch { /* best effort */ }
      }
      try { fs.rmdirSync(dir); } catch { /* best effort */ }
      this.pairs.delete(id);
      pairs += 1;
    }
    return { pairs, messages, files };
  }

  stats() {
    let messages = 0, files = 0, bytes = 0;
    for (const rec of this.pairs.values()) {
      messages += rec.messages.length;
      for (const f of safeReaddir(this.filesDir(rec.a, rec.b))) {
        if (!f.endsWith('.bin')) continue;
        try { bytes += fs.statSync(path.join(this.filesDir(rec.a, rec.b), f)).size; files += 1; } catch { /* raced away */ }
      }
    }
    return { pairs: this.pairs.size, messages, files, fileBytes: bytes };
  }
}

function safeReaddir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function safeFileId(id) { return String(id).replace(/[^a-z0-9]/g, '').slice(0, 32); }

module.exports = { DM };
