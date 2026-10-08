# Protocol

Everything is JSON over HTTPS; the live channel is one WebSocket per browser per room.
Authentication is a 30-day `HttpOnly` session cookie (`pgp_session`, `SameSite=Lax`,
`Secure` when `publicUrl` is https). A `Authorization: Bearer <token>` header is accepted for
API clients and tests.

State-changing requests are same-origin only: any request that carries an `Origin` header which
does not match `Host` is rejected with 403 before it is routed.

## Auth and identity

| method | path | body | notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{username, password}` | 201 + session. The first account on a relay with no accounts is `admin`; every later one is a `user` |
| POST | `/api/auth/login` | `{username, password}` | 200 + session; 403 with `banned: true` when banned |
| POST | `/api/auth/logout` | — | clears the cookie and destroys the session |
| POST | `/api/auth/password` | `{current, next}` | other sessions of that account are dropped |
| POST | `/api/auth/claim` | `{code}` | fallback bootstrap: promotes the caller to `admin` while no admin exists (a vacant seat); 409 once one does |
| POST | `/api/guest` | `{handle?, fp?}` | 201 + guest session; 403 when guest access is off |
| GET | `/api/me` | — | `{me, settings, claimable, retentionHours, fx, effects, rooms[]}` (`effects` is the name-effect list; `fx` is the account→effect map) |
| POST | `/api/me/fx` | `{fx}` | the caller's own name effect. Staff, or any account the developer unlocked (`fxAllowed`); `null` clears |
| GET/PUT/DELETE | `/api/sync-key` | `{enabled, blob}` | accounts only; the blob is an opaque sealed envelope. DELETE is an explicit opt-out (`syncOptOut`), so sign-in does not auto re-upload |

`me` carries `{kind, username, handle, role, keyFp, syncKey, syncOptOut, fx, fxAllowed, createdAt}` where
`role` ∈ `guest | user | mod | admin | developer`. `fx` is the map of which account wears which name
effect — a rendering hint, never a permission.

## Rooms

| method | path | notes |
|---|---|---|
| GET | `/api/rooms` | rooms this actor may see, each with `canEdit/canApprove/canDelete/frozen/private/pendingCount` |
| POST | `/api/rooms` | `{name, about?, private?, guestOk?}` — 403 when new rooms are disabled and you are not an admin |
| GET/PATCH/DELETE | `/api/rooms/<id>` | PATCH accepts `{frozen?, private?, guestOk?, name?, about?, allowFiles?, slowMs?}` (`slowMs` is the per-room floor between one identity's posts; 0 = off, staff are exempt) |
| POST | `/api/rooms/<id>/join` | public → member; private → `{pending: true}` and the room's staff are notified |
| POST | `/api/rooms/<id>/leave` | leaving a room you own hands it to a room mod, else to nobody |
| GET | `/api/rooms/<id>/state` | room view + who is online right now |
| POST | `/api/rooms/<id>/members` | `{username, op}` with op ∈ `approve, deny, kick, mod, unmod` |
| POST | `/api/rooms/<id>/keys` | register/refresh this browser's public key **in this room** |
| GET | `/api/rooms/<id>/pool` | every public key in the room + `retentionHours`, `frozen` |
| GET | `/api/rooms/<id>/history?fp=&limit=` | rows that fingerprint is a recipient of, plus `lockedCount` |
| POST | `/api/rooms/<id>/files` | raw ciphertext body + `X-Content-Kind: image\|video\|file`. 201 `{id,size}`. 403 unless the site switch for that kind **and** the room's `allowFiles` are on; 413 over `maxFileBytes` (refused before the body is read) |
| GET | `/api/rooms/<id>/files/<fileId>` | the sealed blob back, `application/octet-stream`, `no-store`, for anyone who may read the room. 404 once retention has shredded it |
| DELETE | `/api/rooms/<id>/messages/<mid>` | shreds that message's ciphertext and leaves a tombstone. The author, or staff moderating; 403 when the site switch is off and you are not staff |
| POST | `/api/rooms/<id>/messages/<mid>` | `{ct, recipients}` — replaces the ciphertext of your own message and marks it edited. Authors only, and only while the site switch is on |

Legacy single-room endpoints `/api/keys`, `/api/pool` and `/api/history` still work and resolve to
the lounge by default, or to `?room=<id>` / `{room: "<id>"}`.

## Moderation and admin

| method | path | notes |
|---|---|---|
| POST | `/api/mod/ban` | `{target, kind: account\|fp\|ip, room?: null, hours?: 1..720, reason?, mute?}` — `hours` omitted = permanent, `mute: true` = post-block that keeps their session. IP bans are admin-only |
| POST | `/api/mod/unban` | `{id}` or `{kind, target, room}` |
| GET | `/api/mod/bans` | active bans (mod+) |
| GET | `/api/admin/overview` | accounts, rooms, bans, online, relay stats, per-room counts (rows, keys, attachments, bytes), a 7-day activity series, live sessions (staff; mods get the same read with the session list empty) |
| PATCH | `/api/admin/settings` | `{allowNewRooms?, guestAccess?, allowRegistration?, lockdown?, motd?, allowImages?, allowVideo?, allowFiles?, keySyncDefault?, retentionHours?: number\|null, keepForever?}` (admin). Changing the window sweeps the relay immediately |
| POST | `/api/admin/role` | `{username, role}` — cannot change your own role (admin) |
| GET | `/api/admin/sessions` | every live session with a 12-char hashed id; the raw token is never returned (admin) |
| POST | `/api/admin/sessions` | `{id}` revokes that one session and drops its socket (admin) |
| GET | `/api/admin/accounts/export` | the account table as `.jsonl` (admin) |
| POST | `/api/admin/room` | `{room, op}` with op ∈ `owner` (hand the room to an account, default you), `kickall` (admin) |
| POST | `/api/admin/bans` | lifts every ban and mute at once (admin) |
| GET | `/api/admin/events` | `?type=&limit=&before=` (mod+) — the audit log, newest first. Mods lose admin-only rows and IP addresses; the bootstrap claim code is never served to anyone |
| GET | `/api/admin/events/export` | the same trail as an `application/x-ndjson` download (admin) |
| POST | `/api/admin/announce` | `{room: "<id>"\|"all", text}` (admin) — pushes a `sys` notice frame; never stored, never encrypted |
| POST | `/api/admin/lockdown` | `{on}` (admin) — freezes every room; `on` also stops new rooms, signups and guests. Lifting clears the freezes but leaves the switches where they were |
| POST | `/api/admin/account` | `{username, op}` (admin) with op ∈ `signout, delete, fx, reset-password, freeze`. `fx` (`{fx, fxAllowed}`) is **developer-only**: apply a name effect and/or unlock self-pick. `freeze` (`{frozen: bool}`) locks the account door — sessions dropped, sign-in refused until unfrozen; messages, keys and rooms untouched. `reset-password` returns a generated password **once**, drops their sessions and clears the synced envelope (it was wrapped with the old one). Admin and developer seats are never a target and you cannot act on yourself |
| POST | `/api/admin/guests` | clears every guest session (admin) |
| POST | `/api/admin/purge` | `{room}` (admin) — shreds that room's stored ciphertext now, disk and memory |

## WebSocket `/ws`

The upgrade carries the session cookie. A socket that does not complete `hello` within 12 s is
closed with code 1008. Every frame is scoped to the room the socket said hello into.

Client → server:

```jsonc
{"t":"hello","room":"lounge","fp":"<40 or 64 hex>","handle":"quiet-heron-11"}
{"t":"send","room":"lounge","tmpId":"t1727…","ct":"-----BEGIN PGP MESSAGE-----…","recipients":["<fp>", "…"]}
{"t":"switch","room":"other-room"}      // move this socket to another room
{"t":"ping"}
```

Server → client:

```jsonc
{"t":"welcome","you":{"fp","handle","kind","username","role","joinedAt"},"room":{…},"online":[…],
 "poolSize":9,"serverTime":1790…,"retentionHours":48,"frozen":false,"canPost":true}
{"t":"msg","m":{"id","seq","t","fp","handle","ct","room"}}                     // others
{"t":"msg","m":{"…","tmpId":"t1727…"}}                                          // the author's own socket
{"t":"sys","room":"lounge","text":"casey joined","ts":1790…}
{"t":"sys","room":"lounge","notice":true,"text":"Relay notice — rebooting in ten minutes","ts":1790…}   // admin announcement
{"t":"presence","room":"lounge","online":[{"fp","handle","username"}],"count":3}
{"t":"key:add","room":"lounge","key":{"fp","handle","publicKey","joinedAt"}}
{"t":"room","room":{…},"frozen":true,"canPost":false}      // state changed: freeze, privacy, members
{"t":"err","msg":"this room is frozen"}                    // also used for informational notices
{"t":"kick","reason":"you are banned from lounge until 2026-10-01 04:12Z"}
{"t":"evt","e":{"t":1790…,"type":"join","room":"lounge",…}}  // staff only: the live admin log
{"t":"fx","username":"jay","fx":"glitch"}                         // a name effect changed (null clears)
{"t":"settings","settings":{…}}                              // policy changed; clients follow live
{"t":"pong"}
```

Limits per IP per minute: 25 sends, 8 key registrations, 40 connections, 10 auth attempts, 10
guest sessions, 240 API calls. Ciphertext is capped at `maxMsgBytes` (128 KB default) and at most
`maxRecipients` fingerprints per message.

## Notes that are easy to get wrong

- **Never use `t` twice in one frame object.** `JSON.stringify` keeps the last one, so a client
  reading `m.t` as a type would silently drop every frame. Timestamps are nested or renamed.
- **The relay never ships `recipients` back.** `msg` frames and history rows carry the ciphertext
  only; the client attempts decryption and treats failure as "sealed to an older key". Gating on a
  recipient list the server does not send would make every received message look sealed.
- **Attachments ride inside the message.** The `ct` of a message that has a file decrypts to
  `{"text": "...", "file": {"id","key","iv","name","type","size","kind"}}` — the AES-GCM key is
  inside the OpenPGP envelope, so the relay can serve the blob without ever being able to open it.
- **`blob:` URLs need the CSP to allow them.** `img-src`/`media-src` must include `blob:`, or
  decrypted pictures and video render as a broken image even though the bytes arrived.
- **Deleting keeps a tombstone row** (`{…, ct: null, deleted: true, deletedBy, deletedAt}`) and
  **editing replaces `ct` in place** — the day segment is rewritten with the same shred-then-swap
  dance retention uses, so the superseded ciphertext does not survive in the file. Keep `recipients`
  on a tombstone: history filters rows by it, so dropping it would hide the deletion from exactly the
  people who saw the message.
- **A `msg`/`msg-edit` frame never carries `recipients`**, and neither does history. The client
  attempts decryption and treats failure as sealed; the relay only needs the list for routing.
- `[hidden]` must stay `display:none !important` in the stylesheet, or dismissed banners,
  dividers and sheets stay visible.
- A `403` may carry `{banned: true}` — the UI shows the ban reason instead of a generic failure.
- Rate-limit rejections are `429 {error: "slow down"}` and are not retried automatically.
