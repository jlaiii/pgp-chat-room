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
| GET | `/api/me` | — | `{me, settings, claimable, retentionHours, rooms[]}` |
| GET/PUT/DELETE | `/api/sync-key` | `{enabled, blob}` | accounts only; the blob is an opaque sealed envelope |

`me` carries `{kind, username, handle, role, keyFp, syncKey, createdAt}`.

## Rooms

| method | path | notes |
|---|---|---|
| GET | `/api/rooms` | rooms this actor may see, each with `canEdit/canApprove/canDelete/frozen/private/pendingCount` |
| POST | `/api/rooms` | `{name, about?, private?, guestOk?}` — 403 when new rooms are disabled and you are not an admin |
| GET/PATCH/DELETE | `/api/rooms/<id>` | PATCH accepts `{frozen?, private?, guestOk?, name?, about?, allowFiles?}` |
| POST | `/api/rooms/<id>/join` | public → member; private → `{pending: true}` and the room's staff are notified |
| POST | `/api/rooms/<id>/leave` | leaving a room you own hands it to a room mod, else to nobody |
| GET | `/api/rooms/<id>/state` | room view + who is online right now |
| POST | `/api/rooms/<id>/members` | `{username, op}` with op ∈ `approve, deny, kick, mod, unmod` |
| POST | `/api/rooms/<id>/keys` | register/refresh this browser's public key **in this room** |
| GET | `/api/rooms/<id>/pool` | every public key in the room + `retentionHours`, `frozen` |
| GET | `/api/rooms/<id>/history?fp=&limit=` | rows that fingerprint is a recipient of, plus `lockedCount` |

Legacy single-room endpoints `/api/keys`, `/api/pool` and `/api/history` still work and resolve to
the lounge by default, or to `?room=<id>` / `{room: "<id>"}`.

## Moderation and admin

| method | path | notes |
|---|---|---|
| POST | `/api/mod/ban` | `{target, kind: account\|fp, room?: null, hours?: 1..720, reason?}` — `hours` omitted = permanent |
| POST | `/api/mod/unban` | `{id}` or `{kind, target, room}` |
| GET | `/api/mod/bans` | active bans (mod+) |
| GET | `/api/admin/overview` | accounts, rooms, bans, online, relay stats (admin) |
| PATCH | `/api/admin/settings` | `{allowNewRooms?, guestAccess?}` (admin) |
| POST | `/api/admin/role` | `{username, role}` — cannot change your own role (admin) |

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
{"t":"presence","room":"lounge","online":[{"fp","handle","username"}],"count":3}
{"t":"key:add","room":"lounge","key":{"fp","handle","publicKey","joinedAt"}}
{"t":"room","room":{…},"frozen":true,"canPost":false}      // state changed: freeze, privacy, members
{"t":"err","msg":"this room is frozen"}                    // also used for informational notices
{"t":"kick","reason":"you are banned from lounge until 2026-10-01 04:12Z"}
{"t":"pong"}
```

Limits per IP per minute: 25 sends, 8 key registrations, 40 connections, 10 auth attempts, 10
guest sessions, 240 API calls. Ciphertext is capped at `maxMsgBytes` (128 KB default) and at most
`maxRecipients` fingerprints per message.

## Notes that are easy to get wrong

- **Never use `t` twice in one frame object.** `JSON.stringify` keeps the last one, so a client
  reading `m.t` as a type would silently drop every frame. Timestamps are nested or renamed.
- `[hidden]` must stay `display:none !important` in the stylesheet, or dismissed banners,
  dividers and sheets stay visible.
- A `403` may carry `{banned: true}` — the UI shows the ban reason instead of a generic failure.
- Rate-limit rejections are `429 {error: "slow down"}` and are not retried automatically.
