# SteamCall examples

Run a signed webhook demo offline or connect a backend to a Project's Inventory Events stream.

| Example                                          | Start here                                                 | Runtime      |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------ |
| [Python webhook receiver](events/webhook-python) | Verify and deduplicate a signed fixture without an account | Python 3.11+ |
| [Node.js SSE client](events/sse-node)            | Open a Project stream and resume with a frame cursor       | Node.js 24+  |

The examples use standard-library tools. Start with the offline checks. Live requests require Events enabled for your Project. [SteamCall Events guides](https://docs.steamcall.com/apis/events)
