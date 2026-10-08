/* PGP Room — identity.
 *
 * The private key is generated in this browser and lives in localStorage. It is
 * never sent to the server in the clear. The only thing that ever leaves this
 * device is an *envelope*: the armored private key encrypted with a key derived
 * from the account password (PBKDF2 -> AES-GCM), which the server stores as an
 * opaque string it holds no way to open. That envelope is the account's copy of
 * the key: it is saved when the account is made and restored onto every device
 * that signs in.
 *
 * A record can carry `owner` — the account username this device's key belongs
 * to. Guest keys have none, so a key can never drift into the wrong account.
 *
 * Storage format stays 'pgpchat.identity.v1' from the first release, so keys
 * that are already registered in a room keep working.
 */
const Identity = (() => {
  const LS = 'pgpchat.identity.v1';
  const LS_PREFS = 'pgpchat.prefs.v1';
  const PBKDF2_ROUNDS = 250000;

  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // Guest handles. Kept here as well as in app.js because this module must not
  // depend on another script's scope: a missing global here would throw inside the
  // first key generation, which is exactly where it is least visible.
  function randomHandle() {
    const ADJ = ['quiet', 'swift', 'amber', 'lucid', 'brave', 'calm', 'clever', 'cosmic', 'crimson', 'eager', 'faded', 'gentle', 'hidden', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'noble', 'plain', 'prime', 'rapid', 'rustic', 'silent', 'solar', 'steady', 'tidal', 'tiny', 'vivid', 'wired', 'woven', 'zesty', 'bold', 'cobalt', 'dusty'];
    const ANIMALS = ['otter', 'falcon', 'lynx', 'heron', 'badger', 'beaver', 'cobra', 'condor', 'crane', 'dolphin', 'eagle', 'egret', 'ferret', 'finch', 'fox', 'gazelle', 'gecko', 'gibbon', 'hare', 'hawk', 'ibex', 'jackal', 'koala', 'lemur', 'marlin', 'mink', 'moose', 'moth', 'newt', 'ocelot', 'osprey', 'panda', 'quail', 'raven', 'salmon', 'sparrow', 'tapir', 'tern', 'viper', 'wolf'];
    const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    return `${ADJ[r(ADJ.length)]}-${ANIMALS[r(ANIMALS.length)]}-${10 + r(90)}`;
  }

  function raw() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; }
  }
  function has() { return !!raw(); }

  async function load() {
    const r = raw();
    if (!r || !r.armoredPrivate) return null;
    try {
      const privateKey = await openpgp.readPrivateKey({ armoredKey: r.armoredPrivate });
      const publicKeyObj = await openpgp.readKey({ armoredKey: r.armoredPublic });
      return { ...r, privateKey, publicKeyObj };
    } catch (e) {
      console.warn('stored identity unreadable:', e.message);
      return null;
    }
  }

  // Mint a key without adopting it. Rotation uses this: the old key must stay in
  // place, and working, until the server has accepted the new one.
  async function generate(handle) {
    const name = handle || randomHandle();
    const gen = await openpgp.generateKey({
      type: 'curve25519',
      userIDs: [{ name, email: `${name}@pgpchat.local` }],
      format: 'armored',
    });
    const privateKey = await openpgp.readPrivateKey({ armoredKey: gen.privateKey });
    return {
      handle: name, armoredPrivate: gen.privateKey, armoredPublic: gen.publicKey,
      fp: privateKey.getFingerprint().toLowerCase(), keyId: privateKey.getKeyID().toHex().toLowerCase(),
    };
  }

  async function create(handle, owner) {
    const g = await generate(handle);
    const id = { ...g, owner: owner || null, createdAt: Date.now() };
    localStorage.setItem(LS, JSON.stringify(id));
    return { ...id, privateKey: await openpgp.readPrivateKey({ armoredKey: g.armoredPrivate }), publicKeyObj: await openpgp.readKey({ armoredKey: g.armoredPublic }) };
  }

  // Get the device key, creating one only when there is genuinely nothing to use.
  async function ensure() { return (await load()) || create(); }

  function save(patch) {
    const cur = raw() || {};
    localStorage.setItem(LS, JSON.stringify({ ...cur, ...patch }));
  }

  async function adoptPrivate(armoredPrivate, handle, owner) {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
    const armoredPublic = privateKey.toPublic().armor();
    const id = {
      handle: handle || raw()?.handle || randomHandle(),
      armoredPrivate, armoredPublic,
      fp: privateKey.getFingerprint().toLowerCase(), keyId: privateKey.getKeyID().toHex().toLowerCase(),
      owner: owner === undefined ? (raw()?.owner ?? null) : (owner || null),
      createdAt: Date.now(),
    };
    localStorage.setItem(LS, JSON.stringify(id));
    return { ...id, privateKey, publicKeyObj: await openpgp.readKey({ armoredKey: armoredPublic }) };
  }

  // The fingerprint of an armored private key, without adopting it anywhere.
  async function fpOf(armoredPrivate) {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
    return privateKey.getFingerprint().toLowerCase();
  }

  function backup(id) {
    const data = id || raw();
    if (!data) return;
    const blob = new Blob([data.armoredPrivate], { type: 'application/pgp-keys' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pgpchat-${data.handle}-${data.fp.slice(0, 8)}.asc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function clear() { localStorage.removeItem(LS); }

  /* ---------- password-wrapped envelope (key sync) ---------- */

  async function derive(password, salt) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  async function wrap(password, armoredPrivate) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(password, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(armoredPrivate));
    return b64(new TextEncoder().encode(JSON.stringify({ v: 1, rounds: PBKDF2_ROUNDS, salt: b64(salt), iv: b64(iv), ct: b64(ct) })));
  }

  async function unwrap(password, blob) {
    const env = JSON.parse(new TextDecoder().decode(unb64(blob)));
    const key = await derive(password, unb64(env.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return new TextDecoder().decode(pt);
  }

  /* ---------- small prefs ---------- */

  function prefs() { try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}'); } catch { return {}; } }
  function pref(k, v) {
    const p = prefs();
    if (v === undefined) return p[k];
    p[k] = v;
    localStorage.setItem(LS_PREFS, JSON.stringify(p));
    return v;
  }

  return { LS, LS_PREFS, has, raw, load, ensure, create, generate, save, backup, clear, adoptPrivate, fpOf, wrap, unwrap, prefs, pref, b64, unb64 };
})();
