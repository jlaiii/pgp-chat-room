// End-to-end tests for the relay. `npm test`
//
// Spawns a real server process against a temporary data directory, so this never
// touches a live room. Asserts the properties the project actually promises:
// later-joining keys cannot read earlier ciphertext, post-join messages decrypt and
// verify, non-recipients fail, only ciphertext hits disk, the limiter engages, and
// the retention sweep removes expired rows from memory and disk — plus the
// room/role layer: private rooms stay invisible, a freeze stops plain members but
// not moderators, and a ban drops the live socket.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as openpgp from 'openpgp';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PGPCHAT_TEST_PORT || 18909);
const BASE = `http://127.0.0.1:${PORT}`;

async function makeKey(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name, email: `${name}@example.test` }],
    format: 'armored',
  });
  const priv = await openpgp.readPrivateKey({ armoredKey: privateKey });
  return { name, fp: priv.getFingerprint().toLowerCase(), keyId: priv.getKeyID().toHex().toLowerCase(), publicKey, priv };
}

// Each client keeps its own cookie jar: the tests act as several people at once.
// Call as client(method, path, body?) — body may be an object or a JSON string.
function makeClient() {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const fn = async function api(method, pathname, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.size) headers.Cookie = cookie();
    const opts = { method, headers };
    if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(BASE + pathname, opts);
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: parsed, headers: res.headers, cookie };
  };
  fn.cookie = cookie;
  return fn;
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined);
    const frames = [];
    ws.on('message', d => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

function waitFor(frames, pred, ms = 5000, label = '') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = frames.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        const tail = frames.slice(-8).map(f => `${f.t}${f.msg ? `("${String(f.msg).slice(0, 80)}")` : ''}${f.reason ? `(${f.reason})` : ''}${f.m ? `[from=${f.m.from},tmp=${f.tmpId ?? ''},ct=${String(f.m.ct || '').slice(0, 24)}]` : ''}`).join(' | ');
        reject(new Error(`timed out ${label ? `(${label}) ` : ''}waiting for frame; last frames: ${tail}`));
      }
    }, 25);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function startServer(cfgPath) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PGPCHAT_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { out += d.toString(); });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return { proc, log: () => out };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error(`server did not start:\n${out}`);
}

async function readAllFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await readAllFiles(full));
    else out.push([full, await readFile(full, 'utf8').catch(() => '')]);
  }
  return out;
}

test('PGP Room relay — end to end', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pgpchat-test-'));
  const cfgPath = path.join(dir, 'config.json');
  const writeConfig = extra => writeFile(cfgPath, JSON.stringify({
    port: PORT,
    bind: '127.0.0.1',
    dataDir: path.join(dir, 'data'),
    publicDir: path.join(ROOT, 'public'),
    trustProxy: false,
    retentionHours: 48,
    cleanupMinutes: 1,
    publicUrl: `http://127.0.0.1:${PORT}/`,
    auth: { scryptN: 1024 },
    rate: { msgsPerMin: 25, keysPerMin: 50, connsPerMin: 200, authPerMin: 50, guestPerMin: 50 },
    ...extra,
  }));
  await writeConfig();

  const procs = [];
  let srv = await startServer(cfgPath);
  procs.push(srv.proc);
  t.after(async () => {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
    await sleep(700);                       // let the relay finish its shutdown writes
    for (let i = 0; i < 6; i++) {
      try { await rm(dir, { recursive: true, force: true }); return; }
      catch { await sleep(300); }           // a late write can race the rmdir
    }
  });

  const admin = makeClient();
  const user = makeClient();
  const mod = makeClient();
  const guest = makeClient();

  await t.test('serves the shell with security headers', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /PGP Room/);
    assert.match(res.headers.get('content-security-policy') || '', /connect-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const robots = await fetch(`${BASE}/robots.txt`);
    assert.match(await robots.text(), /Disallow: \//);
    for (const asset of ['/app.js', '/identity.js', '/style.css']) {
      const r = await fetch(BASE + asset);
      assert.equal(r.status, 200, `${asset} must be served`);
    }
    // The shell carries an asset version, and the relay exposes the same one —
    // that pair is what lets open pages notice a deploy and update themselves.
    const ver = await api('/api/version');
    assert.equal(ver.status, 200);
    assert.match(ver.body.version, /^[0-9a-f]{12}$/);
    assert.equal((await api('/api/version')).body.version, ver.body.version, 'stable while the assets are');
    const html = await (await fetch(`${BASE}/`)).text();
    assert.ok(html.includes(`name="app-version" content="${ver.body.version}"`), 'the shell stamp matches /api/version');
  });

  await t.test('login is required before anything else', async () => {
    const anon = makeClient();
    assert.equal((await anon('GET', '/api/me')).status, 401);
    assert.equal((await anon('GET', '/api/rooms')).status, 401);
    assert.equal((await anon('POST', '/api/rooms', JSON.stringify({ name: 'nope' }))).status, 401);
    const bad = await anon('POST', '/api/auth/register', JSON.stringify({ username: 'x', password: 'y' }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /username/);
  });

  await t.test('the first account on an empty relay is seated as admin; the seat is never assumed after that', async () => {
    const armed = JSON.parse(await readFile(path.join(dir, 'data', 'settings.json'), 'utf8'));
    assert.ok(armed.adminClaim, 'the operator is armed with a fallback code while the relay is empty');

    const reg = await admin('POST', '/api/auth/register', JSON.stringify({ username: 'jay', password: 'correct-horse-battery' }));
    assert.equal(reg.status, 201);
    assert.equal(reg.body.me.role, 'admin', 'the very first account is the operator');
    assert.equal(reg.body.claimable, false, 'there is nothing left to claim');
    assert.equal((await admin('GET', '/api/me')).body.me.role, 'admin');

    const after = JSON.parse(await readFile(path.join(dir, 'data', 'settings.json'), 'utf8'));
    assert.equal(after.adminClaim, null, 'the fallback code is cleared once the seat is taken');
    assert.equal((await admin('GET', '/healthz')).body.adminClaimable, false);
    assert.equal((await admin('POST', '/api/auth/claim', JSON.stringify({ code: 'NOPE1234' }))).status, 409,
      'claiming is refused while an admin exists');
  });

  await t.test('roles: admin promotes a mod, mods cannot promote', async () => {
    await mod('POST', '/api/auth/register', JSON.stringify({ username: 'morgan', password: 'mod-password-1' }));
    await user('POST', '/api/auth/register', JSON.stringify({ username: 'casey', password: 'user-password-1' }));
    assert.equal((await user('POST', '/api/admin/role', JSON.stringify({ username: 'morgan', role: 'mod' }))).status, 403);
    const promote = await admin('POST', '/api/admin/role', JSON.stringify({ username: 'morgan', role: 'mod' }));
    assert.equal(promote.status, 200);
    assert.equal(promote.body.account.role, 'mod');
    assert.equal((await mod('POST', '/api/admin/role', JSON.stringify({ username: 'casey', role: 'admin' }))).status, 403,
      'a mod cannot mint an admin');
  });

  await t.test('guest session and key registration in the lounge', async () => {
    const G = await makeKey('guest');
    const g = await guest('POST', '/api/guest', JSON.stringify({ handle: 'quiet-heron-11', fp: G.fp }));
    assert.equal(g.status, 201);
    assert.equal(g.body.me.role, 'guest');
    const reg = await guest('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: G.fp, keyId: G.keyId, handle: 'quiet-heron-11', publicKey: G.publicKey }));
    assert.equal(reg.status, 200);
    assert.equal(reg.body.isNew, true);
    const pool = await guest('GET', '/api/rooms/lounge/pool');
    assert.equal(pool.body.retentionHours, 48);
    assert.ok(pool.body.keys.some(k => k.fp === G.fp));
    // a guest may not create rooms or open new ones
    assert.equal((await guest('POST', '/api/rooms', JSON.stringify({ name: 'guest room' }))).status, 403);
    // the socket welcome carries the relay's asset version too
    const gs = await connect(guest.cookie());
    gs.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: G.fp, handle: 'quiet-heron-11' }));
    const w = await waitFor(gs.frames, f => f.t === 'welcome');
    assert.match(w.version, /^[0-9a-f]{12}$/, 'the welcome frame carries the relay version');
    gs.ws.close();
  });

  await t.test('rejects malformed input and private armor', async () => {
    const bad = await guest('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: 'nope', keyId: '1', handle: 'x', publicKey: 'x' }));
    assert.equal(bad.status, 400);
    const priv = await guest('POST', '/api/keys', JSON.stringify({
      room: 'lounge', fp: 'a'.repeat(40), keyId: 'aabbccdd', handle: 'ok-name',
      publicKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nx',
    }));
    assert.equal(priv.status, 400);
    assert.match(priv.body.error, /public key/);
  });

  const A = await makeKey('alice');
  const B = await makeKey('bob');
  const C = await makeKey('carol');

  await t.test('a key cannot read ciphertext that predates it', async () => {
    const reg = await guest('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: A.fp, keyId: A.keyId, handle: 'alice-1', publicKey: A.publicKey }));
    assert.equal(reg.body.isNew, true);

    const connA = await connect(guest.cookie());
    connA.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: A.fp, handle: 'alice-1' }));
    const welcome = await waitFor(connA.frames, f => f.t === 'welcome');
    assert.equal(welcome.room.id, 'lounge');
    assert.equal(welcome.canPost, true, 'a guest may post in the public room');

    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'before bob' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      signingKeys: A.priv,
      format: 'armored',
    });
    connA.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'pre', ct, recipients: [A.fp] }));
    const echo = await waitFor(connA.frames, f => f.t === 'msg' && f.m.tmpId === 'pre');
    assert.ok(echo.m.id, 'author receives its own message with tmpId for reconciliation');

    const regB = await guest('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: B.fp, keyId: B.keyId, handle: 'bob-1', publicKey: B.publicKey }));
    assert.equal(regB.body.isNew, true);

    const hist2 = await guest('GET', `/api/rooms/lounge/history?fp=${B.fp}`);
    assert.equal(hist2.status, 200);
    assert.equal(hist2.body.lockedCount, 1, 'B sees exactly one unreadable message');
    assert.equal(hist2.body.messages.length, 0, 'B can decrypt nothing from before it joined');
    connA.ws.close();
  });

  await t.test('post-join messages decrypt and verify; non-recipients cannot read them', async () => {
    const connA = await connect(guest.cookie());
    connA.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: A.fp, handle: 'alice-1' }));
    await waitFor(connA.frames, f => f.t === 'welcome');

    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'after bob joined' }),
      encryptionKeys: [
        await openpgp.readKey({ armoredKey: A.publicKey }),
        await openpgp.readKey({ armoredKey: B.publicKey }),
      ],
      signingKeys: A.priv,
      format: 'armored',
    });
    connA.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'post', ct, recipients: [A.fp, B.fp] }));
    const echo = await waitFor(connA.frames, f => f.t === 'msg' && f.m.tmpId === 'post');
    assert.equal(echo.m.fp, A.fp);

    const msg = await openpgp.readMessage({ armoredMessage: echo.m.ct });
    const res = await openpgp.decrypt({
      message: msg,
      decryptionKeys: B.priv,
      verificationKeys: await openpgp.readKey({ armoredKey: A.publicKey }),
      format: 'utf8',
    });
    assert.equal(res.data, 'after bob joined');
    assert.equal(await res.signatures[0].verified, true, 'signature verifies against the sender key');

    const msgForC = await openpgp.readMessage({ armoredMessage: echo.m.ct });
    await assert.rejects(
      () => openpgp.decrypt({ message: msgForC, decryptionKeys: C.priv, format: 'utf8' }),
      'a key that was never a recipient cannot decrypt',
    );
    connA.ws.close();
  });

  await t.test('ciphertext-only on disk, per room', async () => {
    const segDir = path.join(dir, 'data', 'rooms', 'lounge', 'messages');
    const segs = (await readdir(segDir)).filter(f => f.endsWith('.jsonl'));
    assert.ok(segs.length >= 1, 'messages landed in a per-room, per-day segment');
    const raw = await readFile(path.join(segDir, segs[0]), 'utf8');
    assert.match(raw, /BEGIN PGP MESSAGE/);
    for (const secret of ['before bob', 'after bob joined', 'PRIVATE KEY']) {
      assert.ok(!raw.includes(secret), `must not be on disk: ${secret}`);
    }
  });

  await t.test('rooms: a private room is invisible and needs approval', async () => {
    const made = await user('POST', '/api/rooms', JSON.stringify({ name: 'Ops', private: true, about: 'casey only' }));
    assert.equal(made.status, 201);
    assert.equal(made.body.room.private, true);
    const ops = made.body.room.id;

    const caseyList = await user('GET', '/api/rooms');
    assert.ok(caseyList.body.rooms.some(r => r.id === ops), 'the owner sees their own room');
    const morganList = await mod('GET', '/api/rooms');
    assert.ok(!morganList.body.rooms.some(r => r.id === ops), 'a mod does not get into a private room for free');
    const adminList = await admin('GET', '/api/rooms');
    assert.ok(adminList.body.rooms.some(r => r.id === ops), 'an admin can enter any room');

    assert.equal((await mod('GET', `/api/rooms/${ops}/pool`)).status, 403, 'no pool read without access');
    const asked = await mod('POST', `/api/rooms/${ops}/join`);
    assert.equal(asked.body.pending, true, 'an account can file a request');
    const state = await user('GET', `/api/rooms/${ops}/state`);
    assert.ok(state.body.room.pending.includes('morgan'), 'the request is visible to the owner');
    const approved = await user('POST', `/api/rooms/${ops}/members`, JSON.stringify({ username: 'morgan', op: 'approve' }));
    assert.equal(approved.status, 200);
    assert.ok(approved.body.room.members.includes('morgan'));
    const nowVisible = await mod('GET', '/api/rooms');
    assert.ok(nowVisible.body.rooms.some(r => r.id === ops), 'after approval the room appears');
  });

  await t.test('a room owner kicks, bans and unbans inside their own room', async () => {
    const made = await user('POST', '/api/rooms', JSON.stringify({ name: 'Owner Power', about: 'casey runs this one' }));
    assert.equal(made.status, 201);
    const rid = made.body.room.id;

    const target = makeClient();
    await target('POST', '/api/auth/register', JSON.stringify({ username: 'lennon', password: 'lennon-pass-1' }));
    await target('POST', `/api/rooms/${rid}/join`);
    const st = await user('GET', `/api/rooms/${rid}/state`);
    assert.ok(st.body.room.members.includes('lennon'), 'the target is in');

    // kick: off the member list, door still open for a rejoin
    const kick = await user('POST', `/api/rooms/${rid}/members`, JSON.stringify({ username: 'lennon', op: 'kick' }));
    assert.equal(kick.status, 200, JSON.stringify(kick.body));
    assert.ok(!kick.body.room.members.includes('lennon'));
    assert.equal((await target('POST', `/api/rooms/${rid}/join`)).status, 200);

    // ban: a plain owner bans inside their own room (this used to 403 — canModerate
    // was staff-only) …
    const ban = await user('POST', '/api/mod/ban', JSON.stringify({ target: 'lennon', kind: 'account', room: rid, hours: 1, reason: 'testing the door' }));
    assert.equal(ban.status, 200, JSON.stringify(ban.body));
    const denied = await target('POST', `/api/rooms/${rid}/join`);
    assert.equal(denied.status, 401, 'the ban drops the live session outright');
    const relogin = await target('POST', '/api/auth/login', JSON.stringify({ username: 'lennon', password: 'lennon-pass-1' }));
    assert.equal(relogin.status, 200, 'a room ban does not lock the account door site-wide');
    const deniedAgain = await target('POST', `/api/rooms/${rid}/join`);
    assert.equal(deniedAgain.status, 403, 'but the room door stays shut');
    assert.equal(deniedAgain.body.banned, true);
    const view = await user('GET', `/api/rooms/${rid}/state`);
    assert.ok(view.body.room.bans.some(b => b.target === 'lennon'), 'the room sheet carries the ban list for its owner');
    assert.ok(!view.body.room.members.includes('lennon'), 'a room ban also takes the account off the member list');

    // … and lifts it again
    const un = await user('POST', '/api/mod/unban', JSON.stringify({ target: 'lennon', kind: 'account', room: rid }));
    assert.equal(un.status, 200, JSON.stringify(un.body));
    assert.equal(un.body.removed, 1);
    assert.equal((await target('POST', '/api/auth/login', JSON.stringify({ username: 'lennon', password: 'lennon-pass-1' }))).status, 200, 'the door opens again');
    const back = await target('POST', `/api/rooms/${rid}/join`);
    assert.equal(back.status, 200);
    assert.equal(back.body.pending, false);
  });

  await t.test('room powers have a ceiling: staff are out of reach', async () => {
    const list = await user('GET', '/api/rooms');
    const rid = list.body.rooms.find(r => r.name === 'Owner Power').id;
    await mod('POST', `/api/rooms/${rid}/join`);
    const kick = await user('POST', `/api/rooms/${rid}/members`, JSON.stringify({ username: 'morgan', op: 'kick' }));
    assert.equal(kick.status, 403, 'a room owner cannot kick staff');
    const ban = await user('POST', '/api/mod/ban', JSON.stringify({ target: 'morgan', kind: 'account', room: rid }));
    assert.equal(ban.status, 403, 'a room owner cannot ban staff');
  });

  await t.test('one pinned message per room — owner or staff only, replaced, and gone with the message', async () => {
    const list = await user('GET', '/api/rooms');
    const rid = list.body.rooms.find(r => r.name === 'Owner Power').id;
    const K = await makeKey('pinner');
    await user('POST', `/api/rooms/${rid}/keys`, JSON.stringify({ room: rid, fp: K.fp, keyId: K.keyId, handle: 'casey', publicKey: K.publicKey }));
    const conn = await connect(user.cookie());
    conn.ws.send(JSON.stringify({ t: 'hello', room: rid, fp: K.fp, handle: 'casey' }));
    await waitFor(conn.frames, f => f.t === 'welcome');
    const seal = async text => openpgp.encrypt({
      message: await openpgp.createMessage({ text }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: K.publicKey })],
      signingKeys: K.priv,
      format: 'armored',
    });
    const send = async (tmpId, text) => {
      conn.ws.send(JSON.stringify({ t: 'send', room: rid, tmpId, ct: await seal(text), recipients: [K.fp] }));
      return (await waitFor(conn.frames, f => f.t === 'msg' && f.m.tmpId === tmpId)).m.id;
    };
    const m1 = await send('pin-one', 'the rules of the house');
    const m2 = await send('pin-two', 'an even better rule');

    // a plain member cannot pin …
    const lennon2 = makeClient();
    await lennon2('POST', '/api/auth/login', JSON.stringify({ username: 'lennon', password: 'lennon-pass-1' }));
    assert.equal((await lennon2('POST', `/api/rooms/${rid}/pin`, JSON.stringify({ id: m1 }))).status, 403, 'members do not pin');
    // … and neither does a global mod: the pin belongs to the owner and the admin/dev ladder.
    assert.equal((await mod('POST', `/api/rooms/${rid}/pin`, JSON.stringify({ id: m1 }))).status, 403, 'pinning is not a mod power');

    // the owner pins; the room view carries the one slot
    const p1 = await user('POST', `/api/rooms/${rid}/pin`, JSON.stringify({ id: m1 }));
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.body.room.pin.id, m1);
    assert.equal(p1.body.room.canPin, true, 'the owner gets the pin control');

    // one slot, ever: an admin pinning another message replaces the first
    const p2 = await admin('POST', `/api/rooms/${rid}/pin`, JSON.stringify({ id: m2 }));
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p2.body.room.pin.id, m2, 'a second pin replaces the first — one per room');

    // deleting the pinned message vacates the slot
    await user('DELETE', `/api/rooms/${rid}/messages/${m2}`);
    const after = await user('GET', `/api/rooms/${rid}/state`);
    assert.equal(after.body.room.pin, null, 'the pin dies with its message');

    // and the bar can be cleared by hand
    const p3 = await user('POST', `/api/rooms/${rid}/pin`, JSON.stringify({ id: m1 }));
    assert.equal(p3.body.room.pin.id, m1);
    const cleared = await user('DELETE', `/api/rooms/${rid}/pin`);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.room.pin, null);
    conn.ws.close();
  });

  await t.test('a freeze stops ordinary members but not mods, owners or admins', async () => {
    const made = await user('POST', '/api/rooms', JSON.stringify({ name: 'Frozen Test', guestOk: true }));
    const rid = made.body.room.id;
    await mod('POST', `/api/rooms/${rid}/join`);
    // register the guest's key and the owner's key in that room
    const regA = await guest('POST', `/api/rooms/${rid}/keys`, JSON.stringify({ room: rid, fp: A.fp, keyId: A.keyId, handle: 'quiet-heron-11', publicKey: A.publicKey }));
    assert.equal(regA.status, 200);
    const regC = await user('POST', `/api/rooms/${rid}/keys`, JSON.stringify({ room: rid, fp: C.fp, keyId: C.keyId, handle: 'casey', publicKey: C.publicKey }));
    assert.equal(regC.status, 200);
    await guest('POST', `/api/rooms/${rid}/join`);

    // an ordinary participant: the guest
    const gConn = await connect(guest.cookie());
    gConn.ws.send(JSON.stringify({ t: 'hello', room: rid, fp: A.fp, handle: 'quiet-heron-11' }));
    const gWelcome = await waitFor(gConn.frames, f => f.t === 'welcome' || f.t === 'err');
    assert.equal(gWelcome.t, 'welcome', JSON.stringify(gWelcome));
    assert.equal(gWelcome.canPost, true, 'before the freeze an ordinary participant can post');

    // the owner freezes it
    const frozen = await user('PATCH', `/api/rooms/${rid}`, JSON.stringify({ frozen: true }));
    assert.equal(frozen.body.room.frozen, true);

    const gRoomFrame = await waitFor(gConn.frames, f => f.t === 'room' && f.room.id === rid && f.canPost === false);
    assert.equal(gRoomFrame.frozen, true, 'the live socket is told it can no longer post');

    const ctA = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'should be refused' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      signingKeys: A.priv, format: 'armored',
    });
    const before = gConn.frames.length;
    gConn.ws.send(JSON.stringify({ t: 'send', room: rid, tmpId: 'nope', ct: ctA, recipients: [A.fp] }));
    const errFrame = await waitFor(gConn.frames, f => f.t === 'err');
    assert.match(errFrame.msg, /frozen/);
    assert.equal(gConn.frames.slice(before).filter(f => f.t === 'msg').length, 0, 'nothing was stored');
    gConn.ws.close();

    // the owner posts through the freeze
    const cConn = await connect(user.cookie());
    cConn.ws.send(JSON.stringify({ t: 'hello', room: rid, fp: C.fp, handle: 'casey' }));
    const cWelcome = await waitFor(cConn.frames, f => f.t === 'welcome');
    assert.equal(cWelcome.canPost, true, 'the owner talks through a freeze');
    const ctC = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'owner through freeze' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: C.publicKey })],
      signingKeys: C.priv, format: 'armored',
    });
    cConn.ws.send(JSON.stringify({ t: 'send', room: rid, tmpId: 'own', ct: ctC, recipients: [C.fp] }));
    await waitFor(cConn.frames, f => f.t === 'msg' && f.m.tmpId === 'own');

    // a mod gets in and can post too
    const mConn = await connect(mod.cookie());
    mConn.ws.send(JSON.stringify({ t: 'hello', room: rid, fp: C.fp, handle: 'morgan' }));
    const mWelcome = await waitFor(mConn.frames, f => f.t === 'welcome' || f.t === 'err');
    assert.equal(mWelcome.t, 'welcome', JSON.stringify(mWelcome));
    assert.equal(mWelcome.canPost, true, 'a mod can post through a freeze');
    cConn.ws.close();
    mConn.ws.close();
  });

  await t.test('a ban drops the live socket and refuses the next hello', async () => {
    // casey's key has to exist in this room before a socket may say hello with it
    const regC = await user('POST', '/api/rooms/lounge/keys', JSON.stringify({ room: 'lounge', fp: C.fp, keyId: C.keyId, handle: 'casey', publicKey: C.publicKey }));
    assert.equal(regC.status, 200);

    const connCasey = await connect(user.cookie());
    connCasey.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: C.fp, handle: 'casey' }));
    await waitFor(connCasey.frames, f => f.t === 'welcome');

    const banned = await mod('POST', '/api/mod/ban', JSON.stringify({ target: 'casey', hours: 2, reason: 'testing' }));
    assert.equal(banned.status, 200);
    assert.ok(banned.body.ban.until, 'a temp ban carries an expiry');
    await waitFor(connCasey.frames, f => f.t === 'kick');
    await new Promise(r => setTimeout(r, 200));

    const relogin = await makeClient()('POST', '/api/auth/login', JSON.stringify({ username: 'casey', password: 'user-password-1' }));
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.banned, true);

    const lifted = await admin('POST', '/api/mod/unban', JSON.stringify({ kind: 'account', target: 'casey', room: null }));
    assert.ok(lifted.body.removed >= 1);
    const after = await makeClient()('POST', '/api/auth/login', JSON.stringify({ username: 'casey', password: 'user-password-1' }));
    assert.equal(after.status, 200, 'unban restores access');
    // the ban dropped casey's earlier session, so this client signs back in
    const rejoin = await user('POST', '/api/auth/login', JSON.stringify({ username: 'casey', password: 'user-password-1' }));
    assert.equal(rejoin.status, 200);
  });

  await t.test('admin settings: disabling new rooms binds users, not admins', async () => {
    const off = await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowNewRooms: false }));
    assert.equal(off.body.settings.allowNewRooms, false);
    assert.equal((await user('POST', '/api/rooms', JSON.stringify({ name: 'Denied' }))).status, 403);
    assert.equal((await admin('POST', '/api/rooms', JSON.stringify({ name: 'Admin Makes This' }))).status, 201);
    const on = await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowNewRooms: true }));
    assert.equal(on.body.settings.allowNewRooms, true);
  });

  await t.test('the admin log is staff-only, hides admin rows from mods, and never serves the bootstrap code', async () => {
    assert.equal((await user('GET', '/api/admin/events')).status, 403, 'ordinary members cannot read the log');

    const asMod = await mod('GET', '/api/admin/events?limit=200');
    assert.equal(asMod.status, 200);
    const modTypes = new Set(asMod.body.events.map(e => e.type));
    assert.ok(modTypes.size > 0, 'staff see the trail');
    assert.ok(!['settings', 'role', 'admin-claimed', 'lockdown', 'account-op'].some(t => modTypes.has(t)),
      'mods do not get admin-only rows');
    assert.ok(asMod.body.events.every(e => e.ip === undefined), 'mods do not get IP addresses');

    const asAdmin = await admin('GET', '/api/admin/events?limit=200');
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.events.length > 0);
    assert.ok(asAdmin.body.events.every(e => e.type !== 'admin-claim'), 'the bootstrap code is never served');
    assert.ok(asAdmin.body.events.some(e => e.type === 'role'), 'admins see role changes');
    assert.ok(asAdmin.body.events.every(e => typeof e.t === 'number'), 'rows carry their own timestamp');

    const onlyBans = await admin('GET', '/api/admin/events?type=join&limit=5');
    assert.ok(onlyBans.body.events.every(e => e.type === 'join'), 'the type filter works');
    assert.ok(onlyBans.body.events.length <= 5);

    const dump = await fetch(`${BASE}/api/admin/events/export`, { headers: { Cookie: admin.cookie() } });
    assert.equal(dump.status, 200);
    const text = await dump.text();
    const rows = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(rows.length > 0, 'the export is jsonl');
    assert.ok(rows.every(e => e.type !== 'admin-claim'), 'the export hides the bootstrap code too');
    const refused = await fetch(`${BASE}/api/admin/events/export`, { headers: { Cookie: mod.cookie() } });
    assert.equal(refused.status, 403, 'a mod cannot download the log');
  });

  await t.test('an announcement is a relay notice, not a message', async () => {
    const N = await makeKey('watcher');
    const watcher = makeClient();
    await watcher('POST', '/api/auth/register', JSON.stringify({ username: 'noticewatcher', password: 'notice-watch-1' }));
    await watcher('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: N.fp, keyId: N.keyId, handle: 'noticewatcher', publicKey: N.publicKey }));
    const conn = await connect(watcher.cookie());
    conn.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: N.fp, handle: 'noticewatcher' }));
    await waitFor(conn.frames, f => f.t === 'welcome');

    const before = (await api('/healthz')).body.messages;
    const sent = await admin('POST', '/api/admin/announce', JSON.stringify({ room: 'lounge', text: 'the box reboots in ten minutes' }));
    assert.equal(sent.status, 200);
    assert.equal(sent.body.rooms, 1);

    const notice = await waitFor(conn.frames, f => f.t === 'sys' && f.notice === true);
    assert.match(notice.text, /Relay notice — the box reboots in ten minutes/);
    assert.equal((await api('/healthz')).body.messages, before, 'a notice is never stored as a message');
    assert.equal((await admin('POST', '/api/admin/announce', JSON.stringify({ room: 'lounge', text: ' ' }))).status, 400, 'empty notices are refused');
    conn.ws.close();
  });

  await t.test('lockdown freezes every room, stops guests and closes signups; lifting clears the freezes', async () => {
    const on = await admin('POST', '/api/admin/lockdown', JSON.stringify({ on: true }));
    assert.equal(on.status, 200);
    assert.equal(on.body.lockdown, true);
    assert.equal(on.body.settings.allowNewRooms, false, 'new rooms are off while locked down');
    assert.equal(on.body.settings.guestAccess, false, 'guests are off while locked down');
    assert.ok(on.body.rooms.length > 0 && on.body.rooms.every(r => r.frozen), 'every room is frozen');

    const late = makeClient();
    assert.equal((await late('POST', '/api/auth/register', JSON.stringify({ username: 'latecomer', password: 'too-late-now-1' }))).status, 403,
      'signups are closed while locked down');
    assert.equal((await makeClient()('POST', '/api/guest', JSON.stringify({ handle: 'nope-nope-1' }))).status, 403, 'guests are refused');

    const off = await admin('POST', '/api/admin/lockdown', JSON.stringify({ on: false }));
    assert.equal(off.body.lockdown, false);
    assert.ok(off.body.rooms.every(r => !r.frozen), 'lifting lockdown clears the freezes');
    assert.equal(off.body.settings.allowRegistration, false, 'the switches stay where the lockdown left them');
    // Lifting is not a policy reset: the operator puts the switches back himself.
    const restored = await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowNewRooms: true, guestAccess: true, allowRegistration: true }));
    assert.equal(restored.body.settings.allowRegistration, true);
    assert.equal((await late('POST', '/api/auth/register', JSON.stringify({ username: 'latecomer', password: 'too-late-now-1' }))).status, 201,
      'with signups back on, an account can be made again');
    assert.equal((await makeClient()('POST', '/api/guest', JSON.stringify({ handle: 'now-allowed-1' }))).status, 201, 'guests are welcome again');
  });

  await t.test('slow mode throttles one identity in a room and spares moderators', async () => {
    const made = await admin('POST', '/api/rooms', JSON.stringify({ name: 'Slow Room' }));
    assert.equal(made.status, 201);
    const slowRoom = made.body.room.id;
    const patched = await admin('PATCH', `/api/rooms/${slowRoom}`, JSON.stringify({ slowMs: 5000 }));
    assert.equal(patched.status, 200);
    assert.equal(patched.body.room.slowMs, 5000, 'the floor is published to clients');

    const S = await makeKey('slow');
    const slowpoke = makeClient();
    await slowpoke('POST', '/api/auth/register', JSON.stringify({ username: 'slowpoke', password: 'slow-poke-pass-1' }));
    await slowpoke('POST', '/api/keys', JSON.stringify({ room: slowRoom, fp: S.fp, keyId: S.keyId, handle: 'slowpoke', publicKey: S.publicKey }));
    const conn = await connect(slowpoke.cookie());
    conn.ws.send(JSON.stringify({ t: 'hello', room: slowRoom, fp: S.fp, handle: 'slowpoke' }));
    await waitFor(conn.frames, f => f.t === 'welcome');

    const blob = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'first' }), encryptionKeys: [await openpgp.readKey({ armoredKey: S.publicKey })], signingKeys: S.priv, format: 'armored' });
    conn.ws.send(JSON.stringify({ t: 'send', room: slowRoom, tmpId: 'one', ct: blob, recipients: [S.fp] }));
    await waitFor(conn.frames, f => f.t === 'msg' && f.m.tmpId === 'one');
    conn.ws.send(JSON.stringify({ t: 'send', room: slowRoom, tmpId: 'two', ct: blob, recipients: [S.fp] }));
    const refused = await waitFor(conn.frames, f => f.t === 'err' && /slow mode/.test(f.msg));
    assert.match(refused.msg, /slow mode/);

    // the admin sets the pace, so the admin is not held to it
    const A = await makeKey('boss');
    await admin('POST', '/api/keys', JSON.stringify({ room: slowRoom, fp: A.fp, keyId: A.keyId, handle: 'jay', publicKey: A.publicKey }));
    const bossConn = await connect(admin.cookie());
    bossConn.ws.send(JSON.stringify({ t: 'hello', room: slowRoom, fp: A.fp, handle: 'jay' }));
    await waitFor(bossConn.frames, f => f.t === 'welcome');
    const bossBlob = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'staff' }), encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })], signingKeys: A.priv, format: 'armored' });
    bossConn.ws.send(JSON.stringify({ t: 'send', room: slowRoom, tmpId: 'b1', ct: bossBlob, recipients: [A.fp] }));
    await waitFor(bossConn.frames, f => f.t === 'msg' && f.m.tmpId === 'b1');
    bossConn.ws.send(JSON.stringify({ t: 'send', room: slowRoom, tmpId: 'b2', ct: bossBlob, recipients: [A.fp] }));
    await waitFor(bossConn.frames, f => f.t === 'msg' && f.m.tmpId === 'b2');

    await admin('PATCH', `/api/rooms/${slowRoom}`, JSON.stringify({ slowMs: 0 }));
    conn.ws.close();
    bossConn.ws.close();
  });

  await t.test('the developer seat: box-set, above admin, never mintable over the wire', async () => {
    assert.equal((await admin('POST', '/api/admin/role', JSON.stringify({ username: 'casey', role: 'developer' }))).status, 403, 'no one mints a developer through the API');

    // Documented out-of-band path: edit accounts.json and restart.
    srv.proc.kill('SIGTERM');
    await sleep(600);
    const accountsFile = path.join(dir, 'data', 'accounts.json');
    const accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
    for (const a of accounts.accounts) if (a.username === 'jay') a.role = 'developer';
    await writeFile(accountsFile, JSON.stringify(accounts));
    srv = await startServer(cfgPath);
    procs.push(srv.proc);

    assert.equal((await admin('GET', '/api/me')).body.me.role, 'developer', 'the seat reads back');
    assert.equal((await api('/healthz')).body.adminClaimable, false, 'a developer counts as the seat being taken');

    // The developer outranks admin: promote a plain member to admin, then demote past it.
    assert.equal((await admin('POST', '/api/admin/role', JSON.stringify({ username: 'casey', role: 'admin' }))).status, 200, 'the developer promotes an admin');
    const cAdmin = makeClient();
    await cAdmin('POST', '/api/auth/login', JSON.stringify({ username: 'casey', password: 'user-password-1' }));
    assert.equal((await cAdmin('POST', '/api/admin/role', JSON.stringify({ username: 'jay', role: 'user' }))).status, 403, 'an admin cannot demote the developer');
    assert.equal((await cAdmin('POST', '/api/admin/role', JSON.stringify({ username: 'morgan', role: 'developer' }))).status, 403, 'an admin cannot mint a developer');
    assert.equal((await cAdmin('POST', '/api/admin/account', JSON.stringify({ username: 'morgan', op: 'fx', fx: 'glitch' }))).status, 403, 'only the developer hands out name effects');
    assert.equal((await admin('POST', '/api/admin/role', JSON.stringify({ username: 'casey', role: 'user' }))).status, 200, 'the developer may demote an admin past it');
  });

  await t.test('name effects: applied or unlocked by the developer, self-picked when unlocked, map on /api/me', async () => {
    assert.equal((await user('POST', '/api/me/fx', JSON.stringify({ fx: 'rainbow' }))).status, 403, 'a locked account cannot pick');
    const applied = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'casey', op: 'fx', fx: 'glitch', fxAllowed: true }));
    assert.equal(applied.status, 200);
    assert.equal(applied.body.fx, 'glitch', 'the developer applied an effect');
    assert.equal((await admin('GET', '/api/me')).body.fx.casey, 'glitch', 'the fx map rides on /api/me for every client');
    const ov = await admin('GET', '/api/admin/overview');
    assert.equal(ov.body.accounts.find(a => a.username === 'casey').fxAllowed, true);

    // Unlocked: the account picks its own, and the change is audited.
    const pick = await user('POST', '/api/me/fx', JSON.stringify({ fx: 'aurora' }));
    assert.equal(pick.status, 200);
    assert.equal(pick.body.me.fx, 'aurora');
    assert.equal((await admin('GET', '/api/me')).body.fx.casey, 'aurora');
    const logged = await admin('GET', '/api/admin/events?type=fx');
    assert.ok(logged.body.events.some(e => e.username === 'casey' && e.fx === 'aurora'), 'effects are audited');

    // Junk is refused; revoking the unlock closes the picker again.
    assert.equal((await user('POST', '/api/me/fx', JSON.stringify({ fx: 'definitely-not-an-effect' }))).status, 400);
    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'casey', op: 'fx', fx: null, fxAllowed: false }))).status, 200);
    assert.equal((await admin('GET', '/api/me')).body.fx.casey, undefined, 'cleared');
    assert.equal((await user('POST', '/api/me/fx', JSON.stringify({ fx: 'rainbow' }))).status, 403, 'the lock re-arms');
  });

  await t.test('an admin can sign an account out everywhere, delete it, and never orphan its rooms', async () => {
    const temp = makeClient();
    await temp('POST', '/api/auth/register', JSON.stringify({ username: 'tempuser', password: 'temporary-pass-1' }));
    const owned = await temp('POST', '/api/rooms', JSON.stringify({ name: 'Temp Room' }));
    assert.equal(owned.status, 201);
    const rid = owned.body.room.id;

    const out = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'tempuser', op: 'signout' }));
    assert.equal(out.status, 200);
    assert.ok(out.body.sessions >= 1, 'their sessions are dropped');
    assert.equal((await temp('GET', '/api/me')).status, 401, 'the session is really gone');

    await temp('POST', '/api/auth/login', JSON.stringify({ username: 'tempuser', password: 'temporary-pass-1' }));
    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'tempuser', op: 'delete' }))).status, 200);
    const overview = await admin('GET', '/api/admin/overview');
    assert.ok(!overview.body.accounts.some(a => a.username === 'tempuser'), 'the account is gone');
    assert.ok(overview.body.rooms.some(r => r.id === rid && r.owner === 'jay'), 'their room passed to the acting admin');

    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'jay', op: 'delete' }))).status, 400, 'nobody deletes themselves');
    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'nobody-here', op: 'signout' }))).status, 404);
  });

  await t.test('a freeze locks the account door: sessions out, sign-in refused, unfreeze restores', async () => {
    const iceman = makeClient();
    await iceman('POST', '/api/auth/register', JSON.stringify({ username: 'iceman', password: 'iceman-pass-1' }));
    assert.equal((await iceman('GET', '/api/me')).status, 200, 'signed in before the freeze');

    const frozen = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'iceman', op: 'freeze', frozen: true }));
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.frozen, true);
    assert.ok(frozen.body.sessions >= 1, 'their sessions are dropped');
    assert.equal((await iceman('GET', '/api/me')).status, 401, 'the live session is really gone');

    const blocked = await iceman('POST', '/api/auth/login', JSON.stringify({ username: 'iceman', password: 'iceman-pass-1' }));
    assert.equal(blocked.status, 403, 'sign-in is refused while frozen');
    assert.equal(blocked.body.frozen, true, 'the refusal says why');

    const row = (await admin('GET', '/api/admin/overview')).body.accounts.find(a => a.username === 'iceman');
    assert.equal(row.frozen, true, 'the freeze shows on the account list');

    // Mods cannot freeze; admin seats are never a target.
    assert.equal((await mod('POST', '/api/admin/account', JSON.stringify({ username: 'iceman', op: 'freeze', frozen: true }))).status, 403, 'mods cannot freeze');
    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'jay', op: 'freeze', frozen: true }))).status, 400, 'not yourself');

    const unfrozen = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'iceman', op: 'freeze', frozen: false }));
    assert.equal(unfrozen.status, 200);
    assert.equal((await iceman('POST', '/api/auth/login', JSON.stringify({ username: 'iceman', password: 'iceman-pass-1' }))).status, 200, 'unfreeze lets them back in');
    await admin('POST', '/api/admin/account', JSON.stringify({ username: 'iceman', op: 'delete' }));
  });

  await t.test('mods read the staff overview; the live session list stays admin-only', async () => {
    const ov = await mod('GET', '/api/admin/overview');
    assert.equal(ov.status, 200, 'mods load the overview the staff pages render from');
    assert.deepEqual(ov.body.sessionList, [], 'mods never see live session rows');
    assert.ok(Array.isArray((await admin('GET', '/api/admin/overview')).body.sessionList), 'admins keep them');
  });

  await t.test('an admin can burn a room’s stored ciphertext on the spot', async () => {
    const loungeRows = async () => ((await admin('GET', '/api/admin/overview')).body.perRoom.find(r => r.id === 'lounge') || {}).messages || 0;
    const before = await loungeRows();
    assert.ok(before > 0, 'the lounge has rows from the message tests');
    const burned = await admin('POST', '/api/admin/purge', JSON.stringify({ room: 'lounge' }));
    assert.equal(burned.status, 200);
    assert.ok(burned.body.purgedRows > 0, 'rows were shredded');
    assert.equal(await loungeRows(), 0, 'memory is empty too');
    const segDir = path.join(dir, 'data', 'rooms', 'lounge', 'messages');
    for (const f of (await readdir(segDir)).filter(f => f.endsWith('.jsonl'))) {
      assert.equal((await readFile(path.join(segDir, f), 'utf8')).trim(), '', `segment not emptied: ${f}`);
    }
    assert.equal((await admin('POST', '/api/admin/purge', JSON.stringify({ room: 'no-such-room' }))).status, 404);
  });

  await t.test('attachments are off by default and need both switches', async () => {
    const poster = makeClient();
    await poster('POST', '/api/auth/register', JSON.stringify({ username: 'poster', password: 'poster-pass-1' }));
    await poster('POST', '/api/rooms/lounge/join');           // posting rights come with membership
    const blob = Buffer.from('ciphertext stand-in for a picture');
    const upload = (client, kind, body = blob) => fetch(`${BASE}/api/rooms/lounge/files`, {
      method: 'POST', headers: { Cookie: client.cookie(), 'X-Content-Kind': kind, 'Content-Type': 'application/octet-stream' }, body,
    });

    // Site switch first: nothing is allowed out of the box.
    assert.equal((await upload(poster, 'image')).status, 403, 'attachments are off site-wide by default');

    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowImages: true }));
    assert.equal((await upload(poster, 'image')).status, 403, 'the room switch is a second gate');

    await admin('PATCH', '/api/rooms/lounge', JSON.stringify({ allowFiles: true }));
    const up = await upload(poster, 'image');
    assert.equal(up.status, 201, 'with both switches on the upload lands');
    const { id, size } = await up.json();
    assert.equal(size, blob.length);
    assert.match(id, /^[a-z0-9]{32}$/);

    // The blob round-trips byte for byte for a room reader…
    const got = await fetch(`${BASE}/api/rooms/lounge/files/${id}`, { headers: { Cookie: poster.cookie() } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(got.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), blob), 0, 'the stored bytes are what was sent');

    // …and only for a room reader: a stranger gets nothing useful.
    const stranger = makeClient();
    assert.equal((await fetch(`${BASE}/api/rooms/lounge/files/${id}`, { headers: { Cookie: stranger.cookie() } })).status, 401);
    assert.equal((await fetch(`${BASE}/api/rooms/lounge/files/${id}`)).status, 401);

    // Video has its own switch, still off.
    assert.equal((await upload(poster, 'video')).status, 403, 'video is a separate switch');
    assert.equal((await upload(poster, 'nonsense')).status, 400, 'unknown kinds are refused');

    // Over the cap: refused before anything is written.
    const huge = Buffer.alloc(9 * 1024 * 1024, 1);
    assert.equal((await upload(poster, 'image', huge)).status, 413, 'the size cap holds');

    // The relay only ever sees ciphertext, and the activity log records the upload.
    const blobDir = path.join(dir, 'data', 'rooms', 'lounge', 'files');
    const stored = await readFile(path.join(blobDir, `${id}.bin`));
    assert.equal(Buffer.compare(stored, blob), 0);
    const log = await admin('GET', '/api/admin/events?type=file');
    assert.ok(log.body.events.some(e => e.bytes === blob.length), 'the upload is in the activity log');

    assert.equal((await api('/healthz')).body.files >= 1, true, 'healthz counts stored attachments');
  });

  await t.test('messages can be deleted and edited, and the site decides who may', async () => {
    // Two accounts with keys in the lounge: one author, one stranger, plus the mod.
    const A = await makeKey('author');
    const B = await makeKey('bystander');
    const author = makeClient();
    await author('POST', '/api/auth/register', JSON.stringify({ username: 'author', password: 'author-pass-1' }));
    await author('POST', '/api/rooms/lounge/join');
    await author('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: A.fp, keyId: A.keyId, handle: 'author', publicKey: A.publicKey }));
    const bystander = makeClient();
    await bystander('POST', '/api/auth/register', JSON.stringify({ username: 'bystander', password: 'bystander-pass-1' }));
    await bystander('POST', '/api/rooms/lounge/join');

    const conn = await connect(author.cookie());
    conn.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: A.fp, handle: 'author' }));
    await waitFor(conn.frames, f => f.t === 'welcome');

    const seal = async (text) => openpgp.encrypt({
      message: await openpgp.createMessage({ text }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      signingKeys: A.priv,
      format: 'armored',
    });
    const send = async (tmpId, text) => {
      conn.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId, ct: await seal(text), recipients: [A.fp] }));
      const frame = await waitFor(conn.frames, f => f.t === 'msg' && f.m.tmpId === tmpId);
      return frame.m.id;
    };

    const first = await send('edit-me', 'the original wording');
    const second = await send('delete-me', 'this one goes away');

    // Deleting your own message: ciphertext gone, a tombstone stays so the timeline holds.
    const del = await author('DELETE', `/api/rooms/lounge/messages/${second}`);
    assert.equal(del.status, 200);
    const tomb = await waitFor(conn.frames, f => f.t === 'msg-del' && f.id === second);
    assert.equal(tomb.by, 'author', 'the room hears who did it');

    const rowsFile = path.join(dir, 'data', 'rooms', 'lounge', 'messages');
    const day = (await readdir(rowsFile)).sort().pop();
    const disk = await readFile(path.join(rowsFile, day), 'utf8');
    assert.ok(!disk.includes('this one goes away'), 'the ciphertext is not on disk any more');
    const row = JSON.parse(disk.split('\n').filter(Boolean).find(l => JSON.parse(l).id === second));
    assert.equal(row.deleted, true);
    assert.equal(row.ct, null, 'a tombstone holds no ciphertext');
    assert.ok(Array.isArray(row.recipients) && row.recipients.length, 'the recipient list survives, or nobody would learn it went');

    const hist = await author('GET', `/api/rooms/lounge/history?fp=${A.fp}`);
    const hrow = hist.body.messages.find(m => m.id === second);
    assert.equal(hrow.deleted, true);
    assert.equal(hrow.ct, null);

    // Editing your own message replaces the ciphertext and marks it.
    const edited = await seal('the corrected wording');
    const edit = await author('POST', `/api/rooms/lounge/messages/${first}`, JSON.stringify({ ct: edited, recipients: [A.fp] }));
    assert.equal(edit.status, 200);
    assert.ok(edit.body.edited, 'the relay marks when it was edited');
    const frame = await waitFor(conn.frames, f => f.t === 'msg-edit' && f.id === first);
    assert.equal(frame.ct, edited, 'everyone in the room gets the new ciphertext');
    const disk2 = await readFile(path.join(rowsFile, day), 'utf8');
    assert.ok(!disk2.includes('the original wording'), 'the superseded ciphertext was shredded, not kept alongside');

    // Somebody else's message is not yours to touch, in either direction.
    assert.equal((await bystander('DELETE', `/api/rooms/lounge/messages/${first}`)).status, 403);
    assert.equal((await bystander('POST', `/api/rooms/lounge/messages/${first}`, JSON.stringify({ ct: edited, recipients: [A.fp] }))).status, 403);
    assert.equal((await bystander('DELETE', `/api/rooms/lounge/messages/${second}`)).status, 403, 'not even a message that is already deleted');

    // Staff can moderate a message away, but never rewrite somebody's words.
    const staffDel = await mod('DELETE', `/api/rooms/lounge/messages/${first}`);
    assert.equal(staffDel.status, 200, 'a moderator can delete anyone’s message');
    const staffEdit = await mod('POST', `/api/rooms/lounge/messages/${second}`, JSON.stringify({ ct: edited, recipients: [A.fp] }));
    assert.equal(staffEdit.status, 403, 'nobody edits another account’s message');

    // The switches: with deletion off, only staff may do it; with editing off, nobody may.
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowMsgDelete: false }));
    const third = await send('policy-1', 'policy check');
    assert.equal((await author('DELETE', `/api/rooms/lounge/messages/${third}`)).status, 403, 'the author is stopped when the switch is off');
    assert.equal((await mod('DELETE', `/api/rooms/lounge/messages/${third}`)).status, 200, 'staff still moderate');
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowMsgDelete: true, allowMsgEdit: false }));
    const fourth = await send('policy-2', 'edit policy check');
    assert.equal((await author('POST', `/api/rooms/lounge/messages/${fourth}`, JSON.stringify({ ct: edited, recipients: [A.fp] }))).status, 403, 'editing is off');
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowMsgEdit: true }));

    // A deleted message cannot be deleted or edited twice, and a stranger cannot reach it at all.
    assert.equal((await author('DELETE', `/api/rooms/lounge/messages/${second}`)).status, 409);
    assert.equal((await author('POST', `/api/rooms/lounge/messages/${second}`, JSON.stringify({ ct: edited }))).status, 400);
    assert.equal((await fetch(`${BASE}/api/rooms/lounge/messages/${first}`, { method: 'DELETE' })).status, 401, 'no session, no message ops');
    assert.equal((await author('DELETE', '/api/rooms/lounge/messages/not-a-real-id-0000')).status, 404);

    const log = await admin('GET', '/api/admin/events?type=msg-delete');
    assert.ok(log.body.events.length >= 2, 'deletions are in the activity log');
    conn.ws.close();
  });

  await t.test('a mute stops posting without ending the session', async () => {
    const M = await makeKey('muted');
    const target = makeClient();
    await target('POST', '/api/auth/register', JSON.stringify({ username: 'murky', password: 'murky-pass-111' }));
    await target('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: M.fp, keyId: M.keyId, handle: 'murky', publicKey: M.publicKey }));
    const conn = await connect(target.cookie());
    conn.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: M.fp, handle: 'murky' }));
    const welcome = await waitFor(conn.frames, f => f.t === 'welcome');
    assert.equal(welcome.muted, false);

    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'before the mute' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: M.publicKey })],
      signingKeys: M.priv,
      format: 'armored',
    });
    conn.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'pre-mute', ct, recipients: [M.fp] }));
    await waitFor(conn.frames, f => f.t === 'msg' && f.m.tmpId === 'pre-mute');

    const muted = await admin('POST', '/api/mod/ban', JSON.stringify({ target: 'murky', kind: 'account', room: null, hours: 1, mute: true, reason: 'cool off' }));
    assert.equal(muted.status, 200);
    assert.equal(muted.body.mute, true);
    assert.equal(muted.body.kicked, 0, 'a mute does not drop the connection');

    const before = conn.frames.length;
    conn.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'muted-send', ct, recipients: [M.fp] }));
    const refusal = await waitFor(conn.frames, f => f.t === 'err' && /muted/.test(f.msg || ''));
    assert.match(refusal.msg, /cool off/);
    assert.ok(conn.frames.length > before, 'the refusal came back on the same socket');

    // They keep reading: the socket still answers, and they can still sign in.
    conn.ws.send(JSON.stringify({ t: 'ping' }));
    await waitFor(conn.frames, f => f.t === 'pong');
    assert.equal((await target('GET', '/api/me')).status, 200, 'a mute is not a lockout');

    const bans = await mod('GET', '/api/mod/bans');
    const rec = bans.body.bans.find(b => b.target === 'murky' && b.mute);
    assert.ok(rec, 'the mute is listed as a mute');
    assert.equal((await admin('POST', '/api/mod/unban', JSON.stringify({ id: rec.id }))).status, 200);

    const after = conn.frames.length;
    conn.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'after-mute', ct, recipients: [M.fp] }));
    await waitFor(conn.frames, f => f.t === 'msg' && f.m.tmpId === 'after-mute');
    assert.ok(conn.frames.length > after, 'posting works again once the mute is lifted');
    conn.ws.close();
  });

  await t.test('voice notes: their own site switch, sealed blobs, and the room gate too', async () => {
    const V = await makeKey('voicy');
    const talker = makeClient();
    await talker('POST', '/api/auth/register', JSON.stringify({ username: 'talker', password: 'talker-pass-1' }));
    await talker('POST', '/api/rooms/lounge/join');
    await talker('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: V.fp, keyId: V.keyId, handle: 'talker', publicKey: V.publicKey }));
    const blob = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 1, 2, 3, 4, 5, 6, 7, 8]);
    const upload = (pathname, kind = 'voice', body = blob) => fetch(BASE + pathname, {
      method: 'POST', headers: { Cookie: talker.cookie(), 'X-Content-Kind': kind, 'Content-Type': 'application/octet-stream' }, body,
    });

    // Off out of the box, even though pictures were allowed on above.
    assert.equal((await upload('/api/rooms/lounge/files')).status, 403, 'voice has its own site switch');

    // Site switch on, then the room gate: a fresh room takes no attachments yet.
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowVoice: true }));
    const mk = await talker('POST', '/api/rooms', JSON.stringify({ name: 'Voice Room' }));
    const rid = mk.body.room.id;
    assert.equal((await upload(`/api/rooms/${rid}/files`)).status, 403, 'the room switch is the second gate for voice too');
    await talker('PATCH', `/api/rooms/${rid}`, JSON.stringify({ allowFiles: true }));
    const up = await upload(`/api/rooms/${rid}/files`);
    assert.equal(up.status, 201, 'with the site switch on, the clip lands');
    const { id, size } = await up.json();
    assert.equal(size, blob.length);

    // Byte-for-byte round-trip for a member; the disk copy is the same opaque blob.
    const got = await fetch(`${BASE}/api/rooms/${rid}/files/${id}`, { headers: { Cookie: talker.cookie() } });
    assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), blob), 0);
    const stored = await readFile(path.join(dir, 'data', 'rooms', rid, 'files', `${id}.bin`));
    assert.equal(Buffer.compare(stored, blob), 0, 'the relay holds the sealed bytes and nothing else');
  });

  await t.test('friends, blocks and DMs: account-level, sealed, and gated', async () => {
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ allowVoice: true }));
    const A = await makeKey('dmal');
    const B = await makeKey('dmb');
    const al = makeClient();
    const br = makeClient();
    await al('POST', '/api/auth/register', JSON.stringify({ username: 'dmalpha', password: 'dmalpha-pass-1' }));
    await al('POST', '/api/rooms/lounge/join');
    await al('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: A.fp, keyId: A.keyId, handle: 'dmalpha', publicKey: A.publicKey }));
    await br('POST', '/api/auth/register', JSON.stringify({ username: 'dmbravo', password: 'dmbravo-pass-1' }));
    await br('POST', '/api/rooms/lounge/join');
    await br('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: B.fp, keyId: B.keyId, handle: 'dmbravo', publicKey: B.publicKey }));

    // Guests have no name, so no people directory, no friends, no DMs.
    await admin('PATCH', '/api/admin/settings', JSON.stringify({ guestAccess: true }));
    const spy = makeClient();
    assert.equal((await spy('POST', '/api/guest', JSON.stringify({ handle: 'spy-guest' }))).status, 201);
    assert.equal((await spy('GET', '/api/users')).status, 403);
    assert.equal((await spy('GET', '/api/friends')).status, 403);
    assert.equal((await spy('GET', '/api/dm/dmalpha')).status, 403);

    // Discovery: search finds the name and knows it is not a friend yet.
    const found = await al('GET', '/api/users?q=dmbravo');
    assert.equal(found.body.users[0].username, 'dmbravo');
    assert.equal(found.body.users[0].friend, false);

    // Request → incoming → accept, and friendship lands on both sides.
    assert.equal((await al('POST', '/api/friends/request', JSON.stringify({ username: 'dmbravo' }))).status, 200);
    const inc = await br('GET', '/api/friends');
    assert.equal(inc.body.incoming[0].username, 'dmalpha');
    assert.equal(inc.body.friends.length, 0);
    assert.equal((await br('POST', '/api/friends/accept', JSON.stringify({ username: 'dmalpha' }))).status, 200);
    assert.ok((await al('GET', '/api/friends')).body.friends.some(f => f.username === 'dmbravo'), 'friendship lands both ways');
    assert.equal((await br('POST', '/api/friends/accept', JSON.stringify({ username: 'dmalpha' }))).status, 400, 'nothing left to accept');

    // The thread hands the client exactly what it needs to seal: the partner's key.
    const th = await al('GET', '/api/dm/dmbravo');
    assert.equal(th.status, 200);
    assert.equal(th.body.publicKey, B.publicKey);
    assert.equal(th.body.fp, B.fp);

    // Live DMs across two sockets.
    const ca = await connect(al.cookie());
    ca.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: A.fp, handle: 'dmalpha' }));
    await waitFor(ca.frames, f => f.t === 'welcome');
    const cb = await connect(br.cookie());
    cb.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: B.fp, handle: 'dmbravo' }));
    await waitFor(cb.frames, f => f.t === 'welcome');

    const ct1 = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'hi bravo, this is sealed' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: B.publicKey }), await openpgp.readKey({ armoredKey: A.publicKey })],
      signingKeys: A.priv,
      format: 'armored',
    });
    ca.ws.send(JSON.stringify({ t: 'dm', to: 'dmbravo', tmpId: 'dmt1', ct: ct1 }));
    const echo = await waitFor(ca.frames, f => f.t === 'dm' && f.tmpId === 'dmt1', 5000, 'sender echo');
    assert.equal(echo.m.from, 'dmalpha');
    const delivered = await waitFor(cb.frames, f => f.t === 'dm' && f.m.from === 'dmalpha' && f.m.ct === ct1, 5000, 'delivery');
    assert.ok(delivered.m.ct.startsWith('-----BEGIN PGP MESSAGE-----'), 'only ciphertext crosses the wire');

    // Bravo opens it; the relay never held anything but the armored blob.
    const { data } = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: delivered.m.ct }),
      decryptionKeys: B.priv,
      verificationKeys: await openpgp.readKey({ armoredKey: A.publicKey }),
      format: 'utf8',
    });
    assert.equal(data, 'hi bravo, this is sealed');

    // History and unread marks agree between devices.
    assert.equal((await br('GET', '/api/dm/dmalpha')).body.messages.length, 1);
    assert.equal((await br('GET', '/api/friends')).body.friends.find(f => f.username === 'dmalpha').unread, 1, 'unread counts what bravo has not opened');
    await br('POST', '/api/dm/dmalpha/read');
    assert.equal((await br('GET', '/api/friends')).body.friends.find(f => f.username === 'dmalpha').unread, 0);

    // DM attachments: a sealed voice note, same contract as rooms.
    const blob = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6, 5]);
    const upRes = await fetch(`${BASE}/api/dm/dmbravo/files`, {
      method: 'POST', headers: { Cookie: al.cookie(), 'X-Content-Kind': 'voice', 'Content-Type': 'application/octet-stream' }, body: blob,
    });
    assert.equal(upRes.status, 201, 'voice is allowed in DMs once the site switch is on');
    const { id: voiceId } = await upRes.json();
    const got = await fetch(`${BASE}/api/dm/dmalpha/files/${voiceId}`, { headers: { Cookie: br.cookie() } });
    assert.equal(got.status, 200, 'the other side can fetch the sealed blob');
    assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), blob), 0);
    assert.equal((await spy('GET', `/api/dm/dmalpha/files/${voiceId}`)).status, 403, 'guests cannot fetch DM blobs');

    // Block: silences DMs both ways and ends the friendship.
    assert.equal((await al('POST', '/api/friends/block', JSON.stringify({ username: 'dmbravo' }))).status, 200);
    const afterBlock = await al('GET', '/api/friends');
    assert.equal(afterBlock.body.friends.length, 0);
    assert.equal(afterBlock.body.blocked[0].username, 'dmbravo');
    cb.ws.send(JSON.stringify({ t: 'dm', to: 'dmalpha', ct: ct1 }));
    await waitFor(cb.frames, f => f.t === 'err' && /cannot be messaged/.test(f.msg || ''), 5000, 'block refusal');
    assert.equal((await br('POST', '/api/friends/request', JSON.stringify({ username: 'dmalpha' }))).status, 403, 'a blocked user cannot send requests either');

    // Unblock, request again, and the reverse request acts as the accept.
    assert.equal((await al('POST', '/api/friends/unblock', JSON.stringify({ username: 'dmbravo' }))).status, 200);
    assert.equal((await br('POST', '/api/friends/request', JSON.stringify({ username: 'dmalpha' }))).status, 200);
    assert.equal((await al('POST', '/api/friends/request', JSON.stringify({ username: 'dmbravo' }))).status, 200);
    assert.ok((await al('GET', '/api/friends')).body.friends.some(f => f.username === 'dmbravo'), 'asking back closes the loop');

    // Nonsense targets are refused.
    assert.equal((await al('GET', '/api/dm/nobody-here')).status, 404);
    assert.equal((await al('GET', '/api/dm/dmalpha')).status, 404, 'nobody DMs themselves');

    ca.ws.close();
    cb.ws.close();
  });

  await t.test('deleting an account scrubs its DMs and social traces', async () => {
    const G = await makeKey('ghosty');
    const K = await makeKey('keeper');
    const ghost = makeClient();
    const keep = makeClient();
    await ghost('POST', '/api/auth/register', JSON.stringify({ username: 'dmghost', password: 'dmghost-pass-1' }));
    await ghost('POST', '/api/rooms/lounge/join');
    await ghost('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: G.fp, keyId: G.keyId, handle: 'dmghost', publicKey: G.publicKey }));
    await keep('POST', '/api/auth/register', JSON.stringify({ username: 'dmkeeper', password: 'dmkeeper-pass-1' }));
    await keep('POST', '/api/rooms/lounge/join');
    await keep('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: K.fp, keyId: K.keyId, handle: 'dmkeeper', publicKey: K.publicKey }));

    await ghost('POST', '/api/friends/request', JSON.stringify({ username: 'dmkeeper' }));
    await keep('POST', '/api/friends/accept', JSON.stringify({ username: 'dmghost' }));

    const ck = await connect(keep.cookie());
    ck.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: K.fp, handle: 'dmkeeper' }));
    await waitFor(ck.frames, f => f.t === 'welcome');
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'see you never' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: G.publicKey }), await openpgp.readKey({ armoredKey: K.publicKey })],
      signingKeys: K.priv,
      format: 'armored',
    });
    ck.ws.send(JSON.stringify({ t: 'dm', to: 'dmghost', ct }));
    await waitFor(ck.frames, f => f.t === 'dm');
    assert.equal((await keep('GET', '/api/dm/dmghost')).body.messages.length, 1);

    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'dmghost', op: 'delete' }))).status, 200);

    assert.equal((await keep('GET', '/api/dm/dmghost')).status, 404, 'the thread is gone with the account');
    assert.equal((await keep('GET', '/api/friends')).body.friends.length, 0, 'the friendship was scrubbed too');
    let dmDirs = [];
    try { dmDirs = await readdir(path.join(dir, 'data', 'dms')); } catch { /* none left */ }
    assert.ok(!dmDirs.some(d => d.includes('dmghost')), 'no pair directory survives on disk');
    ck.ws.close();
  });

  await t.test('an admin can reset a password and revoke a single session', async () => {
    const victim = makeClient();
    await victim('POST', '/api/auth/register', JSON.stringify({ username: 'forgetful', password: 'forget-me-123' }));

    const list = await admin('GET', '/api/admin/sessions');
    assert.equal(list.status, 200);
    const mine = list.body.sessions.find(s => s.username === 'forgetful');
    assert.ok(mine, 'live sessions are listed');
    assert.equal(mine.id.length, 12);
    assert.ok(!('token' in mine), 'the raw token is never handed to the panel');

    const reset = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'forgetful', op: 'reset-password' }));
    assert.equal(reset.status, 200);
    assert.ok(reset.body.password.length >= 12, 'a new password comes back once');
    assert.equal((await victim('GET', '/api/me')).status, 401, 'the old sessions are gone');
    assert.equal((await makeClient()('POST', '/api/auth/login', JSON.stringify({ username: 'forgetful', password: 'forget-me-123' }))).status, 401, 'the old password no longer works');

    const again = makeClient();
    assert.equal((await again('POST', '/api/auth/login', JSON.stringify({ username: 'forgetful', password: reset.body.password }))).status, 200, 'the new one works');
    const list2 = await admin('GET', '/api/admin/sessions');
    const fresh = list2.body.sessions.find(s => s.username === 'forgetful');
    assert.equal((await admin('POST', '/api/admin/sessions', JSON.stringify({ id: fresh.id }))).status, 200);
    assert.equal((await again('GET', '/api/me')).status, 401, 'that one session is gone');
    assert.equal((await admin('POST', '/api/admin/sessions', JSON.stringify({ id: 'deadbeef0000' }))).status, 404);
  });

  await t.test('the account key is synced or replaced — never un-synced', async () => {
    const c = makeClient();
    await c('POST', '/api/auth/register', JSON.stringify({ username: 'syncfan', password: 'sync-me-please-1' }));
    let me = await c('GET', '/api/me');
    assert.equal(me.body.me.syncKey, false, 'a fresh account starts with no envelope');
    assert.ok(!('syncOptOut' in me.body.me), 'there is no opt-out field on the account contract any more');
    assert.equal((await c('GET', '/api/sync-key')).body.syncKey.enabled, false);

    const blob = 'A'.repeat(64);
    assert.equal((await c('PUT', '/api/sync-key', JSON.stringify({ blob }))).status, 200);
    const got = await c('GET', '/api/sync-key');
    assert.equal(got.body.syncKey.enabled, true);
    assert.equal(got.body.syncKey.blob, blob, 'the envelope round-trips to its owner');
    me = await c('GET', '/api/me');
    assert.equal(me.body.me.syncKey, true);
    assert.equal((await c('PUT', '/api/sync-key', JSON.stringify({ blob: 'short' }))).status, 400, 'a junk blob is refused');

    const g = makeClient();
    await g('POST', '/api/guest', JSON.stringify({ handle: 'g-sync-1' }));
    assert.equal((await g('GET', '/api/sync-key')).status, 403, 'guests have no account mailbox');
    assert.equal((await g('PUT', '/api/sync-key', JSON.stringify({ blob }))).status, 403);

    // Tied to the account: there is no detach, and the envelope survives the attempt.
    assert.equal((await c('DELETE', '/api/sync-key')).status, 403, 'un-syncing is refused outright');
    me = await c('GET', '/api/me');
    assert.equal(me.body.me.syncKey, true, 'the envelope is still there');
    assert.equal((await c('GET', '/api/sync-key')).body.syncKey.blob, blob);
  });

  await t.test('rotating the key replaces envelope, binding and room pools in one step', async () => {
    const K1 = await makeKey('rot-one');
    const K2 = await makeKey('rot-two');
    const c = makeClient();
    await c('POST', '/api/auth/register', JSON.stringify({ username: 'rotator', password: 'rotate-me-123' }));
    await c('POST', '/api/rooms/lounge/join');
    assert.equal((await c('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: K1.fp, keyId: K1.keyId, handle: 'rotator', publicKey: K1.publicKey }))).status, 200);

    // The normal upload carries the public half too: the binding lands with the envelope.
    const blob1 = 'B'.repeat(64);
    assert.equal((await c('PUT', '/api/sync-key', JSON.stringify({ blob: blob1, fp: K1.fp, keyId: K1.keyId, publicKey: K1.publicKey }))).status, 200);
    assert.equal((await c('GET', '/api/me')).body.me.keyFp, K1.fp, 'the uploaded key is bound immediately');
    assert.ok((await c('GET', '/api/rooms/lounge/pool')).body.keys.some(k => k.fp === K1.fp), 'the old key sits in the pool');

    // A wrong password changes nothing at all.
    const blob2 = 'C'.repeat(64);
    const denied = await c('POST', '/api/account/rotate-key', JSON.stringify({ password: 'not-my-password', blob: blob2, fp: K2.fp, keyId: K2.keyId, publicKey: K2.publicKey }));
    assert.equal(denied.status, 401);
    assert.equal((await c('GET', '/api/sync-key')).body.syncKey.blob, blob1, 'the old envelope is untouched');
    assert.equal((await c('GET', '/api/me')).body.me.keyFp, K1.fp, 'the old binding is untouched');

    // The real rotation: new envelope, new binding, old fingerprint out of every pool.
    const rot = await c('POST', '/api/account/rotate-key', JSON.stringify({ password: 'rotate-me-123', blob: blob2, fp: K2.fp, keyId: K2.keyId, publicKey: K2.publicKey }));
    assert.equal(rot.status, 200);
    assert.equal(rot.body.keyFp, K2.fp);
    assert.ok(rot.body.rooms >= 1, 'the old key was pulled from the room it was registered in');
    assert.equal((await c('GET', '/api/sync-key')).body.syncKey.blob, blob2, 'the envelope is the new one');
    assert.equal((await c('GET', '/api/me')).body.me.keyFp, K2.fp, 'the binding is the new one');
    const pool = (await c('GET', '/api/rooms/lounge/pool')).body.keys;
    assert.ok(!pool.some(k => k.fp === K1.fp), 'the old fingerprint is gone from the pool');
    assert.equal((await c('POST', '/api/account/rotate-key', JSON.stringify({ password: 'rotate-me-123', blob: 'D'.repeat(8), fp: K2.fp, keyId: K2.keyId, publicKey: K2.publicKey }))).status, 400, 'a junk blob is refused');

    // A stranger seals a DM to the rotated account: it goes to the new key.
    const p = makeClient();
    await p('POST', '/api/auth/register', JSON.stringify({ username: 'rotpal', password: 'rotpal-pass-12' }));
    const th = await p('GET', '/api/dm/rotator');
    assert.equal(th.status, 200);
    assert.equal(th.body.publicKey, K2.publicKey, 'DMs encrypt to the new key');
  });

  await t.test('panic: the door locks and the footprint burns', async () => {
    const P = await makeKey('panicky');
    const W = await makeKey('watcher');
    const vic = makeClient();
    const wit = makeClient();
    await vic('POST', '/api/auth/register', JSON.stringify({ username: 'panicky', password: 'panic-me-please-1' }));
    await vic('POST', '/api/rooms/lounge/join');
    assert.equal((await vic('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: P.fp, keyId: P.keyId, handle: 'panicky', publicKey: P.publicKey }))).status, 200);
    await wit('POST', '/api/auth/register', JSON.stringify({ username: 'watcher', password: 'watch-me-123' }));
    await wit('POST', '/api/rooms/lounge/join');
    assert.equal((await wit('POST', '/api/keys', JSON.stringify({ room: 'lounge', fp: W.fp, keyId: W.keyId, handle: 'watcher', publicKey: W.publicKey }))).status, 200);

    // The victim talks: a room message over the socket, and a DM.
    const cp = await connect(vic.cookie());
    cp.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: P.fp, handle: 'panicky' }));
    await waitFor(cp.frames, f => f.t === 'welcome');
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'this line is about to be erased' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: P.publicKey })],
      signingKeys: P.priv,
      format: 'armored',
    });
    cp.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'pt1', ct, recipients: [P.fp] }));
    await waitFor(cp.frames, f => f.t === 'msg' && f.m.tmpId === 'pt1', 5000, 'room echo');

    await vic('POST', '/api/friends/request', JSON.stringify({ username: 'watcher' }));
    await wit('POST', '/api/friends/accept', JSON.stringify({ username: 'panicky' }));
    const dct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'and this DM is about to be erased' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: W.publicKey }), await openpgp.readKey({ armoredKey: P.publicKey })],
      signingKeys: P.priv,
      format: 'armored',
    });
    cp.ws.send(JSON.stringify({ t: 'dm', to: 'watcher', tmpId: 'pdm1', ct: dct }));
    await waitFor(cp.frames, f => f.t === 'dm' && f.tmpId === 'pdm1', 5000, 'dm echo');
    assert.equal((await vic('PUT', '/api/sync-key', JSON.stringify({ blob: 'D'.repeat(64), fp: P.fp, keyId: P.keyId, publicKey: P.publicKey }))).status, 200);

    // Panic.
    const pan = await admin('POST', '/api/admin/account', JSON.stringify({ username: 'panicky', op: 'panic' }));
    assert.equal(pan.status, 200);
    assert.ok(pan.body.sessions >= 1, 'the session was dropped');
    assert.ok(pan.body.rows >= 1, 'their room messages are gone');
    assert.ok(pan.body.keys >= 1, 'their key registration is gone from the pool');
    assert.ok(pan.body.dms.pairs >= 1 && pan.body.dms.messages >= 1, 'the DM thread and its rows are gone');

    // The door: the session is dead and sign-in is refused — a freeze, exactly.
    assert.equal((await vic('GET', '/api/me')).status, 401);
    assert.equal((await makeClient()('POST', '/api/auth/login', JSON.stringify({ username: 'panicky', password: 'panic-me-please-1' }))).status, 403, 'frozen by the panic');

    // The footprint: nothing of the name survives on disk except the audit's own
    // record that it happened (and the account record itself, frozen and empty).
    // Key files are written on a short debounce — give it a beat to land.
    await sleep(1000);
    const files = await readAllFiles(path.join(dir, 'data'));
    const leaks = files.filter(([f, txt]) => !f.endsWith('events.log') && !f.endsWith('accounts.json') && txt.includes('panicky'));
    assert.equal(leaks.length, 0, `no trace outside the audit: ${leaks.map(([f]) => f).join(', ')}`);

    // The other side of the friendship: name gone, thread gone, no key to seal to.
    assert.equal((await wit('GET', '/api/friends')).body.friends.length, 0);
    assert.equal((await wit('GET', '/api/dm/panicky')).status, 409, 'there is no key left to seal to');

    // Unfreeze reopens the door; signing in re-syncs a key; the wiped data stays wiped.
    assert.equal((await admin('POST', '/api/admin/account', JSON.stringify({ username: 'panicky', op: 'freeze', frozen: false }))).status, 200);
    const back = makeClient();
    assert.equal((await back('POST', '/api/auth/login', JSON.stringify({ username: 'panicky', password: 'panic-me-please-1' }))).status, 200, 'sign-in works again after unfreeze');
    assert.equal((await back('PUT', '/api/sync-key', JSON.stringify({ blob: 'E'.repeat(64), fp: P.fp, keyId: P.keyId, publicKey: P.publicKey }))).status, 200);
    assert.equal((await wit('GET', '/api/dm/panicky')).body.messages.length, 0, 'the thread did not come back');
    const roomFiles = await readAllFiles(path.join(dir, 'data', 'rooms'));
    assert.ok(!roomFiles.some(([, txt]) => txt.includes('panicky')), 'the wiped rows stay wiped');
    cp.ws.close();
  });

  await t.test('the message lifetime is policy the admin can change at any time', async () => {
    assert.equal((await api('/healthz')).body.retentionHours, 48, 'the window starts at config.json');
    const one = await admin('PATCH', '/api/admin/settings', JSON.stringify({ retentionHours: 1, keepForever: false }));
    assert.equal(one.status, 200);
    assert.equal(one.body.retentionHours, 1);
    assert.equal((await api('/healthz')).body.retentionHours, 1, 'the relay publishes the new window');
    assert.equal((await admin('GET', '/api/me')).body.retentionHours, 1, 'and so does every client');
    assert.match(srv.log(), /retention-change/, 'the change is applied and logged at once');

    const keep = await admin('PATCH', '/api/admin/settings', JSON.stringify({ keepForever: true }));
    assert.equal(keep.body.retentionHours, null, 'keep means keep: no window is published');
    assert.equal((await api('/healthz')).body.retentionHours, null);

    const back = await admin('PATCH', '/api/admin/settings', JSON.stringify({ keepForever: false, retentionHours: null }));
    assert.equal(back.body.retentionHours, 48, 'back to following config.json');
  });

  await t.test('an admin can take a room over, clear it out, and lift every ban', async () => {
    const made = await admin('POST', '/api/rooms', JSON.stringify({ name: 'Handover Room' }));
    const rid = made.body.room.id;
    const owner = await admin('POST', '/api/admin/room', JSON.stringify({ room: rid, op: 'owner' }));
    assert.equal(owner.status, 200);
    assert.equal(owner.body.owner, 'jay');
    const overview = await admin('GET', '/api/admin/overview');
    assert.equal(overview.body.perRoom.find(r => r.id === rid).owner, 'jay', 'ownership is visible in the panel');

    assert.equal((await admin('POST', '/api/admin/room', JSON.stringify({ room: rid, op: 'kickall' }))).status, 200);
    assert.equal((await admin('POST', '/api/admin/room', JSON.stringify({ room: rid, op: 'nonsense' }))).status, 400);

    await admin('POST', '/api/mod/ban', JSON.stringify({ target: 'murky', kind: 'account', room: null, hours: 1 }));
    const cleared = await admin('POST', '/api/admin/bans', JSON.stringify({}));
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.removed >= 1, 'every ban goes at once');
    assert.equal((await admin('GET', '/api/mod/bans')).body.bans.length, 0);
  });

  await t.test('rate limits a burst of sends', async () => {
    const connA = await connect(guest.cookie());
    connA.ws.send(JSON.stringify({ t: 'hello', room: 'lounge', fp: A.fp, handle: 'alice-1' }));
    await waitFor(connA.frames, f => f.t === 'welcome');
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'flood' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      format: 'armored',
    });
    const before = connA.frames.length;
    for (let i = 0; i < 30; i++) connA.ws.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: `burst${i}`, ct, recipients: [A.fp] }));
    await sleep(1500);
    const errs = connA.frames.slice(before).filter(f => f.t === 'err');
    assert.ok(errs.length >= 3, `expected rate-limit errors, got ${errs.length}`);
    assert.match(errs[0].msg, /rate limit/);
    connA.ws.close();
  });

  await t.test('no plaintext and no private key anywhere in the data directory', async () => {
    const files = await readAllFiles(path.join(dir, 'data'));
    const joined = files.map(([f, c]) => `${f}\n${c}`).join('\n');
    for (const secret of ['before bob', 'after bob joined', 'flood', 'owner through freeze', 'PRIVATE KEY']) {
      assert.ok(!joined.includes(secret), `data dir must not contain: ${secret}`);
    }
    assert.match(joined, /"hash"/, 'accounts are stored as hashes');
    assert.ok(!joined.includes('correct-horse-battery'), 'the admin password is never stored');
  });

  await t.test('retention sweep clears expired rows from memory and disk', async () => {
    srv.proc.kill('SIGTERM');
    await sleep(600);

    await writeConfig({ retentionHours: 0 });          // everything is instantly expired
    srv = await startServer(cfgPath);
    procs.push(srv.proc);

    const hz = await api('/healthz');
    assert.equal(hz.body.messages, 0, 'no expired rows served');

    const loungeDir = path.join(dir, 'data', 'rooms', 'lounge', 'messages');
    for (const f of (await readdir(loungeDir)).filter(f => f.endsWith('.jsonl'))) {
      const raw = await readFile(path.join(loungeDir, f), 'utf8');
      assert.equal(raw.trim(), '', `segment not emptied: ${f}`);
    }
    assert.match(srv.log(), /retention-sweep|shredded/, 'relay logged the sweep');
  });

  await t.test('with the seat vacated, the one-shot code still seats an admin', async () => {
    // A vacant seat (accounts exist, no admin) can only be produced out of band — that is
    // the documented recovery path: set "role": "user" in data/accounts.json and restart.
    // The relay then re-arms a claim code, which is the fallback this covers.
    srv.proc.kill('SIGTERM');
    await sleep(600);

    const accountsFile = path.join(dir, 'data', 'accounts.json');
    const accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
    for (const a of accounts.accounts) if (a.role === 'admin' || a.role === 'developer') a.role = 'user';
    await writeFile(accountsFile, JSON.stringify(accounts));

    await writeConfig();
    srv = await startServer(cfgPath);
    procs.push(srv.proc);

    const code = JSON.parse(await readFile(path.join(dir, 'data', 'settings.json'), 'utf8')).adminClaim;
    assert.equal(String(code || '').length, 8, 'the relay re-arms a claim code while no admin exists');
    assert.equal((await api('/healthz')).body.adminClaimable, true);

    assert.equal((await admin('POST', '/api/auth/claim', JSON.stringify({ code: 'NOPE1234' }))).status, 403, 'a wrong code is refused');
    const claim = await admin('POST', '/api/auth/claim', JSON.stringify({ code }));
    assert.equal(claim.status, 200);
    assert.equal(claim.body.me.role, 'admin');

    const after = JSON.parse(await readFile(path.join(dir, 'data', 'settings.json'), 'utf8'));
    assert.equal(after.adminClaim, null, 'the code burns on use');
    assert.match(srv.log(), /admin-claimed/, 'the relay logged the claim');
  });
});
