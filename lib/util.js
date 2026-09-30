'use strict';
/*
 * Shared primitives: atomic JSON persistence, secure erase, cookies, ids.
 *
 * Nothing here touches message crypto — this module must stay usable by a
 * process that holds no keys and cannot decrypt anything.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FP_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KEYID_RE = /^[a-f0-9]{8,16}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;
const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ARMOR_HEAD = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const MSG_HEAD = '-----BEGIN PGP MESSAGE-----';

function now() { return Date.now(); }

/* ---------- persistence ---------- */

// write -> fsync -> rename, so a crash mid-write can never leave a torn file
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

// Best-effort secure erase used for expired ciphertext. On journalled/CoW storage
// this is not a forensic guarantee; the real guarantee is that the bytes are
// ciphertext whose keys only ever existed in browsers.
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
    return true;
  } catch { return false; }
}

/* ---------- time / ids ---------- */

function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function uuid() { return crypto.randomUUID(); }
function token() { return crypto.randomBytes(32).toString('hex'); }

// Human-typable one-time code: no 0/O/1/I/L confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function setupCode(len = 8) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function slugify(s, fallback = 'room') {
  const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return ROOM_ID_RE.test(base) ? base : fallback;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

const ADJ = ['quiet', 'swift', 'amber', 'lucid', 'brave', 'calm', 'clever', 'cosmic', 'crimson', 'dapper', 'eager', 'faded', 'gentle', 'hidden', 'idle', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'noble', 'olive', 'plain', 'prime', 'rapid', 'rustic', 'silent', 'solar', 'steady', 'tidal', 'tiny', 'vivid', 'wilder', 'wired', 'woven', 'zesty', 'bold', 'cobalt', 'dusty', 'electric'];
const ANIMALS = ['otter', 'falcon', 'lynx', 'heron', 'badger', 'beaver', 'cobra', 'condor', 'crane', 'dolphin', 'eagle', 'egret', 'ferret', 'finch', 'fox', 'gazelle', 'gecko', 'gibbon', 'hare', 'hawk', 'ibex', 'jackal', 'koala', 'lemur', 'marlin', 'mink', 'moose', 'moth', 'newt', 'ocelot', 'osprey', 'panda', 'quail', 'raven', 'salmon', 'sparrow', 'tapir', 'tern', 'viper', 'wolf'];
function randomHandle() {
  const a = ADJ[crypto.randomBytes(2).readUInt16BE(0) % ADJ.length];
  const b = ANIMALS[crypto.randomBytes(2).readUInt16BE(0) % ANIMALS.length];
  return `${a}-${b}-${10 + (crypto.randomBytes(1)[0] % 90)}`;
}

/* ---------- cookies ---------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return bits.join('; ');
}

// Cookie-auth state changes are same-origin only. Browsers always send Origin on
// cross-site POSTs, so a mismatch is a CSRF attempt; a missing Origin (curl, tests,
// same-origin GET navigations) is allowed.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '');
    return u.host === host;
  } catch { return false; }
}

module.exports = {
  FP_RE, KEYID_RE, HANDLE_RE, USERNAME_RE, ROOM_ID_RE, ARMOR_HEAD, MSG_HEAD,
  now, atomicWrite, readJson, readLines, secureErase,
  dayOf, uuid, token, setupCode, slugify, clampInt, randomHandle,
  parseCookies, serializeCookie, originAllowed,
};
