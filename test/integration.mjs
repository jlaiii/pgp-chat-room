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

function waitFor(frames, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = frames.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timed out waiting for frame')); }
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
    for (const a of accounts.accounts) if (a.role === 'admin') a.role = 'user';
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
