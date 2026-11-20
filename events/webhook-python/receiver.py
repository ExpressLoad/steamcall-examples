#!/usr/bin/env python3
"""Executable SteamCall receiver example. Standard library; loopback demonstration only.

Configure TLS ingress, process supervision, monitoring, storage capacity and a worker
for the durable inbox before operating a receiver. No business effects run in HTTP.
The inbox deliberately has no automatic retention/deletion policy.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY = 16384
MAX_RECORDS = 100000


def decode_secret(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise ValueError("invalid signing key")
    raw = base64.urlsafe_b64decode(value + "=")
    if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != value:
        raise ValueError("noncanonical signing key")
    return raw


def verify(raw, headers, keyring, project_id, *, now=None):
    """Header list preserves duplicates. Only caller-configured keys are trusted."""
    if len(raw) > MAX_BODY or sum(len(k) + len(v) for k, v in headers) > 4096:
        raise ValueError("invalid webhook")
    fields = {}
    for name, value in headers:
        name = name.lower()
        if name in {"webhook-id", "webhook-timestamp", "webhook-signature", "content-type"}:
            if name in fields:
                raise ValueError("duplicate webhook header")
            fields[name] = value
    event_id = fields.get("webhook-id", "")
    timestamp = fields.get("webhook-timestamp", "")
    signature = fields.get("webhook-signature", "")
    if not re.fullmatch(r"evt_[0-9a-f]{32}", event_id):
        raise ValueError("invalid webhook")
    if not re.fullmatch(r"[0-9]{1,12}", timestamp):
        raise ValueError("invalid webhook")
    if fields.get("content-type", "").lower() != "application/json":
        raise ValueError("invalid webhook")
    if abs((time.time() if now is None else now) - int(timestamp)) > 300:
        raise ValueError("expired webhook")
    entries = signature.split(" ")
    if not 1 <= len(entries) <= 2:
        raise ValueError("invalid webhook")
    message = timestamp.encode("ascii") + b"." + event_id.encode("ascii") + b"." + raw
    valid = False
    seen = set()
    for entry in entries:
        match = re.fullmatch(r"v1:(whk_[0-9a-f]{32}):([A-Za-z0-9_-]{43})", entry)
        if match is None or match[1] in seen:
            raise ValueError("invalid webhook")
        key_id, encoded = match.groups()
        seen.add(key_id)
        received = decode_secret(encoded)
        key = keyring.get(key_id)
        if key is not None:
            valid |= hmac.compare_digest(hmac.digest(key, message, "sha256"), received)
    if not valid:
        raise ValueError("invalid webhook")
    try:
        event = json.loads(raw.decode("utf-8"))
    except RecursionError as error:
        raise ValueError("invalid webhook JSON depth") from error
    if not isinstance(event, dict) or event.get("id") != event_id:
        raise ValueError("invalid webhook identity")
    if (
        event.get("project_id") != project_id
        or type(event.get("version")) is not int
        or event.get("version") != 1
    ):
        raise ValueError("invalid webhook scope or version")
    occurred = event.get("occurred_at")
    if not isinstance(occurred, str) or len(occurred) > 40:
        raise ValueError("invalid webhook time")
    parsed_time = datetime.fromisoformat(occurred)
    if parsed_time.utcoffset() != timedelta(0):
        raise ValueError("invalid webhook time")
    event_type = event.get("type")
    data = event.get("data")
    if not isinstance(data, dict):
        raise ValueError("invalid webhook data")
    if event_type == "webhook.test":
        if data.get("message") != "SteamCall test delivery":
            raise ValueError("invalid test event")
    else:
        outcomes = {
            "inventory.refresh.completed": (
                "completed",
                {"complete_changed", "complete_unchanged", "private", "not_found"},
            ),
            "inventory.refresh.failed": (
                "failed",
                {
                    "incomplete",
                    "temporarily_unavailable",
                    "unsupported_scope",
                    "recovery_exhausted",
                },
            ),
        }
        if event_type not in outcomes:
            raise ValueError("unsupported webhook event")
        state, allowed = outcomes[event_type]
        refresh = data.get("refresh_id", "")
        if not isinstance(refresh, str) or not re.fullmatch(
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", refresh
        ):
            raise ValueError("invalid refresh identity")
        if data.get("state") != state or data.get("outcome") not in allowed:
            raise ValueError("invalid terminal outcome")
        if (
            not isinstance(event.get("links"), dict)
            or event["links"].get("refresh") != f"/v2/steam/inventory-refreshes/{refresh}"
        ):
            raise ValueError("invalid refresh link")
    return event


class Inbox:
    """One durable acceptance and pending work record in the same transaction."""

    def __init__(self, path):
        self.path = path
        with closing(sqlite3.connect(path, timeout=2)) as connection, connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""CREATE TABLE IF NOT EXISTS inbox (
                endpoint TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
                body BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                accepted_at INTEGER NOT NULL, PRIMARY KEY(endpoint,event_id))""")

    def accept(self, endpoint, event_id, raw):
        digest = hashlib.sha256(raw).hexdigest()
        with closing(sqlite3.connect(self.path, timeout=2)) as connection, connection:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT digest FROM inbox WHERE endpoint=? AND event_id=?", (endpoint, event_id)
            ).fetchone()
            if existing:
                if existing[0] != digest:
                    raise ValueError("conflicting event identity")
                return False
            if connection.execute("SELECT count(*) FROM inbox").fetchone()[0] >= MAX_RECORDS:
                raise RuntimeError("receiver capacity exhausted")
            connection.execute(
                "INSERT INTO inbox(endpoint,event_id,digest,body,accepted_at) VALUES(?,?,?,?,?)",
                (endpoint, event_id, digest, raw, int(time.time())),
            )
        return True  # Commit succeeded before any 2xx; consumer work is still pending.


def handler(inbox, endpoint_id, project_id, keyring):
    class Receiver(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass  # Do not log headers, URLs, signatures, credentials or payloads.

        def reply(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        def do_POST(self):
            try:
                lengths = self.headers.get_all("Content-Length") or []
                if (
                    self.path != "/events"
                    or self.headers.get("Transfer-Encoding")
                    or self.headers.get("Content-Encoding")
                ):
                    raise ValueError("invalid request")
                if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,5}", lengths[0]):
                    raise ValueError("invalid length")
                size = int(lengths[0])
                if not 0 < size <= MAX_BODY:
                    raise ValueError("invalid body size")
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError("truncated body")
                event = verify(raw, list(self.headers.items()), keyring, project_id)
                inbox.accept(endpoint_id, event["id"], raw)
            except (ValueError, UnicodeError, TypeError):
                self.reply(400)
            except (OSError, sqlite3.Error, RuntimeError):
                self.reply(503)
            else:
                self.reply(204)

    return Receiver


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    endpoint = os.environ["STEAMCALL_ENDPOINT_ID"]
    project = os.environ["STEAMCALL_PROJECT_ID"]
    if not re.fullmatch(r"whe_[0-9a-f]{32}", endpoint) or not re.fullmatch(
        r"prj_[0-9a-f]{32}", project
    ):
        parser.error("invalid endpoint or Project identity")
    configured = json.loads(os.environ["STEAMCALL_SIGNING_KEYS"])
    if not isinstance(configured, dict) or not 1 <= len(configured) <= 2:
        parser.error("configure current key and optional previous key")
    keyring = {}
    for key_id, secret in configured.items():
        if not re.fullmatch(r"whk_[0-9a-f]{32}", key_id):
            parser.error("invalid key identity")
        keyring[key_id] = decode_secret(secret)
    server = HTTPServer(
        ("127.0.0.1", args.port), handler(Inbox(args.database), endpoint, project, keyring)
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
