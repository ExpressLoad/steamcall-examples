# SteamCall examples

Runnable examples for the [SteamCall API](https://docs.steamcall.com/). Each example includes setup, an offline check, and expected results.

## Events

Receive Inventory refresh notifications with a webhook or a Project event stream.

| Example | Start here | Runtime |
| --- | --- | --- |
| [Python webhook receiver](events/webhook-python) | Verify and deduplicate a signed fixture without an account | Python 3.11+ |
| [Node.js SSE client](events/sse-node) | Open a Project stream and resume with a frame cursor | Node.js 24+ |

Start with the offline checks. For live Events, sign in to SteamCall and use a Project you have access to. See the [Events guides](https://docs.steamcall.com/apis/events) for the dashboard, credentials, and delivery behavior.

## License

[MIT](LICENSE).
