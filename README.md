# PGP Room

[![test](https://github.com/jlaiii/pgp-chat-room/actions/workflows/test.yml/badge.svg)](https://github.com/jlaiii/pgp-chat-room/actions/workflows/test.yml)

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
  may post) and *private* (hidden from the list, entry needs approval). A room's **owner**
  runs their room from its settings sheet: kick, ban and lift bans for their own people,
  promote room mods, freeze, go private — with a ceiling: room-level powers never reach
  staff, and staff rank is still what site-wide means.
- **Identity, three ways.** Sign in with username + password, create an account, or continue
  as a **guest** — a random handle with no account, limited to rooms that welcome guests.
- **Roles.** `developer` › `admin` › `mod` › `user` › `guest`. Admins run the site and can enter any
  room; mods handle people and rooms; the owner of a room controls that room. The **developer** seat
  sits above admin (handpicked name effects; the only role that outranks an admin) and is deliberately
  set on the box, never over the wire.
- **Pictures, video, files and voice notes — off until an admin says otherwise.** Attachments are
  gated twice: a site-wide switch per kind (pictures / video / other files / **voice**) and the room's
  own switch. All are off out of the box, so a fresh relay takes text only. A file — or a recorded
  voice note — is sealed in the browser with a one-off AES-GCM key, and **that key travels inside the
  room's OpenPGP message** — the relay stores a blob it cannot open, and never learns the filename.
- **Voice messages.** A mic button in the composer records a clip (up to 2 minutes), which is sealed
  exactly like a picture and sent as a message with an inline player. The **Voice messages** switch in
  *Settings* turns them on or off site-wide, live for every open client; rooms that take attachments
  take voice notes, and direct messages follow the same site switch.
- **Direct messages and friends.** Any account can search the user list, send a friend request
  (accept, decline, cancel, remove — both sides get told live), or open a **one-to-one thread** with
  anyone who is not blocked. DMs are encrypted to both participants' keys: the relay routes and stores
  ciphertext, its session-list view never learns a word, and **nothing about who talks to whom goes in
  the audit log** — not even for the operator. Voice notes and attachments work in DMs under the same
  site switches, sealed the same way. **Block** silences someone completely (no DMs, no requests, and
  it ends the friendship), reversibly, without them being notified either way.
- **The message lifetime is a setting, not a rebuild.** An admin picks 1 hour … 30 days, or *keep
  until cleared by hand*. Shortening the window sweeps the relay the moment it is applied, and
  attachments follow the same window as the messages that point at them.
- **Your own messages are yours — until the admin says otherwise.** Delete your own message and
  its ciphertext is shredded on the relay that instant; what stays in the timeline is a tombstone
  that says something was there. Edit your own message and the new ciphertext replaces the old one
  (the superseded one is shredded too). Two switches in *Settings → Messages* decide whether people
  may delete and edit at all. Staff can always delete for moderation — nobody can ever rewrite
  another account's words, because the relay cannot re-sign a ciphertext that isn't theirs.
- **Moderation.** Ban or **temp-ban** (1h … 30 days) an account site-wide or per-room, **mute** someone
  (a timeout: they keep reading and keep their connection, they just cannot post), **ban by device
  fingerprint or IP address**, kick someone from a room, approve or deny join requests, promote room
  mods, freeze a room, **slow mode** (a per-room floor between one identity's posts), **burn a room's
  stored ciphertext on the spot**, delete a room (its key pool, ciphertext and attachments are
  shredded with it).
- **One pinned message per room.** The room's owner or staff pin a message to the top — ever
  exactly one; pinning another replaces it, deleting the pinned message clears it. The pin is
  only a message id: every reader paints the words from their own decrypted copy, so a pin can
  never show anyone something they could not already open.
- **Admin panel.** The hamburger menu's *Manage* section: dashboard, activity, **users**, rooms,
  bans & mutes, settings — one page per job. Freeze an account (lock the door: sessions dropped, sign-in
  refused, data kept) or **panic-lock** it (the emergency stop: freeze plus a wipe of its whole
  footprint — messages, key registrations, synced envelope, DM threads, blobs, social and member
  lists), close signups, stop new rooms, stop guests, **lock every room down with one switch**,
  set a site-wide notice, push a relay notice into a room, **reset a password** (the generated one is
  shown once and never logged), sign an account out everywhere or revoke one session, delete an account
  (its rooms pass to the admin, its DMs and social traces are scrubbed, never orphaned), and watch
  totals, a 7-day sparkline and who is online right now.
- **It updates itself.** The relay stamps every page with a version built from its own files, and
  open tabs keep an eye on it — the socket tells them on reconnect, they check when the tab comes
  back, and once a minute besides. When the version moved (a deploy), the page reloads itself: no
  hard-refresh instructions, and a half-typed message is kept and put back into its composer.
- **The activity log lives on the site, not in your phone.** Every join, leave, key registration,
  ban, role change and sign-in attempt streams into the admin panel live. Filter it by kind, or
  download the raw `.jsonl`. Mods see the same trail minus admin-only rows and IP addresses; the
  bootstrap claim code is never served to anyone. Message content is *not* in it — the relay cannot
  read a message, so there is nothing to log.
- **Name effects.** Thirty of them — rainbow sweeps, RGB flashing, jumping letters, glitch, fire,
  gold, typewriter and more. An effect is a rendering hint only (no key, no ciphertext, no
  permission) and everyone in every room sees it on the name. The **developer** hands them out:
  apply one to any account, or unlock an account's picker so it chooses its own. Nobody else can
  change another account's effect, and a role change never touches it.
- **Handles and keys.** Each browser makes its own Curve25519 keypair on first visit, and **an
  account makes its key when it is made**: registering generates the key (or claims this device's
  pre-account key) and saves it to the account as a sealed envelope — wrapped in the browser with a
  key derived from your password (PBKDF2 250k → AES-GCM); the server only ever holds that opaque
  string. Signing in on another device restores the account's key there: one account, one key.
  Guest handles, rename, and key backup/restore work as before.
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
| tombstone rows for deleted messages: who, when, who deleted it | the ciphertext of a deleted or edited message — both are shredded |
| attachment blobs: how many bytes, in which room, uploaded when, by whom | what any file *is* — no name, no type, no content |
| direct messages: who ↔ who a thread is between, row times, sealed blob sizes | what any DM says — sealed to the two participants' keys; **DMs are not in the audit trail at all** |
| friend requests, friendships and blocks: which accounts list which | who declined whom, and the reasons people talk |
| the pinned message of a room: its id, who pinned it, when | what it says — every reader paints the words from its own copy |
| the audit trail: joins, leaves, key registrations, moderation actions, sign-in attempts (with the IP on auth events) | |
| the site notice text and which accounts wear which name effect | |
| message metadata: id, seq, time, room, author handle/fingerprint, recipient fingerprints, ciphertext | who is *reading* what, beyond presence in a room |
| the **sealed** key envelope (opaque; no password ever reaches the server) — always saved to the account, never detachable, replaced whole by a rotation | |

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
`admin-claim` event. The relay itself never phones anywhere — if you want the code (and a one-line
summary of other moderation events) delivered, the **optional** `scripts/telegram-notify.py` does it
over the Telegram Bot API: give it a bot token and chat ids, run it from a timer, or just read
`data/events.log` yourself. Either way the operator enters the code in the app under *menu → Claim
admin*. It burns on use, and an empty relay clears it at the first signup because the seat is
already taken.

### The admin area

The hamburger menu has a **Manage** section — one page per job, each a full screen with a back
button. Mods see Dashboard, Users, Activity and Bans & mutes; admins (and the developer) also see
Rooms and Settings:

| page | what it is for |
|---|---|
| **Dashboard** | live totals (online, keys, stored rows, attachments, accounts, sessions, bans, rooms), a 7-day event sparkline, per-room counts, who is online right now |
| **Activity** | the audit log: joins, leaves, keys, uploads, room changes, moderation, sign-ins — live over the WebSocket, filterable by kind, downloadable as `.jsonl` (admins) |
| **Users** | every account as a card — role, sessions, key fingerprint, last sign-in — with search; **freeze/unfreeze**, **panic-lock** (freeze + wipe the relay's whole footprint of them), promote/demote, **mute**, **reset password**, sign out everywhere, delete, ban/unban, and — for the developer — the name-effect picker — plus every live session with a one-click revoke and an accounts export (admins) |
| **Rooms** | rename/about, **slow mode**, freeze, guest access, **attachments on/off**, take ownership, clear everyone out, clear stored ciphertext now, delete |
| **Bans & mutes** | place a ban against an account, a device fingerprint or an IP, site-wide or in one room, for 1 hour to 30 days (or permanent), with a reason they are shown — or a **mute**, which is the same thing without ending their session. One button lifts them all |
| **Settings** | allow new rooms, guests, signups; **pictures / video / other files / voice messages**; **who may delete and edit a message**; the **message lifetime**; the site notice; announcements; and **lockdown** |

**Freeze** locks the account door: sessions are dropped and sign-in is refused until unfrozen.
Messages, keys and room memberships are untouched — that is what **ban** is for. **Panic** is freeze
plus the wipe described above; the door stays locked until someone unfreezes it, and the wiped data
is unrecoverable by design.

**Attachments** are switched on twice, on purpose: the site switch says which *kinds* may be sent at
all, and each room says whether it accepts them. Neither is on by default. The composer's clip and
mic follow the *site* switches — when the room's own gate is the thing that is off, using the control
says so: room mods get a one-tap “turn them on”, everyone else gets told exactly why not, and nothing
ever disappears without an explanation. A file — or a voice note,
which rides the same rails — is encrypted with a one-off AES-GCM key in the browser and uploaded as
opaque bytes; the key is addressed to the room inside the same OpenPGP message as the caption. The
relay can hand the blob back but can never open (or listen to) it. Two honest caveats: the kind
(image / video / file / voice) is **declared by the sending client**, because the relay has no way to
inspect sealed bytes — the switches are policy, not a content filter; and an attachment dies with the
retention window, so an old message can point at bytes that are already gone.

**Direct messages** ride the same contract, one rung tighter: each row is sealed to *both*
participants' keys (so both sides of the thread can read it and the relay can read neither), blobs are
sealed with the same one-off AES-GCM key inside the message, and the pair's storage is
`data/dms/<a>__<b>/` — rows, read marks and blobs, swept by the same retention window and shredded
when an account is deleted.

**The account's key is synced, full stop.** Registering saves the key to the account as a sealed
envelope; signing in restores it onto the device, so the same key reads your history everywhere. The
envelope cannot be un-saved: there is no off switch and no opt-out to remember. The only way to change
the key is deliberate — *Generate new key* in **Your key** makes a fresh key, verifies your password,
stores the new envelope in the same write that drops the old one and pulls the old fingerprint from
every room pool. The honest caveats are unchanged: a weak password can be attacked offline against a
stolen envelope, so keep a backup file, and anything sealed to the old key stops opening for you the
moment it rotates.

**Panic** is the operator's emergency stop for an account, the bigger sibling of **freeze**. Freeze
just locks the door (sessions dropped, sign-in refused, data kept). Panic locks the door *and* wipes
the footprint: every message the account sent in every room, its key registrations and synced
envelope, its direct-message threads and blobs, its places in everyone's social lists and room
member lists — shredded in one move. Unfreezing later reopens the door, but none of it comes back.
The audit log keeps one row saying it happened, and nobody is notified. The honest limit: room
attachment blobs were never recorded with an owner, so those ride the retention window like everyone
else's.

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
| `maxFileBytes` | `8388608` | cap per attachment (8 MB); over it the upload is refused unread |
| `maxFilesPerRoom` | `2000` | attachments held per room before it refuses more |
| `rate.*` | 25/8/40/10/10/10 | per-minute per-IP caps: messages, key registrations, connections, auth, guest sessions, uploads |

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
owners, a room's owner kicks, bans and lifts bans inside their own room with staff rank out of
reach, one pinned message per room (a second pin replaces the first, and the pin dies with its
deleted message), a ban drops the live socket, the first account on an empty relay seats the admin while the
claim code stays the fallback for a vacated seat, the admin log is staff-only and never serves the
claim code, lockdown closes the doors, slow mode throttles one identity but not staff, announcements
are never stored as messages, account deletion hands over the rooms, an admin can burn a room's
ciphertext on the spot, the account key is synced or replaced and never un-synced (a rotation swaps
envelope, binding and room pools in one write; a wrong password changes nothing), a panic-lock burns
an account's footprint down to nothing but the audit row and unfreezing does not resurrect it,
attachments stay off until both switches are on and round-trip byte for byte,
voice notes ride their own site switch and the room gate, friends/requests/blocks behave in both
directions, DMs deliver live as ciphertext and only to the two participants (guests are refused
outright), blocking silences DMs and requests, deleting an account scrubs its threads and social
traces, a mute blocks posting without ending the session, a password reset and a single-session
revoke both stick, the message lifetime is policy, deleting your own message leaves a tombstone with
no ciphertext on disk while a stranger's is refused, editing replaces the ciphertext rather than
keeping both, and staff can delete anyone's message but never edit one. CI runs it on every push.

## Honest limits

- **Overwrite-before-unlink is best-effort** on journalled/CoW storage and provider snapshots.
  The real guarantee is that deleted bytes are ciphertext whose keys only ever lived in browsers.
- **No account recovery.** Lose your device, your backup file, *and* the password that unlocks your
  synced envelope — and your history is gone. That is the design, not a bug.
- **Key sync depends on your password.** The envelope is only as strong as the password you chose.
- **A weaker password is a weaker door** — regardless of the 250k-round KDF.
- **Guests are anonymous by definition**: a fresh device is a fresh identity.
- **The audit trail outlives a message.** Ciphertext is shredded on a timer; `data/events.log` is
  not. An operator can see that someone was in a room long after the messages are gone. It is a
  plain file: delete it whenever you want, and the relay only ever appends to it.

MIT licensed.
