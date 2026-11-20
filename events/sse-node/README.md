# Read and resume a SteamCall Project stream in Node.js

Use Node.js 24 or later. To test the example against a local fixture, run this command from this directory.

```sh
node --test stream.test.mjs
```

The tests check the initial request, a reconnect with `Last-Event-ID`, an authority refusal and rejection of an envelope from a different Project.

## Connect to your Project

1. In SteamCall, copy the Project ID and create a Service Account Credential for that Project with `customer.events.read.v1`. Check the network policy allows the backend running the client.
2. Copy `.env.example` to `.env` and set your Project ID and Credential. Run the script from this directory. It connects to `https://api.steamcall.com` and closes after two minutes.

```sh
node --env-file=.env stream.mjs
```

3. Look for `checkpoint <cursor>`. Submit an Inventory refresh in that Project while the script is running. Expect a line like the following when the refresh finishes.

```text
inventory.refresh.completed evt_11111111111141118111111111111111 cursor=OPAQUE_EVENT_CURSOR
```

4. Stop the first connection. Reconnect by passing the actual cursor from your last applied event, or the initial checkpoint if you have applied none. The script sends it as `Last-Event-ID`.

```sh
node --env-file=.env stream.mjs "PASTE_YOUR_CURSOR"
```

For a local replay check, resume with the checkpoint from before the refresh. The same JSON event ID identifies the replayed outcome. The example prints frames and leaves cursor storage and business actions to the caller. In your application, deduplicate by JSON event ID and save the frame cursor after the event is durably applied. Handle recovery before advancing progress if SteamCall reports a gap. [SSE quickstart](https://docs.steamcall.com/apis/events/sse-quickstart)
