'use strict';
/*
 * Relay-wide settings the admin panel flips (site policy, not message crypto).
 */

const path = require('node:path');
const { atomicWrite, readJson, now, setupCode } = require('./util');

class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.data = {
      allowNewRooms: true,
      guestAccess: true,
      allowRegistration: true,
      lockdown: false,
      motd: '',
      adminClaim: null,
      createdAt: now(),
    };
    this.saveTimer = null;
  }

  load() {
    const raw = readJson(this.file, null);
    if (raw && typeof raw === 'object') Object.assign(this.data, raw);
    // The bootstrap code exists only while there is no admin: it is the one-shot
    // way for the operator to claim the first admin account.
    return this.data;
  }

  saveNow() { atomicWrite(this.file, JSON.stringify({ ...this.data, savedAt: now() }, null, 0)); }
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.saveNow(); } catch { /* next change retries */ } }, 500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Called when no admin exists yet. Keeps an existing code so a restart does not
  // invalidate the one the operator already received.
  ensureClaimCode() {
    if (!this.data.adminClaim) { this.data.adminClaim = setupCode(8); this.saveNow(); return { code: this.data.adminClaim, created: true }; }
    return { code: this.data.adminClaim, created: false };
  }
  clearClaimCode() { this.data.adminClaim = null; this.saveNow(); }

  patch(p, actorRole) {
    if (actorRole !== 'admin') return { error: 'admin only' };
    if (typeof p.allowNewRooms === 'boolean') this.data.allowNewRooms = p.allowNewRooms;
    if (typeof p.guestAccess === 'boolean') this.data.guestAccess = p.guestAccess;
    if (typeof p.allowRegistration === 'boolean') this.data.allowRegistration = p.allowRegistration;
    if (typeof p.lockdown === 'boolean') this.data.lockdown = p.lockdown;
    // The notice board is operator text, not message content: the relay may hold it.
    if (typeof p.motd === 'string') this.data.motd = p.motd.replace(/\s+/g, ' ').trim().slice(0, 300);
    this.saveNow();
    return { settings: this.publicView() };
  }

  // What every client is allowed to know.
  publicView() {
    return {
      allowNewRooms: this.data.allowNewRooms,
      guestAccess: this.data.guestAccess,
      allowRegistration: this.data.allowRegistration !== false,
      lockdown: !!this.data.lockdown,
      motd: this.data.motd || '',
    };
  }
}

module.exports = { Settings };
