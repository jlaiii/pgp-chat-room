# Architecture

```
                    ┌──────────────────────────── relay (Node 22, one dep: ws) ───────────────────────────┐
  browser           │  http.createServer ── static ── api: auth, rooms, keys, history, moderation, admin   │
  ┌──────────┐      │        │                                                                             │
  │ identity │      │        └── WebSocketServer /ws  (room-scoped: hello, send, switch, ping)             │
  │ keypair  │◀────▶│  lib/rooms.js  permission matrix        lib/chat.js  per-room pools + ciphertext      │
  │ ciphertext│     │  lib/auth.js   accounts/sessions/bans   lib/settings.js  site policy                    │
  └──────────┘      └──────────────────────────────────────────────────────────────────────────────────────┘
       ▲                                     data/ on disk: JSON + jsonl, ciphertext only
       └── plaintext never crosses this line
```

## The load-bearing invariant

`server.js` and everything under `lib/` must stay **crypto-free**: no OpenPGP dependency, no
private keys, no decryption path. A `npm i openpgp` inside this project — even as a "utility" —
breaks the only interesting property it has. Ciphertext validation is structural only
(`BEGIN PGP MESSAGE` header, size cap), never cryptographic.

Password hashing uses `node:crypto`'s scrypt. That is authentication, not message crypto: the
hash never touches a message and cannot decrypt anything.

## Modules

| file | responsibility |
|---|---|
| `server.js` | HTTP routing, static assets, security headers, WebSocket frames, presence, moderation *enforcement*, boot/migration |
| `lib/util.js` | atomic writes, secure erase, cookies, ids/handles, regexes |
| `lib/auth.js` | accounts (scrypt), sessions (30-day tokens), roles, bans (site-wide and per-room) |
| `lib/rooms.js` | room registry, membership, `can(actor, action, room)` — **all permissions live here** so HTTP and WS cannot drift |
| `lib/chat.js` | per-room key pools, per-room per-day ciphertext segments, retention shredder, room teardown |
| `lib/settings.js` | the two site switches the admin panel flips, plus the bootstrap claim code |
| `public/identity.js` | browser keypair, localStorage layout, backup/restore, password-wrapped envelope |
| `public/app.js` | client state machine, API/WS clients, every view, all cryptography |

## Data on disk

```
data/
├── settings.json                 {allowNewRooms, guestAccess, adminClaim, createdAt}
├── accounts.json                 [{username, salt, hash, scryptN, role, createdAt, lastLogin, keyFp, syncKey}]
├── sessions.json                 [{token, kind, username|handle, role, fp, ip, createdAt, lastSeen, expiresAt}]
├── bans.json                     [{id, kind, target, room, until, reason, by, at}]
├── rooms.json                    [{id, name, about, private, frozen, guestOk, builtin, owner, members[], mods[], pending[], guestMembers[], allowFiles}]
├── events.log                    append-only audit trail (join/leave/key/ban/role/settings/admin-claim…)
└── rooms/
    └── <roomId>/
        ├── keys.json             [{fp, keyId, handle, publicKey, joinedAt, lastSeen}]
        └── messages/<utc-day>.jsonl   one ciphertext row per line
```

Durability is deliberate and split: **identity and moderation writes are synchronous**
(`saveNow()` — a lost ban is unacceptable), while high-frequency traffic (`lastSeen`, key
bindings, presence) rides an 800 ms debounce.

### Migration from the single-room layout

On boot, `chat.migrateLegacy()` moves `data/keys.json` → `data/rooms/lounge/keys.json` and
`data/messages/` → `data/rooms/lounge/messages/`, so an existing room becomes the lounge and
already-registered handles keep working untouched. `data/messages.jsonl` (the pre-retention
layout) is renamed aside rather than deleted.

## Permission matrix

`actor = {kind: account|guest, username, handle, role, fp}`; `role` is resolved from the account
record on every request, so a promotion or demotion applies to **live sockets** too.

| action | guest | user | mod | admin | room owner / room mod |
|---|---|---|---|---|---|
| view public room | yes | yes | yes | yes | yes |
| view private room | no | member only | **member only** | **yes (enter any room)** | yes |
| join public room | if `guestOk` + guests enabled | yes | yes | yes | yes |
| join private room | no | request → approval | request → approval | direct | direct |
| post | if `guestOk` + not frozen | if not frozen | yes (through a freeze) | yes | yes |
| register a key in the room | if readable | if readable | if readable | yes | yes |
| freeze / privacy / rename | no | owner only | yes | yes | yes |
| approve, deny, kick, room-mod | no | owner only | yes | yes | yes |
| ban (per room) | no | owner only | yes | yes | yes |
| ban (site-wide) | no | no | users + guests | users, mods, guests (never an admin) | no |
| create a room | no | if `allowNewRooms` | yes | always | — |
| delete a room | no | own room | own room | any (not the lounge) | own room |
| site settings, roles | no | no | no | yes | no |

Two consequences worth knowing:

- **A mod cannot read a private room they were not invited to.** Free *read* would also mean free
  *key registration*, i.e. a self-invite into somebody else's room. Only an admin has the
  enter-any-room power, and it is visible in the admin panel.
- **Freezing is not muting.** Mods, room mods and the owner keep posting so they can explain the
  freeze, settle the dispute, then unfreeze.

## Message flow

1. The client fetches the room's pool, registers its own public key there (idempotent; re-posting
   with a new handle is a rename), then opens the WebSocket and sends `hello`.
2. `hello` is gated on a session, a ban check, room readability and a **registered key** — a socket
   with no key in that room's pool is refused with `register your key first`.
3. `send` is gated on `can('post')`. Recipients are intersected with the room's pool, so a sender
   cannot fan a message out to fingerprints from somewhere else; the author is always a recipient.
4. The row is appended to that room's day segment, then fanned out **to sockets in that room only**
   — the author's own socket receives its `tmpId` so the optimistic bubble is finalized instead of
   duplicated.
5. `GET /api/rooms/<id>/history?fp=` returns only rows whose `recipients[]` include that
   fingerprint, plus `lockedCount`, which is what the "sealed to an older key" divider renders.

## Retention

`retentionHours` (default 48) is published in `/healthz`, `/api/rooms/<id>/pool` and
`/api/rooms/<id>/history`, and the client adopts it — never hardcode the window client-side.
Each sweep:

- shreds whole expired day-segments (random overwrite ×2, fsync, unlink),
- rewrites the boundary segment without expired lines (old file shredded first) and leaves a
  0-byte stub behind, which is erased once its day passes the cutoff,
- filters in-memory rows to the same cutoff,
- runs **at boot as well as on the interval** (a restart must not leave expired ciphertext lying
  around for a minute).

Deleting a room shreds its pool file, every segment and then the directory.

## Why the client is three files

`index.html` is `no-store`; the JS/CSS are served `immutable`. After editing a client asset,
bump its `?v=` in `index.html` or a browser will happily run the old one. `identity.js` does not
share a scope with `app.js` — anything it needs must be defined inside it. (A missing global in
there throws inside key generation, the least visible place in the app: nothing renders, and the
error lands in a pane that is already hidden.)
