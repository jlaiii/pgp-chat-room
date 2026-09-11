// End-to-end tests for the relay. `npm test`
//
// Spawns a real server process against a temporary data directory, so this never
// touches a live room. Asserts the properties the project actually promises:
// later-joining keys cannot read earlier ciphertext, post-join messages decrypt and
// verify, non-recipients fail, only ciphertext hits disk, the limiter engages, and
// the retention sweep removes expired rows from memory and disk.

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

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const frames = [];
    ws.on('message', d => { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

function waitFor(frames, pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = frames.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timed out waiting for frame')); }
    }, 25);
  });
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
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`server did not start:\n${out}`);
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
    rate: { msgsPerMin: 25, keysPerMin: 50, connsPerMin: 200 },
    ...extra,
  }));
  await writeConfig();

  const procs = [];
  let srv = await startServer(cfgPath);
  procs.push(srv.proc);
  t.after(async () => {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true });
  });

  await t.test('serves the shell with security headers', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /PGP Room/);
    assert.match(res.headers.get('content-security-policy') || '', /connect-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const robots = await fetch(`${BASE}/robots.txt`);
    assert.match(await robots.text(), /Disallow: \//);
  });

  const A = await makeKey('alice');
  const B = await makeKey('bob');
  const C = await makeKey('carol');

  await t.test('registers keys into the pool', async () => {
    const r = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ fp: A.fp, keyId: A.keyId, handle: 'alice-1', publicKey: A.publicKey }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.isNew, true);
    const pool = await api('/api/pool');
    assert.equal(pool.body.retentionHours, 48);
    assert.ok(pool.body.keys.some(k => k.fp === A.fp));
  });

  await t.test('rejects malformed input and private armor', async () => {
    const bad = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ fp: 'nope', keyId: '1', handle: 'x', publicKey: 'x' }),
    });
    assert.equal(bad.status, 400);
    const priv = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({
        fp: 'a'.repeat(40), keyId: 'aabbccdd', handle: 'ok-name',
        publicKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nx',
      }),
    });
    assert.equal(priv.status, 400);
    assert.match(priv.body.error, /public key/);
  });

  const connA = await connect();
  connA.ws.send(JSON.stringify({ t: 'hello', fp: A.fp, handle: 'alice-1' }));
  await waitFor(connA.frames, f => f.t === 'welcome');

  await t.test('a message sent before B joined stays sealed away from B', async () => {
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'before bob' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      signingKeys: A.priv,
      format: 'armored',
    });
    connA.ws.send(JSON.stringify({ t: 'send', tmpId: 'pre', ct, recipients: [A.fp] }));
    const echo = await waitFor(connA.frames, f => f.t === 'msg' && f.m.tmpId === 'pre');
    assert.ok(echo.m.id, 'author receives its own message with tmpId for reconciliation');

    const reg = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ fp: B.fp, keyId: B.keyId, handle: 'bob-1', publicKey: B.publicKey }),
    });
    assert.equal(reg.body.isNew, true);

    const hist = await api(`/api/history?fp=${B.fp}`);
    assert.equal(hist.body.lockedCount, 1, 'B sees exactly one unreadable message');
    assert.equal(hist.body.messages.length, 0, 'B can decrypt nothing from before it joined');
  });

  const connB = await connect();
  connB.ws.send(JSON.stringify({ t: 'hello', fp: B.fp, handle: 'bob-1' }));
  await waitFor(connB.frames, f => f.t === 'welcome');

  await t.test('post-join messages decrypt and verify; non-recipients cannot read them', async () => {
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'after bob joined' }),
      encryptionKeys: [
        await openpgp.readKey({ armoredKey: A.publicKey }),
        await openpgp.readKey({ armoredKey: B.publicKey }),
      ],
      signingKeys: A.priv,
      format: 'armored',
    });
    connA.ws.send(JSON.stringify({ t: 'send', tmpId: 'post', ct, recipients: [A.fp, B.fp] }));

    const delivered = await waitFor(connB.frames, f => f.t === 'msg' && !f.m.tmpId);
    assert.equal(delivered.m.fp, A.fp, 'frames carry the author fingerprint');

    const msg = await openpgp.readMessage({ armoredMessage: delivered.m.ct });
    const res = await openpgp.decrypt({
      message: msg,
      decryptionKeys: B.priv,
      verificationKeys: await openpgp.readKey({ armoredKey: A.publicKey }),
      format: 'utf8',
    });
    assert.equal(res.data, 'after bob joined');
    assert.equal(await res.signatures[0].verified, true, 'signature verifies against the sender key');

    const msgForC = await openpgp.readMessage({ armoredMessage: delivered.m.ct });
    await assert.rejects(
      () => openpgp.decrypt({ message: msgForC, decryptionKeys: C.priv, format: 'utf8' }),
      'a key that was never a recipient cannot decrypt',
    );

    const hist = await api(`/api/history?fp=${B.fp}`);
    assert.equal(hist.body.messages.length, 1);
    assert.equal(hist.body.lockedCount, 1);
  });

  await t.test('stores ciphertext and metadata only', async () => {
    const segDir = path.join(dir, 'data', 'messages');
    const segs = (await readdir(segDir)).filter(f => f.endsWith('.jsonl'));
    assert.ok(segs.length >= 1, 'messages landed in a per-day segment');
    const raw = await readFile(path.join(segDir, segs[0]), 'utf8');
    assert.match(raw, /BEGIN PGP MESSAGE/);
    for (const secret of ['before bob', 'after bob joined', 'PRIVATE KEY']) {
      assert.ok(!raw.includes(secret), `must not be on disk: ${secret}`);
    }
  });

  await t.test('rate limits a burst of sends', async () => {
    const ct = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'flood' }),
      encryptionKeys: [await openpgp.readKey({ armoredKey: A.publicKey })],
      format: 'armored',
    });
    const before = connA.frames.length;
    for (let i = 0; i < 30; i++) {
      connA.ws.send(JSON.stringify({ t: 'send', tmpId: `burst${i}`, ct, recipients: [A.fp] }));
    }
    await new Promise(r => setTimeout(r, 1500));
    const errs = connA.frames.slice(before).filter(f => f.t === 'err');
    assert.ok(errs.length >= 3, `expected rate-limit errors, got ${errs.length}`);
    assert.match(errs[0].msg, /rate limit/);
  });

  await t.test('retention sweep clears expired rows from memory and disk', async () => {
    connA.ws.close();
    connB.ws.close();
    srv.proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));

    await writeConfig({ retentionHours: 0 });          // everything is instantly expired
    srv = await startServer(cfgPath);
    procs.push(srv.proc);

    const hz = await api('/healthz');
    assert.equal(hz.body.messages, 0, 'no expired rows served');
    assert.equal(hz.body.oldestMessageT, null);

    const segDir = path.join(dir, 'data', 'messages');
    for (const f of (await readdir(segDir)).filter(f => f.endsWith('.jsonl'))) {
      const raw = await readFile(path.join(segDir, f), 'utf8');
      assert.equal(raw.trim(), '', `segment not emptied: ${f}`);
    }
    assert.match(srv.log(), /retention-sweep|shredded/, 'relay logged the sweep');
  });
});
