# Contributing

Thanks for looking. This is a small, deliberately boring codebase: one Node file, one page of vanilla
JS, no build step. Keep it that way.

## Run it

```bash
npm install
cp config.example.json config.json
npm start            # http://127.0.0.1:8788
npm test             # end-to-end suite; ~10s
```

For a scratch instance that cannot disturb anything else:

```bash
mkdir -p /tmp/scratch && cat > /tmp/scratch/config.json <<'JSON'
{ "port": 18899, "bind": "127.0.0.1", "dataDir": "/tmp/scratch/data", "publicDir": "./public",
  "publicUrl": "http://127.0.0.1:18899/", "retentionHours": 48, "cleanupMinutes": 1 }
JSON
PGPCHAT_CONFIG=/tmp/scratch/config.json npm start
```

## Invariants — a PR that breaks one of these will be rejected

1. **The server never gains decryption ability.** `openpgp` stays a devDependency (it exists to vendor
   the browser bundle and run tests). No private keys server-side, ever.
2. **`recipients[]` is the access model.** Never recompute or extend it; a key that registered later
   must not be able to read earlier ciphertext. This is the product, not an optimisation detail.
3. **Never put `t` twice in one WebSocket frame** (type + timestamp). `JSON.stringify` keeps only the
   last, so the frame's type silently becomes a number and clients drop it. Nest timestamps instead.
4. **Only ciphertext and metadata reach disk or logs** — no message content, no decrypted caches.
5. **The client keeps the private key client-side**, in `localStorage` only.
6. **Retention is enforced on both ends**, and the client reads the window from the server
   (`retentionHours`), never from a constant.
7. **No third-party origins** — no CDNs, fonts, analytics, or remote images. CSP is `'self'` + the
   configured WebSocket origin.
8. **Broadcasts go only to identified sockets** (`broadcast()` checks the fingerprint flag set by
   `hello`).
9. **Keep `[hidden]{display:none!important}` in `style.css`**; several components rely on it and class
   rules with `display` otherwise win over the attribute.
10. **Bump `?v=N` in `public/index.html`** when you touch `app.js`, `identity.js` or `style.css` (they are served
    `immutable`; the shell is `no-store`, which makes the bump effective).

## Practical notes

- Plain modern JS. No TypeScript, no bundler, no framework — the whole client is readable in one sitting.
- `public/vendor/openpgp.min.js` is a build artifact: update it with `npm run vendor` after changing the
  `openpgp` devDependency version, and mention the version in the PR.
- Manual testing: two browser profiles (or two devices) give you two identities. A harder case worth
  exercising is "join after a few messages were sent" — the newcomer must see the locked-count divider
  and zero readable messages.
- Headless/background tabs freeze and queue WebSocket frames, so naive two-session browser tests look
  broken when the app is fine. `docs/TESTING.md` describes the reliable approach.
- If your change alters behaviour, add an assertion to `test/integration.mjs` — the suite is plain
  `node:test` + `assert`, no framework to learn.

## PR checklist

- [ ] `npm test` passes
- [ ] No new runtime dependencies (ask first if you think one is needed)
- [ ] Security-relevant change? Update `docs/SECURITY.md` and the invariants above
- [ ] Protocol change? Update `docs/PROTOCOL.md` (and keep it backward-compatible or say why not)
