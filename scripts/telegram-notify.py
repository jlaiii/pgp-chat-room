#!/usr/bin/env python3
"""PGP Room — optional join/leave notifier for the Telegram Bot API.

Reads new lines from the relay's events log (handles + join/leave timestamps only —
never message content, since the relay cannot decrypt) and sends one message per
batch. Intended to run from a systemd timer every ~30s; silent on quiet runs.

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
NOTIFY_TYPES = {"join", "leave", "evict"}
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


def build_text(events: list[dict]) -> str | None:
    seen: dict[str, list[dict]] = {}
    for e in events:
        if e.get("type") not in NOTIFY_TYPES:
            continue
        seen.setdefault(e.get("fp") or e.get("handle") or "?", []).append(e)
    if not seen:
        return None
    lines = []
    for evs in seen.values():
        types = [x.get("type") for x in evs]
        last = evs[-1]
        handle = last.get("handle", "someone")
        online = last.get("online")
        tail = f" — {online} in room" if isinstance(online, int) else ""
        if "join" in types and "leave" in types:
            lines.append(f"{stamp(last['t'])}  {handle}: joined and left")
        elif "join" in types:
            lines.append(f"{stamp(last['t'])}  {handle} joined{tail}")
        elif "leave" in types:
            lines.append(f"{stamp(last['t'])}  {handle} left{tail}")
        else:
            lines.append(f"{stamp(last['t'])}  {handle}: key rotated out of the pool")
    return "PGP Room\n" + "\n".join(lines)


def main() -> int:
    token = read_token()
    if not token:
        print("no telegram token configured", file=sys.stderr)
        return 1
    if not CHATS:
        print("PGPCHAT_TG_CHATS is empty", file=sys.stderr)
        return 1

    if "--test" in sys.argv:
        text = "PGP Room — notifier online. You'll get a message here when someone joins or leaves."
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

    text = build_text(events)
    if text:
        for cid in CHATS:
            try:
                tg_send(token, cid, text)
            except Exception as e:  # noqa: BLE001
                print(f"send failed for {cid}: {e}", file=sys.stderr)
                return 1
    with open(OFFSET_FILE, "w") as fh:
        fh.write(str(new_offset))

    if os.path.getsize(EVENT_FILE) > MAX_EVENT_BYTES and not text:
        try:
            os.replace(EVENT_FILE, EVENT_FILE + ".1")
            with open(OFFSET_FILE, "w") as fh:
                fh.write("0")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
