# Testing

## Automated

```bash
npm test          # node --test test/  — spawns a real relay on a temp data dir
```

Covers: the shell + CSP, key registration, malformed/private-key rejection, the pre-join message
staying unreadable to a later key, a post-join message decrypting and verifying its signature, a
non-recipient failing to decrypt, ciphertext-only storage, the rate limiter, and the retention sweep
on restart. It leaves nothing behind — everything happens under a `mkdtemp` directory.

## Manual, two identities

Use two browser profiles (or a phone and a laptop). Each profile is an independent identity with its
own key.

1. Profile A: open the room, send "hello".
2. Profile B: open the same URL. Expect **"1 earlier message can't be read in this browser"**, zero
   readable bubbles, and a working composer.
3. B sends a message → A must show it with a verified check mark.
4. A sends again → B must read that one (it was sealed after B joined).
5. Reload both tabs: identity and history survive; the first-join banner does not reappear.

## Live-delivery testing without lying to yourself

Headless and background tabs get **frozen** by Chrome; WebSocket frames queue and flush only when the
tab is touched again. Two idle browser sessions therefore look broken while the app is fine — a real
trap if you are driving browsers with an automation tool or an AI agent.

The reliable method is to put the second participant *inside the active tab* and drive it with the
page's own OpenPGP library:

```js
window.__t = { step: 'start' };
(async () => {
  const t = window.__t;
  try {
    t.step = 'keygen';
    const gen = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ name: 'test-peer', email: 'peer@example.test' }], format: 'armored' });
    const priv = await openpgp.readPrivateKey({ armoredKey: gen.privateKey });
    const fp = priv.getFingerprint().toLowerCase();
    await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fp, keyId: priv.getKeyID().toHex().toLowerCase(), handle: 'test-peer', publicKey: gen.publicKey }) });
    const pool = await (await fetch('/api/pool')).json();
    const keys = [];
    for (const k of pool.keys) { try { keys.push(await openpgp.readKey({ armoredKey: k.publicKey })); } catch {} }
    const ct = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'LIVE-TEST' }), encryptionKeys: keys, signingKeys: priv, format: 'armored' });
    await new Promise((res, rej) => { const w = new WebSocket('wss://' + location.host + '/ws'); w.onopen = () => { w.send(JSON.stringify({ t: 'hello', fp, handle: 'test-peer' })); res(); }; w.onerror = rej; window.__peer = w; });
    await new Promise(r => setTimeout(r, 300));
    window.__peer.send(JSON.stringify({ t: 'send', tmpId: 'live-1', ct, recipients: pool.keys.map(k => k.fp) }));
    t.step = 'sent';
  } catch (e) { window.__t.err = String(e); }
})();
```

Poll `window.__t` until `sent`, then poll the DOM. Expected within a second: the bubble renders
(decrypted), the signature check appears, a `test-peer joined` notice is added, presence increments.

Scenario checklist for the same harness: burst 30 sends over the raw socket → exactly the limiter's
allowance accepted and the rest answered with `rate limit — slow down`; a message encrypted to the
peer's key **only** must render for that peer and appear to others as unreadable history.

## Retention

Waiting 48 hours is impractical, so shrink the window:

```bash
# in config.json: "retentionHours": 0.01   (~36 s), keep "cleanupMinutes": 1
systemctl restart pgpchat
# send a message, keep the tab open, wait ~100 s
```

Expect: the bubble disappears from the open tab (client prune, 60 s timer), `journalctl -u pgpchat`
shows `shredded <date>.jsonl` + `retention-sweep expired_disk=1 … live=0`, the segment file is gone or
empty, and `/healthz` reports `oldestMessageT: null`. **Restore `retentionHours` and restart.**

## Cleanup after testing

Test identities end up in the key pool. If the room matters, close every test client first, then stop
the service, delete `data/keys.json` (and `data/messages/`, `data/events.log`), and start it again —
otherwise an open tab re-registers its key on reconnect and you will see a "phantom" member.
