#!/usr/bin/env python3
"""PGP Room — optional notifier for the Telegram Bot API.

Reads new lines from the relay's events log (moderation actions and the one-time admin bootstrap
code — never message content, since the relay cannot decrypt) and sends at most two messages per
run: the bootstrap code on its own, then one summary of everything else. Joins and leaves are
deliberately not sent: the relay's admin log carries them, filterable and on demand. Intended to
run from a systemd timer every ~30s; silent on quiet runs.

Configuration (environment):
  PGPCHAT_TG_CHATS       comma-separated chat ids to notify           (required)
  PGPCHAT_TG_TOKEN       bot token                                    (one of)
  PGPCHAT_TG_TOKEN_FILE  file containing "KEY=VALUE" lines with the token
  PGPCHAT_TG_TOKEN_VAR   variable name inside that file (default TELEGRAM_BOT_TOKEN)
  PGPCHAT_DATA_DIR       the relay's data directory (default ./data)
  PGPCHAT_ROOM_URL       shown in the --test message

Usage: telegram-notify.py [--test] [--dry]
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

CHATS = [c.strip() for c in os.environ.get("PGPCHAT_TG_CHATS", "").split(",") if c.strip()]
DATA_DIR = os.environ.get("PGPCHAT_DATA_DIR", "data")
EVENT_FILE = os.path.join(DATA_DIR, "events.log")
OFFSET_FILE = os.environ.get("PGPCHAT_TG_OFFSET", os.path.join(DATA_DIR, ".notify-offset"))
ROOM_URL = os.environ.get("PGPCHAT_ROOM_URL", "")
NOTIFY_TYPES = {"ban", "unban", "room-create", "room-delete", "member-op", "role", "settings",
                "admin-claimed", "login-failed", "lockdown", "account-op"}
# Presence is not sent to Telegram: the relay's admin log carries joins and leaves,
# filterable and on demand. This set stays empty on purpose.
PRESENCE_TYPES = set()
MAX_EVENT_BYTES = 5 * 1024 * 1024


def read_token() -> str | None:
    tok = os.environ.get("PGPCHAT_TG_TOKEN")
    if tok:
        return tok.strip()
    path = os.environ.get("PGPCHAT_TG_TOKEN_FILE")
    if not path:
        return None
    var = os.environ.get("PGPCHAT_TG_TOKEN_VAR", "TELEGRAM_BOT_TOKEN")
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(var + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError as e:
        print(f"cannot read token file: {e}", file=sys.stderr)
    return None


def tg_send(token: str, chat_id: str, text: str) -> dict:
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": str(chat_id), "text": text, "disable_web_page_preview": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def stamp(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%-I:%M %p")


def claim_text(code: str) -> str:
    return ("PGP Room — bootstrap code (no admin seat is taken yet).\n\n"
            f"One-time code: {code}\n\n"
            "On an empty relay you do not need this: the first account to register is seated as "
            "admin automatically. This code is the fallback for a relay that already has accounts "
            "but no admin — enter it under Moderation & admin -> Claim admin. It works once and is "
            "cleared the moment it is used."
            + (f"\n{ROOM_URL}" if ROOM_URL else ""))


def build_text(events: list[dict]) -> tuple[str | None, str | None]:
    """Return (bootstrap_code, summary_text). The code is sent on its own message."""
    code: str | None = None
    seen: dict[tuple[str, str], list[dict]] = {}
    moderation: list[dict] = []
    for e in events:
        t = e.get("type")
        if t == "admin-claim":
            code = e.get("code")
            continue
        if t in PRESENCE_TYPES:
            seen.setdefault((e.get("room", ""), e.get("fp") or e.get("handle") or "?"), []).append(e)
        elif t in NOTIFY_TYPES:
            moderation.append(e)

    lines = []
    for evs in seen.values():
        types = [x.get("type") for x in evs]
        last = evs[-1]
        handle = last.get("handle", "someone")
        room = f" [{last['room']}]" if last.get("room") else ""
        online = last.get("online")
        tail = f" — {online} online" if isinstance(online, int) else ""
        if "join" in types and "leave" in types:
            lines.append(f"{stamp(last['t'])}  {handle}: joined and left{room}")
        elif "join" in types:
            lines.append(f"{stamp(last['t'])}  {handle} joined{room}{tail}")
        elif "leave" in types:
            lines.append(f"{stamp(last['t'])}  {handle} left{room}{tail}")
        else:
            lines.append(f"{stamp(last['t'])}  {handle}: key rotated out of the pool{room}")

    for e in moderation:
        t = e.get("type")
        at = stamp(e["t"])
        if t == "ban":
            scope = e.get("room") or "site-wide"
            dur = f"{e.get('hours')}h" if e.get("hours") else "permanent"
            extra = f" — {e['reason']}" if e.get("reason") else ""
            lines.append(f"{at}  banned {e.get('target')} ({scope}, {dur}) by {e.get('by')}{extra}")
        elif t == "unban":
            lines.append(f"{at}  ban lifted by {e.get('by')}")
        elif t == "room-create":
            lines.append(f"{at}  room “{e.get('name')}” created by {e.get('by')}")
        elif t == "room-delete":
            lines.append(f"{at}  room “{e.get('name') or e.get('room')}” deleted by {e.get('by')}")
        elif t == "member-op":
            lines.append(f"{at}  {e.get('target')} {e.get('op')} in {e.get('room')} by {e.get('by')}")
        elif t == "role":
            lines.append(f"{at}  {e.get('target')} is now {e.get('role')} (by {e.get('by')})")
        elif t == "settings":
            lines.append(f"{at}  site settings: new rooms {'on' if e.get('allowNewRooms') else 'off'}, "
                         f"guests {'on' if e.get('guestAccess') else 'off'} (by {e.get('by')})")
        elif t == "admin-claimed":
            lines.append(f"{at}  admin seat claimed by {e.get('username')}")
        elif t == "login-failed":
            lines.append(f"{at}  failed sign-in for “{e.get('username')}”")

    summary = "PGP Room\n" + "\n".join(lines) if lines else None
    return code, summary


def main() -> int:
    token = read_token()
    if not token:
        print("no telegram token configured", file=sys.stderr)
        return 1
    if not CHATS:
        print("PGPCHAT_TG_CHATS is empty", file=sys.stderr)
        return 1

    if "--test" in sys.argv:
        text = "PGP Room — notifier online. You'll get a message here for moderation actions and any new bootstrap code; joins and leaves live in the relay's admin log."
        if ROOM_URL:
            text += f"\n{ROOM_URL}"
        for cid in CHATS:
            if "--dry" in sys.argv:
                print(f"[dry] -> {cid}\n{text}")
                continue
            r = tg_send(token, cid, text)
            print(f"sent to {cid}: ok={r.get('ok')}")
        return 0

    if not os.path.exists(EVENT_FILE):
        return 0
    offset = 0
    if os.path.exists(OFFSET_FILE):
        try:
            offset = int(open(OFFSET_FILE).read().strip() or "0")
        except ValueError:
            offset = 0
    size = os.path.getsize(EVENT_FILE)
    if size < offset:
        offset = 0
    if size == offset:
        return 0

    with open(EVENT_FILE, "rb") as fh:
        fh.seek(offset)
        blob = fh.read()
    new_offset = offset + len(blob)

    events = []
    for line in blob.decode("utf-8", "replace").splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    code, text = build_text(events)
    messages = []
    if code:
        messages.append(claim_text(code))
    if text:
        messages.append(text)
    for msg in messages:
        for cid in CHATS:
            if "--dry" in sys.argv:
                print(f"[dry] -> {cid}\n{msg}\n")
                continue
            try:
                tg_send(token, cid, msg)
            except Exception as e:  # noqa: BLE001
                print(f"send failed for {cid}: {e}", file=sys.stderr)
                return 1
    with open(OFFSET_FILE, "w") as fh:
        fh.write(str(new_offset))

    if os.path.getsize(EVENT_FILE) > MAX_EVENT_BYTES and not messages:
        try:
            os.replace(EVENT_FILE, EVENT_FILE + ".1")
            with open(OFFSET_FILE, "w") as fh:
                fh.write("0")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
