# Security model

## The claim

The relay stores and forwards **ciphertext only**. It has no OpenPGP library, no private keys and
no decryption code path, so whoever runs the box cannot read anyone's messages — not with root,
not with a database dump, not with a backup from last week.

Each browser generates its own Curve25519 keypair on first visit. Messages are encrypted to every
public key in that room's pool at send time and signed by the sender. A key that registers later
cannot read earlier ciphertext: it was never a recipient. That is a feature request from the
original build, preserved exactly.

## What the relay does know

Rooms, roles and moderation require the server to hold identity metadata. This is the honest
change from the single-room build, and it is worth being precise about:

| stored | why | exposure if the box is compromised |
|---|---|---|
| username, scrypt hash (N=16384, r=8, p=1), salt | sign-in | offline password cracking, cost set by scrypt |
| session token (30 days, `HttpOnly`, `SameSite=Lax`, `Secure`) | stay signed in | a stolen token is that session until it expires |
| room names, membership, room mods, join requests | routing and approvals | who is in what room |
| bans (target, scope, expiry, reason) | moderation | who was punished and why |
| the audit trail in `events.log`: joins, leaves, key registrations, moderation actions, sign-in attempts | accountability — the whole point of moving presence out of a chat app and onto the site | an activity timeline. IPs are stored on auth events and served to admins only; mods get the same rows without them |
| message metadata (id, seq, time, room, author handle + fingerprint, recipient fingerprints) | delivery and history | a social graph and timing pattern |
| sync envelope (always saved) | multi-device | an AES-GCM blob; useless without the password |
| attachment blobs (ciphertext, with size and timestamp) | file transfer through a relay that cannot read it | how many bytes were sent, when, and by whom — never what they are |
| DM rows and blobs: which pair, times, sizes, read marks | one-to-one messaging | nothing readable — each row and blob is sealed to both participants; **DMs are never entered in the audit log** |
| friend requests, friendships, blocks | the social list | who talks to whom exists as a graph in `social.json`; declining and blocking are silent by design |

None of that reveals a single message body.

**Direct messages** are the room contract with the pool replaced by exactly two keys: the sender
seals each row to the recipient **and to itself**, so both sides of the thread can read everything
and the process can read nothing. Read marks are server-side timestamps, not content. Blocks are
one-way and unannounced: the blocked side simply gets `this user cannot be messaged right now`.

## Attachments and voice notes

A file — or a recorded voice note — is encrypted in the browser with a one-off AES-256-GCM key and
uploaded as opaque bytes; that key is put inside the same OpenPGP message as the caption, addressed
to the room's pool (or, in a DM, to the two participants). The relay therefore stores a blob it
cannot open **and cannot listen to**, serves it back to whoever may read the conversation, and never
learns the filename (it travels inside the envelope too).

Two things to be honest about:

- **The content switches are policy, not a filter.** The sender declares `image` / `video` / `file` /
  `voice` in a header, because the relay cannot inspect sealed bytes. An adversarial client can
  mislabel what it uploads; what it cannot do is get the relay to store anything readable.
- **An attachment expires with the window.** Retention shreds the rows and the blobs together, so a
  message can outlive the bytes it points at. The UI says "this attachment is gone" in that case —
  which is the feature working, not a bug.

The CSP allows `blob:` for `img-src`/`media-src` (that is how a decrypted picture is displayed from
memory) and nothing else: no inline script, no external origins, no `object-src`.

## Deleting and editing

Deleting a message shreds its ciphertext — from memory and from the day segment on disk — and leaves
a tombstone that records who sent it, when, and who deleted it. Editing rewrites the row with the new
ciphertext and shreds the superseded one; the relay never keeps both versions. What follows is that
the relay does know *something* was there: a timeline that silently loses lines is worse than one that
says a message was deleted, and the metadata was already in the retention window anyway.

## Password handling and key sync

- Passwords are hashed with `node:crypto` **scrypt** (per-account salt, per-account `N`),
  compared with `timingSafeEqual`.
- An unknown username still performs a scrypt derivation, so the response time does not disclose
  whether an account exists.
- Changing a password invalidates that account's other sessions and re-wraps the synced envelope.
- **The account's key is synced, full stop.** The private key is encrypted in the browser with
  PBKDF2(SHA-256, 250 000 rounds) → AES-256-GCM, and the server stores the envelope. The key is saved
  to the account the moment it exists, restored from the envelope at sign-in with the password you
  just typed, and there is no un-sync: the envelope cannot be detached, deleted or opted out of
  (`DELETE /api/sync-key` is refused, and the legacy `syncOptOut` flag is gone). The only way to
  change the key is **rotation**: *Generate new key* makes a fresh key in the browser, re-verifies
  the account password server-side, stores the new envelope in the same write that drops the old one,
  and pulls the old fingerprint from every room pool so nothing new is ever sealed to a key that no
  longer exists. Anything sealed to the old key stops opening for that account (people who could
  read those words still can). The server never receives the password, so it cannot open the
  envelope — but a weak password can be attacked offline against a stolen envelope. The UI says so,
  and prompts to keep a backup file as well. Password sync is a convenience layer; the backup file
  is the real recovery path.
- **Panic is the operator's emergency stop**, and it is honest about its reach: freeze + sessions
  out + shred of everything the relay held of that account — room rows it authored, its key
  registrations, DM threads and blobs, social links, room membership lists, the synced envelope and
  the public-key binding. What it cannot reach: room attachment blobs, because the relay never
  recorded which blob belongs to whom — those ride the retention window like everyone else's. The
  audit keeps one row saying it happened; nothing else about it is anywhere.

## Authorization

`lib/rooms.js` is the single source of truth (`can(actor, action, room)`), used identically by the
HTTP layer and the WebSocket layer so the two cannot drift. Roles resolve from the account record
on every request, so a demotion takes effect on sockets that are already connected.

Points that were deliberate decisions rather than accidents:

- **A mod cannot read a private room they are not in.** Read access would also grant *key
  registration*, which would be a self-invite into somebody else's room. Only `admin` has the
  enter-any-room power, and it is listed in the admin panel as such.
- **Recipients are intersected with the room's pool** before a message is stored, so a malicious
  sender cannot fan ciphertext out to fingerprints from another room.
- **Admins cannot ban admins**, and the last admin can never be moderated; nobody can change their
  own role, so a compromised session cannot silently seize the site.
- **Bans act immediately**: the account's sessions are dropped and matching live sockets receive a
  `kick` frame and close with 1008.
- **Room deletion shreds** the pool file, every segment, then the directory.

## Retention and deletion

`retentionHours` (48 default) is enforced server-side *and* adopted by clients. Expired segments
are overwritten with random bytes twice, fsynced and unlinked; boundary segments are rewritten
(old file shredded first); in-memory rows are filtered to the same cutoff; the sweep runs at boot
as well as on its interval.

Be honest about the limit: **overwrite-before-unlink is best-effort** on journalled or CoW
filesystems, SSD wear-levelling and provider snapshots. The meaningful guarantee is not that the
bytes are unrecoverable — it is that the bytes were ciphertext whose keys only ever existed in
browsers.

## Transport and browser hardening

- HTTPS only in practice; WebCrypto (`crypto.subtle`) requires a secure origin, so plain HTTP
  cannot even run the client.
- Strict CSP (`default-src 'self'`, no inline script or style, `connect-src 'self'` + the
  wss origin derived from `publicUrl`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`,
  `noindex`, restrictive `Permissions-Policy`, HSTS.
- Same-origin enforcement on state-changing requests (an `Origin` header that does not match
  `Host` is refused outright), on top of `SameSite=Lax` cookies.
- Per-IP rate limits on messages, key registrations, connections, auth attempts and guest sessions.

## Guest bans are best-effort

A guest is anonymous: they are blocked by device fingerprint (and IP). Clearing site data, or a
new device, is a new identity. If you need a ban that actually holds, point the person at an
account — account bans drop live sessions immediately and survive everything short of you lifting
them.

## Verifying the claim yourself

```bash
# the relay must not link OpenPGP at all (only the browser bundle has it)
grep -rn "openpgp" server.js lib/ || echo "relay is crypto-free"

# stored rows are ciphertext
grep -c "BEGIN PGP MESSAGE" data/rooms/*/messages/*.jsonl

# no plaintext anywhere in the data directory
grep -ril "<some sent phrase>" data/ || echo "nothing in the clear"

# passwords are hashes
grep -c '"hash"' data/accounts.json
```

`npm test` asserts the same properties from the outside: later keys cannot decrypt earlier
ciphertext, non-recipients fail, only ciphertext reaches disk, the sweeper empties segments, and
the authorization boundaries (private rooms, freezes, bans) hold.

## Reporting

This is a personal self-hosted deployment. If you are running your own copy, treat operator access
to the box as equivalent to access to the metadata table above — and to nothing more.
