'use strict';
/*
 * Friends, requests and blocks — the social list, not message crypto.
 *
 * Everything is keyed by username and lives in data/social.json:
 *   { friends: { user: [user, ...] }, requests: [ { from, to, ts } ], blocked: { user: [user] } }
 *
 * Friendship is symmetric (both lists get the name); a request is one-way until
 * it is accepted. A block is one-way and silent: the blocked user is never told,
 * they simply cannot reach the blocker — and the block also severs any friendship
 * or pending request, because "blocked but still friends" is a state that would
 * only ever surprise somebody.
 */

const path = require('node:path');
const { atomicWrite, readJson, now } = require('./util');

class Social {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'social.json');
    this.data = { friends: {}, requests: [], blocked: {} };
  }

  load() {
    const raw = readJson(this.file, null);
    if (raw && typeof raw === 'object') {
      const friends = {};
      const blocked = {};
      for (const [u, list] of Object.entries(raw.friends || {})) {
        if (Array.isArray(list)) friends[u] = [...new Set(list.map(x => String(x).toLowerCase()))];
      }
      for (const [u, list] of Object.entries(raw.blocked || {})) {
        if (Array.isArray(list)) blocked[u] = [...new Set(list.map(x => String(x).toLowerCase()))];
      }
      const requests = Array.isArray(raw.requests)
        ? raw.requests.filter(r => r && r.from && r.to).map(r => ({ from: String(r.from).toLowerCase(), to: String(r.to).toLowerCase(), ts: r.ts || now() }))
        : [];
      this.data = { friends, requests, blocked };
    }
    return this.data;
  }

  saveNow() { atomicWrite(this.file, JSON.stringify({ ...this.data, savedAt: now() }, null, 0)); }

  /* ---------- reads ---------- */

  friendsOf(u) { return (this.data.friends[u] || []).slice(); }
  areFriends(a, b) { return this.friendsOf(a).includes(b); }
  blockedBy(u) { return (this.data.blocked[u] || []).slice(); }
  blockedEither(a, b) { return this.blockedBy(a).includes(b) || this.blockedBy(b).includes(a); }
  requestBetween(a, b) {
    return this.data.requests.find(r => (r.from === a && r.to === b) || (r.from === b && r.to === a)) || null;
  }
  incoming(u) { return this.data.requests.filter(r => r.to === u).map(r => ({ from: r.from, ts: r.ts })); }
  outgoing(u) { return this.data.requests.filter(r => r.from === u).map(r => ({ to: r.to, ts: r.ts })); }

  /* ---------- writes ---------- */

  request(from, to) {
    if (from === to) return { error: 'that is you' };
    if (this.areFriends(from, to)) return { error: 'you are already friends' };
    if (this.requestBetween(from, to)) return { error: 'there is already a request between you' };
    this.data.requests.push({ from, to, ts: now() });
    this.saveNow();
    return { ok: true };
  }

  // a accepts the request b sent a.
  accept(a, b) {
    const i = this.data.requests.findIndex(r => r.from === b && r.to === a);
    if (i < 0) return { error: 'no request from that user' };
    this.data.requests.splice(i, 1);
    const add = (x, y) => { const l = new Set(this.data.friends[x] || []); l.add(y); this.data.friends[x] = [...l]; };
    add(a, b); add(b, a);
    this.saveNow();
    return { ok: true };
  }

  // Removes a request in either direction: declining an incoming one, or
  // cancelling an outgoing one. One verb is enough for both.
  cancel(a, b) {
    const before = this.data.requests.length;
    this.data.requests = this.data.requests.filter(r => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
    if (this.data.requests.length !== before) { this.saveNow(); return { ok: true }; }
    return { error: 'no request between you' };
  }

  removeFriend(a, b) {
    const strip = (x, y) => { this.data.friends[x] = (this.data.friends[x] || []).filter(n => n !== y); };
    strip(a, b); strip(b, a);
    this.saveNow();
    return { ok: true };
  }

  block(a, b) {
    const l = new Set(this.data.blocked[a] || []);
    l.add(b);
    this.data.blocked[a] = [...l];
    // A block ends the friendship and any pending request, both directions.
    this.removeFriend(a, b);
    this.cancel(a, b);
    this.saveNow();
    return { ok: true };
  }

  unblock(a, b) {
    this.data.blocked[a] = (this.data.blocked[a] || []).filter(n => n !== b);
    this.saveNow();
    return { ok: true };
  }

  // Account deletion scrubs every trace of the name from everyone else's lists.
  removeUser(u) {
    delete this.data.friends[u];
    for (const x of Object.keys(this.data.friends)) this.data.friends[x] = this.data.friends[x].filter(n => n !== u);
    delete this.data.blocked[u];
    for (const x of Object.keys(this.data.blocked)) this.data.blocked[x] = this.data.blocked[x].filter(n => n !== u);
    this.data.requests = this.data.requests.filter(r => r.from !== u && r.to !== u);
    this.saveNow();
  }
}

module.exports = { Social };
