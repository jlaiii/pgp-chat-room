# Security model

Read this before putting anything sensitive in the room.

## Threat model

| Adversary | Outcome |
|---|---|
| Network observer / your ISP | Sees TLS (or, if you misconfigure it, nothing at all — see below). No plaintext, no keys. |
| Host operator (root on the server) | Reads fingerprints, handles, counts, timestamps, ciphertext. **Cannot decrypt messages.** |
| Someone who steals a disk image / backup / snapshot | Same as above: armor only. |
| Another member of the room | Can read everything from their own join time forward, by design. |
| A malicious member | Can send garbage, spoof handles (handles are self-asserted), flood within limits, register many keys. Cannot forge another member's signature. |

## What protects what

- **Confidentiality of content**: OpenPGP public-key encryption, Curve25519 ECDH + Ed25519,
  performed by openpgp.js 6.x in the browser. One session key per message, wrapped once per recipient.
- **Integrity + authenticity**: every message is signed by the sender's private key; the recipient
  verifies against the public key registered for that sender's fingerprint. Verified messages get a
  check mark. A failed or missing signature is shown, not hidden.
- **Key custody**: private keys are generated with the browser CSPRNG and stored only in
  `localStorage`. They are never transmitted, not even to load history.
- **Transport**: run it behind HTTPS. WebCrypto (`crypto.subtle`, required by openpgp.js) is
  unavailable in insecure contexts, so the app refuses to work over plain HTTP on a real hostname —
  that failure is a feature.
- **Server hardening**: single dependency (`ws`), no crypto library, strict CSP (`'self'` plus the
  WebSocket origin), `no-store` on API responses, `X-Frame-Options: DENY`, `nosniff`, HSTS, no
  third-party origins, no access-log of message content (the relay logs counts and fingerprints only).
- **Abuse bounds**: per-IP rate limits on messages/key registrations/connects, ciphertext and key size
  caps, recipient cap, key-pool cap with idle eviction.

## Metadata the server necessarily sees

Fingerprint, handle (self-asserted, changeable), message timestamps, message sizes, recipient counts,
IP addresses (for rate limiting; not persisted), connection times. If that is too much, this design is
the wrong tool — a relay cannot both route ciphertext and hide its own routing.

## Honest limits

1. **It is a public room.** Anyone with the link can join, read everything from that moment on, and
   participate. There is no invite list, no per-member ACL, no revocation of someone who already read
   a message.
2. **Snapshot, not ratchet.** PGP multi-recipient gives no per-message forward secrecy and no
   post-compromise security. If a browser's stored private key is later compromised, it decrypts every
   message that browser was ever a recipient of (until retention deletes the ciphertext — which is a
   genuine mitigation, see below).
3. **Identity is per device.** Two devices are two identities with disjoint histories. The `.asc`
   backup is the only way to move history; losing both the browser storage and the backup loses that
   history permanently. There is no recovery path and no password reset.
4. **Secure deletion is best effort.** Retention overwrites files with random bytes and unlinks them,
   but filesystem journaling, copy-on-write, SSD wear levelling, VM snapshots and provider backups can
   retain blocks. The durable guarantee is that deleted bytes are ciphertext whose private keys only
   ever existed in browsers.
5. **Handles are cosmetic.** They are not authenticated identities. The fingerprint is the identity; a
   signature check tells you which *key* spoke, not which human.
6. **The operator can censor and correlate.** Dropping frames, refusing to store, or lying about order
   is possible; decryption is not.
7. **`localStorage` is not a vault.** Malware, a hostile browser extension, or someone holding an
   unlocked phone with the tab open can read the key. Use the key backup and treat devices as the
   security boundary.
8. **No deniability.** Signatures are non-repudiable to anyone who has the ciphertext and the public
   keys — which includes everyone in the room.

## Operational checklist for a deployment

- [ ] HTTPS only (reverse proxy with a real certificate; `bind` stays on loopback)
- [ ] `data/` owned by the service user; unit uses `ProtectSystem=strict` + `ReadWritePaths`
- [ ] `retentionHours` set to what you actually want to lose
- [ ] Telegram/notification token, if used, kept outside the app directory and out of the repo
- [ ] Confirm for yourself that the host cannot decrypt: `npm ls openpgp` on the server shows nothing,
      and `grep -c "BEGIN PGP MESSAGE" data/messages/*.jsonl` is the only thing in there
- [ ] Treat the invite link as the access control it is: don't post it publicly by accident

## Reporting

Found a flaw? Open an issue without exploit details, or contact the maintainer privately via the
address on their GitHub profile.
