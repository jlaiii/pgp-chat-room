'use strict';
/*
 * Accounts, sessions, roles and bans.
 *
 * Identity here is *metadata only*. A password authenticates a person to the
 * relay; it never keys message encryption. The "sync my key" blob (on by
 * default) is wrapped in the browser with a password-derived key, so the server
 * stores an opaque envelope it holds no way to open. `syncOptOut` remembers a
 * user's explicit "no", so a later sign-in does not quietly re-upload.
 *
 * Password hashing uses scrypt from node:crypto (no OpenPGP, no new dependency).
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, readJson, now, token, clampInt, USERNAME_RE } = require('./util');
const { isValidFx } = require('./effects');

const ROLES = ['guest', 'user', 'mod', 'admin', 'developer'];
const RANK = { guest: 0, user: 1, mod: 2, admin: 3, developer: 4 };

const SESSION_TTL_MS = 30 * 24 * 3600e3;   // logins survive restarts
const SCRYPT_N_DEFAULT = 16384;            // ~100ms; tests lower it via config
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(password, salt, N) {
  return crypto.scryptSync(String(password), salt, KEYLEN, { N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 }).toString('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class Auth {
  constructor(dataDir, cfg = {}) {
    this.dir = dataDir;
    this.accountsFile = path.join(dataDir, 'accounts.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.bansFile = path.join(dataDir, 'bans.json');
    this.scryptN = clampInt(cfg.scryptN, 1024, 1 << 20, SCRYPT_N_DEFAULT);
    this.accounts = new Map();   // username -> record
    this.sessions = new Map();   // token -> record
    this.bans = [];              // ban records
    this.saveTimer = null;
  }

  /* ---------- persistence ---------- */

  load() {
    const a = readJson(this.accountsFile, { accounts: [] });
    let migrated = 0;
    for (const rec of a.accounts || []) {
      if (!rec || !USERNAME_RE.test(rec.username || '')) continue;
      // Older records: the boolean `rainbow` became an entry in the effect list
      // (`fx`), and accounts gained an explicit "may pick their own effect" switch.
      if (rec.rainbow !== undefined) {
        if (rec.rainbow && !rec.fx) rec.fx = 'rainbow';
        delete rec.rainbow;
        migrated++;
      }
      if (rec.fx === undefined) rec.fx = null;
      if (rec.fxAllowed === undefined) rec.fxAllowed = false;
      if (rec.frozen === undefined) rec.frozen = false;
      this.accounts.set(rec.username, rec);
    }
    const s = readJson(this.sessionsFile, { sessions: [] });
    const cutoff = now();
    for (const rec of s.sessions || []) if (rec && rec.token && rec.expiresAt > cutoff) this.sessions.set(rec.token, rec);
    const b = readJson(this.bansFile, { bans: [] });
    this.bans = (b.bans || []).filter(x => x && typeof x.target === 'string');
    if (migrated) this.saveNow();
    return { accounts: this.accounts.size, sessions: this.sessions.size, bans: this.bans.length };
  }

  saveNow() {
    atomicWrite(this.accountsFile, JSON.stringify({ accounts: [...this.accounts.values()], savedAt: now() }));
    atomicWrite(this.sessionsFile, JSON.stringify({ sessions: [...this.sessions.values()], savedAt: now() }));
    atomicWrite(this.bansFile, JSON.stringify({ bans: this.bans, savedAt: now() }));
  }

  // Durability split: identity and moderation changes are written through immediately
  // (a lost ban or a lost account is unacceptable), while high-frequency touch
  // traffic — lastSeen, key bindings — rides the debounce.
  save() {                       // debounced: bursts of lastSeen writes cost one write
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.saveNow(); } catch { /* retried on next change */ } }, 800);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /* ---------- accounts ---------- */

  hasAdmin() { for (const a of this.accounts.values()) if ((RANK[a.role] ?? -1) >= RANK.admin) return true; return false; }
  count() { return this.accounts.size; }
  get(username) { return this.accounts.get(String(username || '').toLowerCase()) || null; }
  list() {
    const sessionCounts = new Map();
    for (const s of this.sessions.values()) {
      if (s.kind === 'account' && s.username) sessionCounts.set(s.username, (sessionCounts.get(s.username) || 0) + 1);
    }
    return [...this.accounts.values()]
      .map(a => ({
        username: a.username, role: a.role, createdAt: a.createdAt, lastLogin: a.lastLogin || null,
        keyFp: a.keyFp || null, syncKey: !!(a.syncKey && a.syncKey.enabled), fx: a.fx || null, fxAllowed: !!a.fxAllowed,
        frozen: !!a.frozen,
        sessions: sessionCounts.get(a.username) || 0,
        ban: this.activeBan({ kind: 'account', target: a.username }),
      }))
      .sort((x, y) => x.username.localeCompare(y.username));
  }

  // Cosmetic name effects. Managed by the developer (or self-picked with
  // permission); they never touch message crypto — a rendering hint the clients
  // agree on through the fx map.
  setFx(username, fx) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    if (!isValidFx(fx === undefined ? null : fx)) return { error: 'bad effect' };
    rec.fx = fx || null;
    this.saveNow();
    return { account: rec };
  }

  setFxAllowed(username, allowed) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    rec.fxAllowed = !!allowed;
    this.saveNow();
    return { account: rec };
  }

  fxMap() {
    const out = {};
    for (const a of this.accounts.values()) if (a.fx) out[a.username] = a.fx;
    return out;
  }

  // Deleting an account is the one moderation action that cannot be undone, so the
  // caller (server.js) is expected to have checked rank and target first.
  deleteAccount(username) {
    const name = String(username || '').toLowerCase();
    const rec = this.accounts.get(name);
    if (!rec) return { error: 'no such account' };
    this.accounts.delete(name);
    this.bans = this.bans.filter(b => !(b.kind === 'account' && b.target === name));
    let dropped = 0;
    for (const [k, s] of [...this.sessions]) if (s.kind === 'account' && s.username === name) { this.sessions.delete(k); dropped++; }
    this.saveNow();
    return { account: rec, sessionsDropped: dropped };
  }

  createAccount(username, password, role = 'user') {
    const name = String(username || '').toLowerCase();
    if (!USERNAME_RE.test(name)) return { error: 'username must be 2-24 chars: a-z, 0-9, _ or -' };
    if (this.accounts.has(name)) return { error: 'that username is taken' };
    const pwErr = checkPasswordStrength(password);
    if (pwErr) return { error: pwErr };
    if (!ROLES.includes(role) || role === 'guest') return { error: 'bad role' };
    const salt = crypto.randomBytes(16).toString('hex');
    const rec = {
      username: name, salt, hash: hashPassword(password, salt, this.scryptN), scryptN: this.scryptN,
      role, fx: null, fxAllowed: false, frozen: false, createdAt: now(), lastLogin: null, keyFp: null, syncKey: null, syncOptOut: false,
    };
    this.accounts.set(name, rec);
    this.saveNow();
    return { account: rec };
  }

  verify(username, password) {
    const rec = this.get(username);
    if (!rec) {                                  // equalise timing for unknown users
      crypto.scryptSync(String(password), 'nosuchsalt000000', KEYLEN, { N: this.scryptN, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 });
      return null;
    }
    const candidate = hashPassword(password, rec.salt, rec.scryptN || this.scryptN);
    if (!safeEqualHex(candidate, rec.hash)) return null;
    return rec;
  }

  setPassword(username, password) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    const pwErr = checkPasswordStrength(password);
    if (pwErr) return { error: pwErr };
    rec.salt = crypto.randomBytes(16).toString('hex');
    rec.scryptN = this.scryptN;
    rec.hash = hashPassword(password, rec.salt, rec.scryptN);
    this.saveNow();
    return { ok: true };
  }

  setRole(username, role) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    if (!ROLES.includes(role) || role === 'guest') return { error: 'bad role' };
    rec.role = role;
    this.saveNow();
    return { account: rec };
  }

  // Freeze: a locked account. Sign-in is refused and every session is dropped
  // until it is unfrozen; keys, history and room memberships stay untouched.
  // Distinct from a ban, which blocks rooms but not the sign-in itself.
  setFrozen(username, on) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    rec.frozen = !!on;
    const dropped = on ? this.dropSessionsFor(username) : 0;
    this.saveNow();
    return { account: rec, sessionsDropped: dropped };
  }

  setSyncKey(username, enabled, blob) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    // Turning sync off is a choice, not a default: remember it, or the next
    // sign-in would quietly re-upload this device's key and flip the switch back.
    if (!enabled) { rec.syncKey = null; rec.syncOptOut = true; }
    else {
      if (typeof blob !== 'string' || blob.length < 32 || blob.length > 65536) return { error: 'bad key blob' };
      rec.syncKey = { enabled: true, blob, updatedAt: now() };
      rec.syncOptOut = false;
    }
    this.saveNow();
    return {
      syncKey: rec.syncKey ? { enabled: true, updatedAt: rec.syncKey.updatedAt } : { enabled: false },
      syncOptOut: !!rec.syncOptOut,
    };
  }

  // The account's public key is bound alongside its fingerprint the first time the
  // key joins any room. DMs encrypt to this stored copy, so it is only ever written
  // together with the fingerprint it belongs to — a restored backup that re-keys
  // the account replaces both in one step, never one without the other.
  bindKey(username, fp, key = {}) {
    const rec = this.get(username);
    if (!rec) return { error: 'no such account' };
    const nextFp = fp || null;
    const pub = typeof key.publicKey === 'string' && key.publicKey.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----') ? key.publicKey : null;
    if (rec.keyFp === nextFp && rec.keyPub && !pub) return { ok: true, unchanged: true };
    rec.keyFp = nextFp;
    if (pub) { rec.keyPub = pub; rec.keyId = key.keyId || null; }
    if (!nextFp) { rec.keyPub = null; rec.keyId = null; }
    this.save();
    return { ok: true };
  }

  /* ---------- sessions ---------- */

  createSession({ kind, username = null, handle = null, role, fp = null, ip = null }) {
    const rec = {
      token: token(), kind, username, handle, role, fp, ip,
      createdAt: now(), lastSeen: now(), expiresAt: now() + SESSION_TTL_MS,
    };
    this.sessions.set(rec.token, rec);
    this.saveNow();
    return rec;
  }

  // A session always resolves its subject's *current* role, so a demotion or a
  // promotion applies to live connections instead of waiting for a re-login.
  resolve(session) {
    if (!session) return null;
    if (session.expiresAt <= now()) { this.sessions.delete(session.token); this.save(); return null; }
    if (session.kind === 'account') {
      const acc = this.get(session.username);
      if (!acc) return null;
      session.role = acc.role;
      session.handle = acc.username;
    }
    return session;
  }

  touch(session) {
    session.lastSeen = now();
    const all = [...this.sessions.values()];
    // roll the expiry for the ones actually in use
    session.expiresAt = Math.max(session.expiresAt, now() + SESSION_TTL_MS);
    this.save();
    return all.length;
  }

  destroySession(token) { const had = this.sessions.delete(token); if (had) this.saveNow(); return had; }
  sessionCount() { return this.sessions.size; }
  prune() {
    const t = now();
    let n = 0;
    for (const [k, s] of this.sessions) if (s.expiresAt <= t) { this.sessions.delete(k); n++; }
    if (n) this.save();
    return n;
  }
  // Sessions of a username, minus one token (used when changing a password)
  dropSessionsFor(username, keepToken = null) {
    let n = 0;
    for (const [k, s] of [...this.sessions]) {
      if (s.kind === 'account' && s.username === username && k !== keepToken) { this.sessions.delete(k); n++; }
    }
    if (n) this.save();
    return n;
  }

  /* ---------- bans ---------- */

  // kind: 'account' | 'fp' | 'ip'. room: null = site-wide; otherwise scoped to a room.
  // `mute: true` is a post-block that still lets the target read (a timeout).
  addBan({ kind, target, room = null, until = null, reason = '', by = 'system', mute = false }) {
    const t = String(target || '').toLowerCase();
    if (!t) return { error: 'no target' };
    if (kind !== 'account' && kind !== 'fp' && kind !== 'ip') return { error: 'bad ban kind' };
    if (kind === 'account' && !USERNAME_RE.test(t)) return { error: 'bad username' };
    if (kind === 'ip' && !/^[0-9a-f.:]{3,45}$/.test(t)) return { error: 'bad address' };
    this.bans = this.bans.filter(b => !(b.kind === kind && b.target === t && b.room === room && !!b.mute === !!mute));  // replace, don't stack
    const rec = { id: crypto.randomUUID(), kind, target: t, room, until, mute: !!mute, reason: String(reason || '').slice(0, 200), by, at: now() };
    this.bans.push(rec);
    // a banned account's live sockets get dropped by the server layer; a mute does not
    if (kind === 'account' && !mute) this.dropSessionsFor(t);
    this.saveNow();
    return { ban: rec };
  }

  liftBan({ id = null, kind = null, target = null, room = undefined }) {
    const before = this.bans.length;
    this.bans = this.bans.filter(b => {
      if (id) return b.id !== id;
      if (kind && target) return !(b.kind === kind && b.target === String(target).toLowerCase() && (room === undefined || b.room === room));
      return true;
    });
    const removed = before - this.bans.length;
    if (removed) this.saveNow();
    return { removed };
  }

  // Active = not expired. Expired rows are pruned lazily here.
  activeBan({ kind, target, room = null }) {
    const t = String(target || '').toLowerCase();
    const time = now();
    let hit = null;
    for (const b of this.bans) {
      if (b.until != null && b.until <= time) continue;              // expired
      if (b.kind !== kind || b.target !== t) continue;
      if (b.room && room && b.room !== room) continue;               // room-scoped ban for a different room
      if (b.room && !room) hit = hit || b;                           // room ban: only blocks that room
      else hit = hit || b;
    }
    return hit;
  }

  activeBans() {
    const time = now();
    return this.bans.filter(b => b.until == null || b.until > time)
      .map(b => ({ ...b, temporary: b.until != null, untilISO: b.until ? new Date(b.until).toISOString() : null }));
  }

  // The admin panel's "lift every ban" button — nothing else clears the whole list.
  clearBans() {
    const removed = this.bans.length;
    this.bans = [];
    if (removed) this.saveNow();
    return { removed };
  }

  // Has this identity been banned from this room (or site-wide)? `forPost` switches the
  // question to "may this identity post": a mute is a post-block that still lets them in.
  banFor({ username = null, fp = null, ip = null, room = null, forPost = false }) {
    const candidates = [];
    if (username) candidates.push({ kind: 'account', target: username });
    if (fp) candidates.push({ kind: 'fp', target: fp });
    if (ip) candidates.push({ kind: 'ip', target: String(ip).toLowerCase() });
    for (const c of candidates) {
      for (const b of this.bans) {
        if (b.until != null && b.until <= now()) continue;
        if (b.kind !== c.kind || b.target !== c.target) continue;
        if (b.room && b.room !== room) continue;
        if (b.mute && !forPost) continue;                 // muted: read yes, post no
        return b;                                         // site-wide or this room
      }
    }
    return null;
  }

  /* ---------- live sessions (the admin panel's session manager) ---------- */

  // Tokens are secrets, so the panel gets a short hash instead: revoke by that id.
  static sessionId(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12); }

  listSessions() {
    const t = now();
    return [...this.sessions.values()]
      .filter(s => s.expiresAt > t)
      .map(s => ({
        id: Auth.sessionId(s.token), kind: s.kind, username: s.username || null, handle: s.handle || null,
        role: s.role || null, fp: s.fp || null, ip: s.ip || null,
        createdAt: s.createdAt, lastSeen: s.lastSeen, expiresAt: s.expiresAt,
      }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  revokeSession(id) {
    const want = String(id || '').toLowerCase();
    for (const [tok, s] of [...this.sessions]) {
      if (Auth.sessionId(tok) === want) { this.sessions.delete(tok); this.saveNow(); return { session: s }; }
    }
    return { error: 'no such session' };
  }

  roleRank(role) { return RANK[role] ?? -1; }
}

function checkPasswordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'password must be at least 8 characters';
  if (s.length > 200) return 'password too long';
  if (/^\d+$/.test(s)) return 'password cannot be only digits';
  if (/^(password|letmein|qwerty|12345678)/i.test(s)) return 'password too common';
  return null;
}

module.exports = { Auth, ROLES, RANK, checkPasswordStrength, SESSION_TTL_MS };
