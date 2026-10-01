# Deployment

Requirements: Node ≥ 22, a host with a public IP, a TLS-terminating reverse proxy (Caddy is the least
work), and either a domain or an [sslip.io](https://sslip.io)/nip.io style name that resolves to your
IP. HTTPS is not optional — browsers withhold WebCrypto from insecure origins, and the client refuses
to run without it.

## 1. Install the app

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pgpchat
sudo mkdir -p /opt/pgpchat && sudo chown "$USER" /opt/pgpchat
git clone https://github.com/jlaiii/pgp-chat-room.git /opt/pgpchat
cd /opt/pgpchat && npm ci --omit=dev
cp config.example.json config.json && $EDITOR config.json
sudo chown -R pgpchat:pgpchat /opt/pgpchat
sudo chmod 700 /opt/pgpchat/data 2>/dev/null || true
```

Set at minimum: `port`, `publicUrl` (the exact URL people will open — it feeds the CSP WebSocket
origin), `retentionHours`, and `bind` (keep `127.0.0.1`).

## 2. systemd

`deploy/pgpchat.service` is a hardened unit. Adjust `ExecStart`, `WorkingDirectory` and
`ReadWritePaths` if your paths differ, then:

```bash
sudo cp deploy/pgpchat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pgpchat
systemctl status pgpchat --no-pager
curl -s http://127.0.0.1:8788/healthz
```

## 3. TLS reverse proxy

**Caddy** (`deploy/Caddyfile.example`) — substitute your hostname:

```
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8788
}
```

```bash
sudo systemctl reload caddy      # after `caddy validate --config /etc/caddy/Caddyfile`
curl -sI https://chat.example.com/ | head -3
```

Caddy obtains and renews the certificate automatically. No domain? `chat.<your-ip-with-dashes>.sslip.io`
resolves to the IP and can hold a real Let's Encrypt certificate — the traffic still goes straight to
your box, only DNS is borrowed.

**nginx** (`deploy/nginx.conf.example`) needs the WebSocket upgrade headers — don't forget
`proxy_set_header Upgrade $http_upgrade;` and `Connection "upgrade"`, or the socket silently fails.

## 4. Optional: join/leave notifications

```bash
sudo install -m 0755 scripts/telegram-notify.py /opt/pgpchat/telegram-notify.py
sudo mkdir -p /etc/pgpchat
printf 'PGPCHAT_TG_TOKEN=%s\nPGPCHAT_TG_CHATS=123456789\n' '<bot-token>' | sudo tee /etc/pgpchat/notify.env
sudo chmod 600 /etc/pgpchat/notify.env
sudo -u pgpchat PGPCHAT_TG_TOKEN=… PGPCHAT_TG_CHATS=… python3 /opt/pgpchat/telegram-notify.py --test
```

Install the timer:

```ini
# /etc/systemd/system/pgpchat-notify.service
[Unit]
Description=PGP Room moderation notifier
[Service]
Type=oneshot
EnvironmentFile=/etc/pgpchat/notify.env
Environment=PGPCHAT_DATA_DIR=/opt/pgpchat/data
ExecStart=/usr/bin/python3 /opt/pgpchat/telegram-notify.py

# /etc/systemd/system/pgpchat-notify.timer
[Unit]
Description=Run the PGP Room notifier every 30 seconds
[Timer]
OnBootSec=45
OnUnitActiveSec=30
AccuracySec=5
Unit=pgpchat-notify.service
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now pgpchat-notify.timer
```

The script only ever reads `data/events.log` (metadata — never ciphertext, and it never sees the bot
token's counterpart in the app). It carries **moderation you have to act on**: bans, role changes,
lockdowns, account actions and any new bootstrap code. Presence is deliberately *not* sent — joins,
leaves and key registrations belong in the admin panel's activity log, where they can be filtered and
read on demand instead of buzzing a phone.

## 5. Verify

```bash
curl -s https://chat.example.com/healthz
curl -sI https://chat.example.com/ | grep -i content-security-policy
# from your phone: open the URL, send a message, open it in a second browser profile:
#   the first message must show as "can't be read in this browser" for the newcomer
```

## Operations

| Task | Command |
|---|---|
| Logs | `journalctl -u pgpchat -n 50` (metadata only, never message content) |
| Restart after code change | `systemctl restart pgpchat` (clients reconnect automatically) |
| Change retention | edit `retentionHours`, restart; clients pick it up on next connect |
| Room state | `curl -s http://127.0.0.1:8788/healthz` |
| **Reset the room** | stop the service, then remove `data/rooms/<roomId>/` for the room you want gone (the lounge is `lounge`) — or delete the room from the admin panel, which shreds its pool and ciphertext for you. To reset *everything*, remove `data/` entirely. Note: any browser still open re-registers its key on reconnect; close clients first if you want a truly empty room. |
| **Seat the admin** | on a relay with no accounts, the first account to register is the admin automatically — sign up in the app and you are done (the relay clears the fallback code at the same time). If accounts exist but no admin (a vacated seat), the relay writes a one-time code to `data/settings.json` and emits an `admin-claim` event: deliver it to the operator (the bundled notifier DMs it) and use *Moderation & admin → Claim admin*. |
| **Read the activity log** | open *Moderation & admin → Activity* (live, filterable; mods get a redacted trail) or pull it as JSON: `curl -s -H "Cookie: pgp_session=<token>" 'http://127.0.0.1:8788/api/admin/events?limit=200'`. `…/events/export` downloads the raw `.jsonl`. The bootstrap claim code is never in either response. |
| **Trim the audit trail** | `data/events.log` is append-only metadata. Delete it whenever you like — the relay recreates it on the next event — and the bundled notifier rotates it at 5 MB when it has nothing to say. |
| **Attachments on disk** | `data/rooms/<roomId>/files/<id>.bin`, sealed bytes only. They are shredded by the same sweep as the rows (and by *Clear history now*), so `du -sh data/rooms/*/files` is what the relay is actually holding. Site switches live in *Settings*; each room has its own. |
| **Message lifetime** | *Settings → Message lifetime*: 1 hour … 30 days or *keep until cleared by hand*. Shortening it sweeps immediately and needs no restart. `config.json`'s `retentionHours` is only the fallback while the panel has not chosen anything. |
| **Lost the admin seat** | stop the service, edit `data/accounts.json` and set `"role": "admin"` on your username, start it again. |
| Upgrade | `git pull && npm ci --omit=dev && systemctl restart pgpchat` |

Backups are optional by design (the server holds nothing readable), but if you take them, remember they
contain ciphertext and fingerprints — retention does not reach into snapshots.
