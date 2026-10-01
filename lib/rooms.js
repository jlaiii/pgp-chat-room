'use strict';
/*
 * Rooms: registry, membership and the permission matrix.
 *
 * Permissions are decided here and only here, so the HTTP layer and the
 * WebSocket layer cannot drift apart. Every check takes an *actor*:
 *   { kind: 'account'|'guest', username, handle, role, fp }
 * where `role` is resolved live from the account record (a demotion applies to
 * sockets that are already connected).
 */

const path = require('node:path');
const { atomicWrite, readJson, now, slugify, clampInt, ROOM_ID_RE } = require('./util');

const RANK = { guest: 0, user: 1, mod: 2, admin: 3 };
const LOUNGE_ID = 'lounge';

class Rooms {
  constructor(dataDir, settings) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'rooms.json');
    this.settings = settings;
    this.rooms = new Map();
    this.saveTimer = null;
  }

  load() {
    const raw = readJson(this.file, { rooms: [] });
    for (const r of raw.rooms || []) {
      if (!r || !ROOM_ID_RE.test(r.id || '')) continue;
      this.rooms.set(r.id, normalize(r));
    }
    if (!this.rooms.has(LOUNGE_ID)) this.rooms.set(LOUNGE_ID, this.makeLounge());
    return { rooms: this.rooms.size };
  }

  makeLounge() {
    return normalize({
      id: LOUNGE_ID, name: 'Public Room', about: 'The room everyone lands in. Guests welcome.',
      private: false, frozen: false, guestOk: true, builtin: true, owner: null, createdBy: 'system',
      createdAt: now(), members: [], mods: [], pending: [], allowFiles: false,
    });
  }

  saveNow() { atomicWrite(this.file, JSON.stringify({ rooms: [...this.rooms.values()], savedAt: now() }, null, 0)); }
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.saveNow(); } catch { /* next change retries */ } }, 500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  get(id) { return this.rooms.get(String(id || '').toLowerCase()) || null; }
  all() { return [...this.rooms.values()]; }

  /* ---------- permission matrix ---------- */

  can(actor, action, room = null) {
    if (!actor) return false;
    const role = actor.role || (actor.kind === 'guest' ? 'guest' : 'user');
    const rank = RANK[role] ?? -1;
    const isGuest = actor.kind === 'guest';
    const isMember = room ? this.isMember(room, actor) : false;
    const isOwner = room && room.owner && actor.username && room.owner === actor.username;
    const isRoomMod = room && actor.username && room.mods.includes(actor.username);

    switch (action) {
      // Room visibility: private rooms are invisible to non-members. Admin sees all
      // (that is the "enter room" power); a mod does not get into private rooms.
      case 'view':
        if (!room) return false;
        if (rank >= RANK.admin) return true;
        if (!room.private) return true;
        return isMember || isRoomMod || isOwner;
      case 'join':
        // Entering a public room and *filing a request* for a private one are both
        // this action; rooms.join() decides immediate membership vs pending approval.
        if (!room) return false;
        if (rank >= RANK.admin) return true;
        if (isGuest) return room.guestOk && !room.private && this.settings.data.guestAccess !== false;
        return true;
      case 'post':
        if (!room) return false;
        if (rank >= RANK.mod || isRoomMod || isOwner) return true;   // mods talk through a freeze
        if (room.frozen) return false;
        if (isGuest) return room.guestOk && this.settings.data.guestAccess !== false;
        return isMember || isOwner;
      case 'read':
        // An admin can enter any room — that was an explicit power. A mod cannot:
        // free read access to a private room would also mean free *key* registration
        // in it, which is a self-invite into somebody else's room.
        if (!room) return false;
        if (rank >= RANK.admin) return true;
        if (isGuest) return room.guestOk && !room.private && this.settings.data.guestAccess !== false;
        if (room.private) return isMember || isOwner || isRoomMod;
        return true;
      // Freeze / unfreeze and the private toggle: two separate controls, both
      // available to mods, the room owner and admins.
      case 'freeze': case 'privacy': case 'edit':
        return rank >= RANK.mod || isOwner || isRoomMod;
      case 'delete':
        if (room && room.builtin) return false;
        return rank >= RANK.admin || isOwner;
      case 'approve': case 'kick':
        if (!room) return false;
        if (rank >= RANK.admin) return true;
        return isOwner || isRoomMod || (rank >= RANK.mod);
      case 'assignMod':
        return rank >= RANK.admin || isOwner;
      case 'ban':
        return rank >= RANK.mod || isOwner;      // scope/target checks happen in the handler
      case 'createRoom':
        // "Disable new rooms" is a policy for users; an admin keeps the power.
        if (rank >= RANK.admin) return true;
        return this.settings.data.allowNewRooms !== false && rank >= RANK.user;
      case 'settings':
        return rank >= RANK.admin;
      default:
        return false;
    }
  }

  // Can `actor` moderate `target` (ban/kick/role change)? Rank must be strictly
  // lower, and the last admin is never a valid target.
  canModerate(actor, targetRole, targetUsername = null) {
    const a = RANK[actor.role] ?? -1;
    const t = RANK[targetRole] ?? -1;
    if (a < RANK.mod) return false;
    if (a === RANK.mod) return t <= RANK.user;             // mods handle users and guests
    if (a >= RANK.admin) {
      if (t >= RANK.admin) return false;                   // admins don't ban admins
      return true;
    }
    return false;
  }

  isMember(room, actor) {
    if (!room) return false;
    if (actor.username && room.members.includes(actor.username)) return true;
    if (actor.fp) return room.guestMembers ? room.guestMembers.includes(actor.fp) : false;
    return false;
  }

  isRoomMod(room, actor) { return !!(room && actor.username && room.mods.includes(actor.username)); }

  /* ---------- listing ---------- */

  view(room, actor, live = {}) {
    const member = this.isMember(room, actor);
    return {
      id: room.id, name: room.name, about: room.about, private: room.private, frozen: room.frozen,
      guestOk: room.guestOk, builtin: !!room.builtin, owner: room.owner, createdBy: room.createdBy,
      createdAt: room.createdAt, allowFiles: !!room.allowFiles,
      memberCount: room.members.length, mods: room.mods.slice(), members: member || (RANK[actor.role] ?? 0) >= RANK.mod ? room.members.slice() : [],
      pendingCount: room.pending.length,
      pending: this.can(actor, 'approve', room) ? room.pending.slice() : [],
      isMember: member, isOwner: room.owner === actor.username, isMod: this.isRoomMod(room, actor),
      canPost: this.can(actor, 'post', room), canFreeze: this.can(actor, 'freeze', room),
      canEdit: this.can(actor, 'edit', room), canApprove: this.can(actor, 'approve', room),
      canDelete: this.can(actor, 'delete', room), canAssignMod: this.can(actor, 'assignMod', room),
      online: live.online || 0, keys: live.keys || 0, slowMs: room.slowMs || 0,
    };
  }

  list(actor, liveFor = () => ({})) {
    return this.all()
      .filter(r => this.can(actor, 'view', r))
      .map(r => this.view(r, actor, liveFor(r.id)))
      .sort((a, b) => (a.builtin === b.builtin ? a.createdAt - b.createdAt : a.builtin ? -1 : 1));
  }

  roomsFor(username) {
    return this.all().filter(r => r.members.includes(username)).map(r => r.id);
  }

  /* ---------- mutations ---------- */

  create({ name, about = '', private: isPrivate = false, guestOk = false }, actor) {
    if (!this.can(actor, 'createRoom')) {
      return { error: this.settings.data.allowNewRooms === false ? 'new rooms are disabled right now' : 'not allowed' };
    }
    const clean = String(name || '').trim().slice(0, 40);
    if (clean.length < 2) return { error: 'room name must be at least 2 characters' };
    let id = slugify(clean);
    if (this.rooms.has(id)) {
      let n = 2;
      while (this.rooms.has(`${id}-${n}`) && n < 99) n++;
      id = `${id}-${n}`;
    }
    if (!ROOM_ID_RE.test(id)) return { error: 'could not derive a room id' };
    const room = normalize({
      id, name: clean, about: String(about || '').slice(0, 200), private: !!isPrivate, frozen: false,
      guestOk: !!guestOk && !isPrivate, builtin: false, owner: actor.username, createdBy: actor.username,
      createdAt: now(), members: [actor.username], mods: [], pending: [], allowFiles: false,
    });
    this.rooms.set(id, room);
    this.saveNow();
    return { room: this.view(room, actor) };
  }

  update(id, patch, actor) {
    const room = this.get(id);
    if (!room) return { error: 'no such room' };
    const changingCore = ['frozen', 'private'].some(k => typeof patch[k] === 'boolean' && patch[k] !== room[k]);
    if (changingCore && !this.can(actor, 'freeze', room)) return { error: 'not allowed' };
    if (!changingCore && !this.can(actor, 'edit', room)) return { error: 'not allowed' };
    if (typeof patch.frozen === 'boolean') room.frozen = patch.frozen;
    if (typeof patch.private === 'boolean') {
      if (room.builtin && patch.private) return { error: 'the public room cannot be made private' };
      room.private = patch.private;
      if (!room.private) room.pending = [];               // reopening clears stale requests
    }
    if (typeof patch.guestOk === 'boolean') {
      if (room.private && patch.guestOk) return { error: 'a private room cannot take guests' };
      room.guestOk = patch.guestOk;
    }
    if (typeof patch.name === 'string' && patch.name.trim().length >= 2) room.name = patch.name.trim().slice(0, 40);
    if (typeof patch.about === 'string') room.about = patch.about.slice(0, 200);
    if (patch.slowMs !== undefined) room.slowMs = clampInt(patch.slowMs, 0, 300000, 0);   // 0 = off
    if (typeof patch.allowFiles === 'boolean') room.allowFiles = patch.allowFiles;   // enforced in phase 2
    this.saveNow();
    return { room: this.view(room, actor) };
  }

  remove(id, actor) {
    const room = this.get(id);
    if (!room) return { error: 'no such room' };
    if (!this.can(actor, 'delete', room)) return { error: room.builtin ? 'the public room cannot be deleted' : 'not allowed' };
    this.rooms.delete(room.id);
    this.saveNow();
    return { room: { id: room.id, name: room.name } };
  }

  // Public room: joining is immediate. Private room: an account files a request.
  join(id, actor, fp = null) {
    const room = this.get(id);
    if (!room) return { error: 'no such room' };
    if (!this.can(actor, 'join', room)) return { error: 'not allowed' };
    if (actor.kind === 'guest') {
      room.guestMembers = addUnique(room.guestMembers || [], fp);
      this.save();
      return { room: this.view(room, actor), pending: false };
    }
    if (room.private && !this.isMember(room, actor) && !this.isRoomMod(room, actor) && (RANK[actor.role] ?? 0) < RANK.admin) {
      room.pending = addUnique(room.pending, actor.username);
      this.save();
      return { room: this.view(room, actor), pending: true };
    }
    room.members = addUnique(room.members, actor.username);
    room.pending = room.pending.filter(u => u !== actor.username);
    this.save();
    return { room: this.view(room, actor), pending: false };
  }

  leave(id, actor) {
    const room = this.get(id);
    if (!room) return { error: 'no such room' };
    if (room.builtin && !room.members.includes(actor.username)) return { room: this.view(room, actor) };
    if (actor.fp) room.guestMembers = (room.guestMembers || []).filter(f => f !== actor.fp);
    if (actor.username) {
      room.members = room.members.filter(u => u !== actor.username);
      room.pending = room.pending.filter(u => u !== actor.username);
      if (room.owner === actor.username && room.builtin === false) {
        // an owner walking away hands the room to the next moderator or admin
        room.owner = room.mods.find(m => m !== actor.username) || null;
      }
      room.mods = room.mods.filter(m => m !== actor.username);
    }
    this.save();
    return { room: this.view(room, actor) };
  }

  memberOp(id, target, op, actor) {
    const room = this.get(id);
    if (!room) return { error: 'no such room' };
    const t = String(target || '').toLowerCase();
    if (op === 'approve' || op === 'deny') {
      if (!this.can(actor, 'approve', room)) return { error: 'not allowed' };
      if (!room.pending.includes(t)) return { error: 'no such request' };
      room.pending = room.pending.filter(u => u !== t);
      if (op === 'approve') room.members = addUnique(room.members, t);
      this.saveNow();
      return { room: this.view(room, actor), target: t, op };
    }
    if (op === 'kick') {
      if (!this.can(actor, 'kick', room)) return { error: 'not allowed' };
      if (room.owner === t) return { error: 'the room owner cannot be removed' };
      room.members = room.members.filter(u => u !== t);
      room.mods = room.mods.filter(u => u !== t);
      room.pending = room.pending.filter(u => u !== t);
      this.saveNow();
      return { room: this.view(room, actor), target: t, op };
    }
    if (op === 'mod' || op === 'unmod') {
      if (!this.can(actor, 'assignMod', room)) return { error: 'not allowed' };
      if (!room.members.includes(t)) return { error: 'that account is not in this room' };
      room.mods = op === 'mod' ? addUnique(room.mods, t) : room.mods.filter(u => u !== t);
      this.saveNow();
      return { room: this.view(room, actor), target: t, op };
    }
    return { error: 'unknown op' };
  }

  /* ---------- live helpers ---------- */

  onlineActors(roomId) { return this._live?.[roomId] || { online: 0, keys: 0 }; }
  setLiveResolver(fn) { this._liveFn = fn; }
}

function addUnique(arr, v) { return v && !arr.includes(v) ? [...arr, v] : arr; }

function normalize(r) {
  return {
    id: r.id, name: r.name || r.id, about: r.about || '', private: !!r.private, frozen: !!r.frozen,
    guestOk: !!r.guestOk, builtin: !!r.builtin, owner: r.owner || null, createdBy: r.createdBy || null,
    createdAt: r.createdAt || now(), members: Array.isArray(r.members) ? r.members.slice() : [],
    guestMembers: Array.isArray(r.guestMembers) ? r.guestMembers.slice() : [],
    mods: Array.isArray(r.mods) ? r.mods.slice() : [], pending: Array.isArray(r.pending) ? r.pending.slice() : [],
    allowFiles: !!r.allowFiles,
    slowMs: clampInt(r.slowMs, 0, 300000, 0),
  };
}

module.exports = { Rooms, RANK, LOUNGE_ID };
