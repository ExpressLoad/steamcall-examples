#!/usr/bin/env python3
"""Verify and deduplicate a synthetic SteamCall event entirely offline."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from receiver import Inbox, decode_secret, verify


def main():
    vector = json.loads(Path(__file__).with_name("signing-vector.json").read_text(encoding="utf-8"))
    raw = vector["body_utf8"].encode("utf-8")
    key_id = vector["key_id"]
    headers = [
        ("Content-Type", "application/json"),
        ("Webhook-Id", vector["webhook_id"]),
        ("Webhook-Timestamp", vector["timestamp"]),
        ("Webhook-Signature", f"v1:{key_id}:{vector['signature_base64url']}"),
    ]
    event = verify(
        raw,
        headers,
        {key_id: decode_secret(vector["key_base64url"])},
        json.loads(raw)["project_id"],
        # The static signature vector uses a fixed timestamp.
        now=int(vector["timestamp"]),
    )
    with TemporaryDirectory(prefix="steamcall-events-") as scratch:
        inbox = Inbox(Path(scratch) / "inbox.sqlite")
        if not inbox.accept("demo", event["id"], raw) or inbox.accept("demo", event["id"], raw):
            raise RuntimeError("Expected one stored delivery and one duplicate")

    print(f"Verified and stored {event['type']} ({event['id']}).")
    print("Duplicate acknowledged. One event stored.")


if __name__ == "__main__":
    main()
