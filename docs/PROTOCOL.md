# Wire protocol

Everything is JSON. HTTP responses are `no-store`.

## HTTP

### `GET /`

The app shell (`public/index.html`), served `no-store`. `app.js`, `style.css` and
`vendor/openpgp.min.js` are served `immutable` and referenced with `?v=N` — **bump `N` in
`index.html` after editing them**.

### `GET /api/pool`

```json
{
  "serverTime": 1789163870791,
  "retentionHours": 48,
  "keys": [
    { "fp": "ee3c…803b", "handle": "quiet-otter-42", "publicKey": "-----BEGIN PGP PUBLIC KEY BLOCK-----…", "joinedAt": 1789162855292 }
  ]
}
```

### `POST /api/keys`

```json
{ "fp": "<40 or 64 lowercase hex>", "keyId": "<8–16 lowercase hex>", "handle": "quiet-otter-42", "publicKey": "-----BEGIN PGP PUBLIC KEY BLOCK-----…" }
```

Responses: `200 {isNew, joinedAt, poolSize}` · `400 bad fingerprint|bad key id|bad handle|bad public key|private key rejected` · `429 slow down` · `503 key pool full`.

- Idempotent per fingerprint. Same `fp` + different `handle` = rename (broadcasts `X is now Y`).
- `handle` must match `^[a-z0-9][a-z0-9-]{1,23}$`.
- Anything containing `PRIVATE KEY` is rejected.

### `GET /api/history?fp=<fingerprint>&limit=<n>`

```json
{
  "serverTime": 1789163870791,
  "retentionHours": 48,
  "joinedAt": 1789162855292,
  "poolSize": 2,
  "lockedCount": 3,
  "messages": [ { "id": "…", "seq": 4, "t": 1789163861000, "fp": "…", "handle": "…", "ct": "-----BEGIN PGP MESSAGE-----…" } ]
}
```

`messages` = rows whose `recipients` include `fp` (newest `limit`, default 400). `lockedCount` = rows
that do not, i.e. the number the client shows as unreadable history.

### `GET /healthz`

```json
{ "ok": true, "messages": 12, "keys": 3, "online": 1, "uptime": 813, "retentionHours": 48, "oldestMessageT": 1789163861000 }
```

### `GET /robots.txt`

`User-agent: *` / `Disallow: /`.

## WebSocket `/ws`

`maxPayload` = `maxMsgBytes` + 8 KB. Clients must send `hello` within 10 seconds or the socket is
closed with `1008`. **Sockets that never sent `hello` receive nothing** — broadcasts are gated on the
identified flag.

### Client → server

| Frame | Meaning |
|---|---|
| `{"t":"hello","fp":"…","handle":"…"}` | identify; must match a registered key. Reply: `welcome`. |
| `{"t":"send","tmpId":"…","ct":"<armor>","recipients":["fp",…]}` | store + fan out one message |
| `{"t":"ping"}` | liveness; reply `{"t":"pong"}` |

### Server → client

| Frame | Meaning |
|---|---|
| `{"t":"welcome","you":{…},"online":[…],"poolSize":n,"serverTime":…}` | hello accepted |
| `{"t":"msg","m":{id,seq,t,fp,handle,ct[,tmpId]}}` | a new message. `tmpId` is present **only** in the author's own copy. |
| `{"t":"sys","text":"bob-1 joined"}` | system notice (join/leave/rename) |
| `{"t":"presence","online":[{fp,handle}],"count":n}` | who is connected |
| `{"t":"key:add","key":{fp,handle,publicKey,joinedAt}}` | new pool member — encrypt to it from now on |
| `{"t":"err","msg":"rate limit — slow down"}` | rejected operation (socket stays open) |

### Gotcha that has bitten this codebase

`t` is the **type** field. A frame must not also carry a top-level `t` timestamp — `JSON.stringify`
keeps the last duplicate key, so the frame arrives with `t` as a number and every client drops it.
Put timestamps inside `m` or name them differently (`sys` carries no timestamp for this reason).

### Limits and rejection reasons

| Limit | Default | Response |
|---|---|---|
| messages / IP / minute | 25 | `err: rate limit — slow down` |
| key registrations / IP / minute | 8 | HTTP 429 `slow down` |
| socket connects / IP / minute | 40 | close `1008` |
| ciphertext size | 128 KB | `err: bad ciphertext` |
| recipients per message | 300 | truncated to the cap |
| key pool size | 500 | oldest idle key evicted |

Ciphertext must start with `-----BEGIN PGP MESSAGE-----` and contain `END PGP MESSAGE`; the relay does
not parse it further (it has no OpenPGP implementation, by design).
