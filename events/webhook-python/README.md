# Receive signed SteamCall webhooks in Python

From this directory, run the offline demo with Python 3.11 or later.

```sh
python -B offline_demo.py
```

```text
Verified and stored inventory.refresh.completed (evt_11111111111141118111111111111111).
Duplicate acknowledged. One event stored.
```

The demo uses a fixed public fixture and a temporary SQLite inbox. It verifies the exact request bytes and waits for a durable write before considering the event accepted.

## Try a delivery for your Project

1. Prepare a public HTTPS reverse proxy with a valid certificate for `/events`. Forward POST requests and the original body and signature headers to `http://127.0.0.1:8787/events`. Apply a small request-body limit at the proxy.
2. In SteamCall, select the owning Project and open **Events → Webhooks**. Create an endpoint pointing to that HTTPS URL and select the Inventory completion and failure events.
3. Configure your Project ID, endpoint ID, signing key ID and secret using your secret manager. For a local Bash trial, populate a private copy of `.env.example` named `.env` and run the following commands from this directory.

   ```sh
   umask 077
   set -a
   . ./.env
   set +a
   python -B receiver.py --database inbox.sqlite
   ```

4. Click **Send test**. Expect HTTP 204 in delivery history and one pending `webhook.test` in the inbox. To check the accepted event ID and state, open the inbox with your SQLite client and run the following query.

   ```sql
   SELECT event_id, state FROM inbox;
   ```

5. Request an Inventory refresh in the same Project. Compare the JSON event ID in **Events → Activity** with the new entry in delivery history and the inbox.

The example HTTP server binds to loopback. For a production consumer, integrate the raw-body verification and transactional inbox into your HTTP framework. Process pending work idempotently, monitor capacity and retain accepted event identities for at least 35 days. The keyring accepts the current and previous signing keys during rotation. [Webhook quickstart](https://docs.steamcall.com/apis/events/webhook-quickstart)
