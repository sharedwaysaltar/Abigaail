# @abigaail/node

Fail-open Node adapter for Abigaail. It captures inbound requests, outbound
calls, errors, metrics and lifecycle events through `diagnostics_channel`. It
never patches modules, never reads bodies, and never adds signal or rejection
handlers.

```js
import { init } from "@abigaail/node";

const abigaail = init({
  routes: ["/", "/user/[id]"], // your route patterns, if known
  trustProxy: 1,               // see below
});

// In your own error handling:
abigaail.captureError(err, { route: "/user/[id]" });
```

Configuration comes from the environment unless you pass it to `init`:

| Variable | Meaning |
|---|---|
| `ABIGAAIL_ENDPOINT` | Ingest URL, e.g. `http://127.0.0.1:4318/ingest` |
| `ABIGAAIL_INGEST_KEY` | Per-app write-only key from `npm run app:create -- <name>` |
| `ABIGAAIL_RELEASE` | Deploy version, e.g. the git SHA |
| `ABIGAAIL_ENVIRONMENT` | `production`, `staging`, `development` or `test` |

If the endpoint or key is missing, the SDK does nothing. Never prefix these
variables with `NEXT_PUBLIC_`: the SDK refuses to start if you do, because Next
would ship the key to browsers.

## trustProxy

The visitor hash and geo lookup need the visitor's IP address.

- **`trustProxy: 0`** (the default) uses the socket address. That is right only
  when the app faces the internet directly.
- **`trustProxy: 1`**: use this behind Caddy or nginx on the same machine. The
  SDK then takes the rightmost `X-Forwarded-For` entry, which is the one your
  proxy added.
- **Higher values** are for more proxies in a chain, such as a CDN in front of
  Caddy.

If the setting is 0 and requests arrive from a loopback or private address, the
SDK prints a warning once.
