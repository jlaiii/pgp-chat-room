# PGP Room

Self-hosted, end-to-end encrypted group chat with real rooms, accounts and moderation.
Every message is encrypted **and signed in the browser** before it is sent, so the server
stores ciphertext it cannot read — and holds no key that could ever open it.

The room where this started was a single public chat. It is now a multi-room relay with a
public lounge, private rooms, guests, three staff levels and an admin panel — while keeping
the original promise: the relay has no OpenPGP library, no private keys and no decryption
code path.

```
browser A ──encrypt+sign──▶ relay (ciphertext only) ──▶ browser B, C, D
     ▲                                                     │
     └────────────── keys never leave the browser ──────────┘
```

<p align="center">
  <img src="docs/img/signin-mobile.png" width="240" alt="Sign in, create an account, or continue as a guest">
  <img src="docs/img/room-controls-mobile.png" width="240" alt="Room controls: freeze, privacy, guest access, files">
  <img src="docs/img/admin-mobile.png" width="240" alt="Moderation and admin: site settings, accounts, rooms, bans">
</p>

## What it does

- **Rooms.** A public lounge that everyone lands in, plus any number of rooms users create.
  Each room has **two independent locks**: *freeze* (readable, but only mods and the owner
  may post) and *private* (hidden from the list, entry needs approval).
- **Identity, three ways.** Sign in with username + password, create an account, or continue
  as a **guest** — a random handle with no account, limited to rooms that welcome guests.
- **Roles.** `admin` › `mod` › `user` › `guest`. Admins run the site and can enter any room;
  mods handle people and rooms; the owner of a room controls that room.
- **Moderation.** Ban or **temp-ban** (1h … 30 days) an account site-wide or per-room, kick
  someone from a room, approve or deny join requests, promote room mods, freeze a room,
  **slow mode** (a per-room floor between one identity's posts), **burn a room's stored ciphertext
  on the spot**, delete a room (its key pool and ciphertext are shredded with it).
- **Admin panel.** Six tabs — overview, activity, people, rooms, bans, settings. Close signups,
  stop new rooms, stop guests, **lock every room down with one switch**, set a site-wide notice,
  push a relay notice into a room, sign an account out on every device, delete an account (its
  rooms pass to the admin, never orphaned), ban by account *or* device fingerprint, and watch
  totals, a 7-day sparkline and who is online right now.
- **The activity log lives on the site, not in your phone.** Every join, leave, key registration,
  ban, role change and sign-in attempt streams into the admin panel live. Filter it by kind, or
  download the raw `.jsonl`. Mods see the same trail minus admin-only rows and IP addresses; the
  bootstrap claim code is never served to anyone. Message content is *not* in it — the relay cannot
  read a message, so there is nothing to log.
- **The rainbow name.** An admin can switch on a cosmetic flair that gives their display name an
  animated colour sweep: each letter carries its own hue and its own phase, so the fade travels
  left to right. It is a rendering hint only — no key, no ciphertext, no permission — and it is
  dropped the moment the account is demoted.
- **Handles and keys.** Each browser makes its own Curve25519 keypair on first visit. Rename a
  guest handle, download or restore a key backup, and optionally **sync your key**: the private
  key is wrapped in the browser with a key derived from your password (PBKDF2 250k → AES-GCM)
  and the server stores only that sealed envelope.
- **Self-destructing.** Ciphertext is shredded after the retention window (48h by default) —
  overwritten twice, fsynced, unlinked — and expired bubbles are pruned in open tabs too.

## What the relay knows

End-to-end encryption protects **message content**. Running a moderated, multi-room chat means
the relay necessarily knows some *metadata* — and it is better to say so plainly:

| The relay stores | The relay can never see |
|---|---|
| usernames and scrypt password hashes | message plaintext |
| session tokens (30-day, HttpOnly cookie) | anyone's private key |
| room names, membership, room mods, join requests | the contents of the sync envelope |
| bans (target, scope, expiry, reason) | attachments (they are encrypted client-side) |
| the audit trail: joins, leaves, key registrations, moderation actions, sign-in attempts (with the IP on auth events) | |
| the site notice text and which admins wear the rainbow badge | |
| message metadata: id, seq, time, room, author handle/fingerprint, recipient fingerprints, ciphertext | who is *reading* what, beyond presence in a room |
| the optional **sealed** key envelope (opaque; no password ever reaches the server) | |

Guest bans are **best-effort**: a guest is blocked by device fingerprint and IP, so clearing
site data is a way around one. Bans against accounts are solid — their sessions are dropped
immediately and they cannot sign back in.

## Quick start

```bash
git clone https://github.com/jlaiii/pgp-chat-room.git && cd pgp-chat-room
npm install                      # one dependency: ws
cp config.example.json config.json
npm start                        # http://127.0.0.1:8788
```

Serve it behind HTTPS — `crypto.subtle` and `getUserMedia`-free operation still require a
secure origin for WebCrypto. Caddy is three lines:

```
chat.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

### The first admin

The first account registered on an empty relay **is** the admin — sign up before you hand the link
out and you have an operator in one step. Every later account is a plain `user`; from then on the
seat is only *claimed* (one-shot code) or *granted* (admin panel), never assumed.

The claim code is the fallback for a relay that has accounts but no admin (a vacated seat). While no
admin exists, boot generates a one-time 8-character code into `data/settings.json` and emits an
`admin-claim` event; `scripts/telegram-notify.py` (or your own reader of `data/events.log`) delivers
it to the operator, who enters it in the app under *Moderation & admin → Claim admin*. It burns on
use, and an empty relay clears it at the first signup because the seat is already taken.

### The admin panel

*Moderation & admin* in the rail has six tabs:

| tab | what it is for |
|---|---|
| **Overview** | live totals (online, keys, stored rows, accounts, sessions, bans, rooms), a 7-day event sparkline, per-room counts, who is online right now |
| **Activity** | the audit log: joins, leaves, keys, room changes, moderation, sign-ins — live over the WebSocket, filterable by kind, downloadable as `.jsonl` |
| **People** | every account with its role, sessions, key fingerprint and last sign-in; promote/demote, sign out everywhere, delete, ban, and the rainbow-name toggle |
| **Rooms** | rename/about, **slow mode**, freeze, guest access, make private, clear stored ciphertext now, delete |
| **Bans** | place a ban against an account or a device fingerprint, site-wide or in one room, for 1 hour to 30 days (or permanent), with a reason they are shown |
| **Settings** | allow new rooms, allow guests, allow signups, the site notice, announcements, and **lockdown** |

**Lockdown** is the panic switch: freeze every room, stop new rooms, close signups and stop guests.
Lifting it clears every freeze but deliberately leaves the switches where the lockdown left them —
it is an undo for the freeze, not a policy reset.

**Announcements** are relay notices: a line pushed into a room's log, marked as coming from the
relay and never stored as a message (the relay does not get to fabricate chat).

## Configuration

`config.json` (see `config.example.json`):

| key | default | meaning |
|---|---|---|
| `port` / `bind` | `8788` / `127.0.0.1` | where the relay listens |
| `publicUrl` | — | used for the CSP WebSocket origin and cookie `Secure` flag |
| `retentionHours` | `48` | message lifetime, published to clients and enforced by the shredder |
| `cleanupMinutes` | `1` | how often the retention sweep runs |
| `auth.scryptN` | `16384` | password hashing cost (lower it only in tests) |
| `maxPool` | `500` | keys per room before idle ones are evicted |
| `maxMsgBytes` | `131072` | ciphertext cap per message |
| `rate.*` | 25/8/40/10/10 | per-minute per-IP caps: messages, key registrations, connections, auth, guest sessions |

## Layout

```
server.js               relay: HTTP + WebSocket, routing, moderation enforcement
lib/auth.js             accounts, scrypt hashing, sessions, roles, bans
lib/rooms.js            room registry + the permission matrix (the only place permissions live)
lib/chat.js             per-room key pools, ciphertext segments, retention shredder
lib/settings.js         site policy the admin panel flips
public/index.html       the app shell
public/identity.js      keypair generation, storage, backup, password-wrapped sync
public/app.js           client: auth, rooms, chat, moderation UI, all cryptography
test/integration.mjs    end-to-end suite: crypto invariants + rooms + roles + bans
```

Data lives in `data/` — `accounts.json`, `sessions.json`, `bans.json`, `rooms.json`,
`settings.json`, and per room `rooms/<id>/keys.json` + `rooms/<id>/messages/<utc-day>.jsonl`.

## Testing

```bash
npm test        # spawns a real relay against a temp data dir; no live room touched
```

The suite asserts the properties this project actually promises: a key that joins later cannot
read earlier ciphertext, post-join messages decrypt *and verify*, non-recipients fail, only
ciphertext reaches disk, the rate limiter engages, the retention sweep empties segments, a
private room stays invisible to non-members, a freeze blocks ordinary members but not mods or
owners, a ban drops the live socket, the first account on an empty relay seats the admin while the
claim code stays the fallback for a vacated seat, the admin log is staff-only and never serves the
claim code, lockdown closes the doors, slow mode throttles one identity but not staff, announcements
are never stored as messages, account deletion hands over the rooms, and an admin can burn a room's
ciphertext on the spot. CI runs it on every push.

## Honest limits

- **Overwrite-before-unlink is best-effort** on journalled/CoW storage and provider snapshots.
  The real guarantee is that deleted bytes are ciphertext whose keys only ever lived in browsers.
- **No account recovery.** Lose your device *and* your backup file (and any synced envelope) and
  your history is gone. That is the design, not a bug.
- **Key sync depends on your password.** The envelope is only as strong as the password you chose.
- **A weaker password is a weaker door** — regardless of the 250k-round KDF.
- **Guests are anonymous by definition**: a fresh device is a fresh identity.
- **The audit trail outlives a message.** Ciphertext is shredded on a timer; `data/events.log` is
  not. An operator can see that someone was in a room long after the messages are gone. It is a
  plain file: delete it whenever you want, and the relay only ever appends to it.

MIT licensed.
