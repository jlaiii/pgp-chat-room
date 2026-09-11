# Architecture

## Components

| Component | Runs | Knows |
|---|---|---|
| `public/app.js` (+ vendored openpgp.js) | visitor's browser | its own private key, the room's public keys, this browser's history |
| `server.js` | your host, loopback behind a TLS proxy | fingerprints, handles, ciphertext blobs, timestamps |
| `scripts/telegram-notify.py` | your host (root timer, optional) | join/leave events only |

Trust boundary: everything a browser encrypts is opaque to everything else.

## Identity lifecycle

1. `ensureIdentity()` reads `localStorage['pgpchat.identity.v1']`. Missing/corrupt → generate a
   Curve25519 OpenPGP keypair and a random `adjective-animal-NN` handle.
2. The public half is POSTed to `/api/keys`; the relay stores `{fp, keyId, handle, publicKey, joinedAt,
   lastSeen}` in `keys.json` (debounced atomic rewrite). Re-posting an existing `fp` is a rename, not a
   new member.
3. On WebSocket `hello` the identity becomes *present*. Disconnects wait out an 8-second grace period
   before a `left` notice, so reloads don't spam.
4. Restoring from a `.asc` backup re-registers the same fingerprint → the original `joinedAt` and
   therefore the original readable history window.

## The key pool is the access model

- A message is encrypted with OpenPGP **multi-recipient** encryption: one session key, wrapped once per
  recipient public key, plus a detached signature from the sender.
- `recipients[]` on the stored record is the list of fingerprints the ciphertext was sealed to. It is
  written by the sending client and never rewritten by the relay.
- Therefore: a key registered *after* a message was sent is not in that message's `recipients`, and
  cannot read it. `GET /api/history?fp=…` returns only rows where `fp ∈ recipients`, plus
  `lockedCount` for the rest — that count drives the "N earlier messages can't be read" divider.
- Pool growth is bounded: at `maxPool` the relay evicts the oldest *idle* key (never an online one);
  evicted clients re-register automatically on their next connect (WS close code `1008` triggers a
  re-register + pool refresh in the client).
- Cost: ciphertext size grows with pool size (~250 bytes per extra recipient for the wrapped session
  key). `maxMsgBytes` (128 KB) comfortably covers a few hundred recipients; the pool cap keeps it sane.

## Storage layout

```
data/
├── keys.json                  {keys:[{fp,keyId,handle,publicKey,joinedAt,lastSeen}], savedAt}
├── messages/
│   └── 2026-09-11.jsonl       one JSON object per line: {id,seq,t,fp,handle,recipients[],ct}
└── events.log                 {t,type:key|join|leave|evict,handle,fp,online} for the notifier
```

Why per-day segments: retention can delete whole files (overwrite + unlink), and it bounds the work
per sweep. Why an append-only line format instead of a database: the payload is opaque, the read path
is `filter + slice`, and a text file is inspectable with `grep`. In-memory `messages[]` is the serving
copy and is filtered to the retention window at load and on every sweep.

## Message path

```
send:    render optimistic bubble -> encrypt(pool public keys, sign) -> WS {send, tmpId, ct, recipients}
relay:   validate -> stamp {id, seq, t} -> append to today's segment -> fan out
author:  receives the same frame WITH tmpId -> finalizes the bubble already on screen
others:  receive it without tmpId -> decrypt with own private key -> verify sender signature -> render
reconnect: GET /api/pool + GET /api/history -> dedupe by message id -> reconcile unacked bubbles
```

Ordering guarantee: the author's copy is sent after the store calls, on the same socket the client used
to send, so a client can always match its optimistic bubble to the stored message.

## Presence, notifications, retention

- Presence is derived from live sockets (`online` map keyed by fingerprint); the relay broadcasts
  `{t:'presence'}` and `{t:'sys'}` notices. It is intentionally *not* persisted per-connection.
- `events.log` is append-only and read by `telegram-notify.py` from a byte offset, so notifications
  survive relay restarts and never replay.
- Retention: `cleanup()` runs at boot and every `cleanupMinutes`. Whole expired day-segments are
  overwritten with random bytes (2 passes, `fsync`) and unlinked; the boundary segment is rewritten
  without expired rows after shredding the original; memory is filtered to the same cutoff. The window
  is published to clients (`retentionHours`), which prune their own DOM on a 60-second timer.

## Deliberate non-features

- No accounts, no server-side search, no push notifications, no moderation tools (the operator cannot
  read what it cannot decrypt; abuse handling has to be socket/IP level).
- No per-message forward secrecy or ratcheting: PGP multi-recipient is a snapshot model. Deleting a
  member removes them from *future* messages only.
- No message editing/deletion by users: there is no authenticatable author-to-record binding beyond
  the signature, and the relay is not a trusted authority.
