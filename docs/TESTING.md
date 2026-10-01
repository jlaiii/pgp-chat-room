# Testing

## Automated

```bash
npm test          # node --test test/  — spawns a real relay on a temp data dir
```

Covers: the shell + CSP, that every API needs a session, the admin bootstrap (the first account on an
empty relay is seated as `admin`, later accounts are plain `user`s, and the fallback claim code still
seats one on a vacated seat while refusing a wrong code), roles and promotions, guest sessions,
malformed/private-key rejection, the pre-join message staying unreadable to a later key, a post-join
message decrypting and verifying its signature, a non-recipient failing to decrypt, ciphertext-only
storage (per room), a private room staying invisible with join-requests needing approval, a freeze
blocking ordinary members but not mods/owners, a ban dropping the live socket and refusing the next
sign-in, the rate limiter, the retention sweep on restart, and the admin surface: the activity log is
staff-only and never serves the bootstrap code (mods lose admin rows and IPs, the export refuses a
mod), an announcement lands as a relay notice and never as a stored message, lockdown freezes every
room and closes signups and guests while lifting it clears the freezes, slow mode throttles one
identity but not staff, the rainbow flair is admin-only and dropped on demotion, an account can be
signed out everywhere and deleted with its rooms handed over, and a room's ciphertext can be burned on
the spot. Attachments have their own coverage: they stay off until the site switch for that kind and
the room switch are both on, the stored bytes round-trip exactly, strangers get nothing, the size cap
refuses an oversize body unread, a mute blocks posting without ending the session, a password reset
and a single-session revoke both stick, and the message lifetime is policy the panel can change.
It leaves nothing behind — everything happens under a `mkdtemp` directory.

## Manual, two identities

Use two browser profiles (or a phone and a laptop). Each profile is an independent identity with its
own key.

1. Profile A: create an account, send "hello" in the lounge.
2. Profile B: open the same URL and continue **as a guest**. Expect **"1 earlier message is sealed to
   keys from before you joined"**, zero readable bubbles, and a working composer.
3. B sends a message → A must show it with a verified signature.
4. A sends again → B must read that one (it was sealed after B joined).
5. Reload both tabs: identity and history survive; the first-join banner does not reappear.
6. Create a private room as A → it appears for A, is absent from B's room list, and B's join request
   shows up as *Waiting to join* for A. Approve it and B sees the room.
7. Freeze a room as A: a guest can no longer post, while A (owner) still can.

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
    const post = (p, b) => fetch(p, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    // a session is required first: the relay has no anonymous sockets any more
    await post('/api/guest', { handle: 'test-peer', fp });
    await post('/api/rooms/lounge/keys', { room: 'lounge', fp, keyId: priv.getKeyID().toHex().toLowerCase(), handle: 'test-peer', publicKey: gen.publicKey });
    const pool = await (await fetch('/api/rooms/lounge/pool')).json();
    const keys = [];
    for (const k of pool.keys) { try { keys.push(await openpgp.readKey({ armoredKey: k.publicKey })); } catch {} }
    const ct = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'LIVE-TEST' }), encryptionKeys: keys, signingKeys: priv, format: 'armored' });
    await new Promise((res, rej) => { const w = new WebSocket('wss://' + location.host + '/ws'); w.onopen = () => { w.send(JSON.stringify({ t: 'hello', room: 'lounge', fp, handle: 'test-peer' })); res(); }; w.onerror = rej; window.__peer = w; });
    await new Promise(r => setTimeout(r, 300));
    window.__peer.send(JSON.stringify({ t: 'send', room: 'lounge', tmpId: 'live-1', ct, recipients: pool.keys.map(k => k.fp) }));
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
shows `retention-sweep expired_disk=1 …`, the segment file is gone or empty, and `/healthz` reports
`messages: 0`. **Restore `retentionHours` and restart.**

## Cleanup after testing

Test identities end up in the room's key pool. If the room matters, close every test client first,
then stop the service, delete `data/rooms/<roomId>/keys.json` (and that room's `messages/`), and
start it again — otherwise an open tab re-registers its key on reconnect and you will see a "phantom"
member. Deleting the whole `data/` directory resets everything, including accounts.
