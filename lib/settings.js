'use strict';
/*
 * Relay-wide settings the admin panel flips (site policy, not message crypto).
 */

const path = require('node:path');
const { atomicWrite, readJson, now, setupCode } = require('./util');

class Settings {
  constructor(dataDir, cfg = {}) {
    this.file = path.join(dataDir, 'settings.json');
    this.configHours = Math.max(0, Number(cfg.retentionHours != null ? cfg.retentionHours : 48));
    this.data = {
      allowNewRooms: true,
      guestAccess: true,
      allowRegistration: true,
      lockdown: false,
      motd: '',
      // Attachments are opt-in twice over: a site switch here, and the room's own
      // `allowFiles`. Both default off, so out of the box the relay takes text only.
      allowImages: false,
      allowVideo: false,
      allowFiles: false,
      // null = follow config.json, a number = that many hours, keepForever = until purged.
      retentionHours: null,
      keepForever: false,
      // Wrap a new account's key with its password as soon as it exists.
      keySyncDefault: true,
      // Deleting and editing a message. The author may always do it to their own
      // words while the switch is on; staff can always delete (that is moderation).
      allowMsgDelete: true,
      allowMsgEdit: true,
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
    for (const k of ['allowImages', 'allowVideo', 'allowFiles', 'keySyncDefault', 'allowMsgDelete', 'allowMsgEdit']) {
      if (typeof p[k] === 'boolean') this.data[k] = p[k];
    }
    // How long ciphertext lives. The panel sends one of three shapes:
    // null (follow config.json), a number of hours, or keepForever.
    if (p.retentionHours !== undefined) {
      if (p.retentionHours === null) this.data.retentionHours = null;
      else if (typeof p.retentionHours === 'number' && Number.isFinite(p.retentionHours)) {
        this.data.retentionHours = Math.min(24 * 365, Math.max(0.02, p.retentionHours));
      }
    }
    if (typeof p.keepForever === 'boolean') this.data.keepForever = p.keepForever;
    // The notice board is operator text, not message content: the relay may hold it.
    if (typeof p.motd === 'string') this.data.motd = p.motd.replace(/\s+/g, ' ').trim().slice(0, 300);
    this.saveNow();
    return { settings: this.publicView() };
  }

  // The window the shredder actually enforces, resolved from config + policy.
  retentionMs() {
    if (this.data.keepForever) return Infinity;
    const h = this.data.retentionHours != null ? this.data.retentionHours : this.configHours;
    return Math.max(0, Number(h)) * 3600000;
  }

  // Which attachment kinds the site allows at all. The room switch is a second gate.
  filePolicy() {
    return { images: !!this.data.allowImages, video: !!this.data.allowVideo, files: !!this.data.allowFiles };
  }

  allowsKind(kind) {
    const pol = this.filePolicy();
    if (kind === 'image') return pol.images;
    if (kind === 'video') return pol.video;
    return pol.files;
  }

  // What every client is allowed to know.
  publicView() {
    return {
      allowNewRooms: this.data.allowNewRooms,
      guestAccess: this.data.guestAccess,
      allowRegistration: this.data.allowRegistration !== false,
      lockdown: !!this.data.lockdown,
      motd: this.data.motd || '',
      allowImages: !!this.data.allowImages,
      allowVideo: !!this.data.allowVideo,
      allowFiles: !!this.data.allowFiles,
      keySyncDefault: this.data.keySyncDefault !== false,
      allowMsgDelete: this.data.allowMsgDelete !== false,
      allowMsgEdit: this.data.allowMsgEdit !== false,
      retentionHours: this.data.retentionHours,
      keepForever: !!this.data.keepForever,
      configRetentionHours: this.configHours,
    };
  }
}

module.exports = { Settings };
