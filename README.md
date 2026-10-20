# Abigaail

Abigaail is a self-hosted monitoring system for the web apps you run. You add a
small library to your app; it reports every request, outbound call, error, and a
few health metrics to an Abigaail server on a machine you control. A set of
agents then compares each app with its own normal and tells you, in plain
English, when something is wrong and what probably caused it.

It is built to collect **no personal data**: no IP addresses, emails, names, user
IDs, cookies, tokens, headers, request bodies, form inputs or query values. Visitor
counts use a pseudonymous ID that changes every day. That ID is still personal data
under GDPR, so the data is *pseudonymous*, not anonymous.
No third-party service is involved.

> Status: under construction, built in small chunks. Today: Node and Next.js apps,
> the Usage, Health and Watchdog agents, and a dashboard. Automatic deletion of old
> data (retention), alert delivery and more agents are planned, not built yet. See
> [docs/ROADMAP.md](docs/ROADMAP.md).

## Contents

1. [Run Abigaail on your machine](#1-run-abigaail-on-your-machine)
2. [Connect a Node app](#2-connect-a-node-app)
3. [Connect a Next.js app](#3-connect-a-nextjs-app)
4. [What is and isn't collected](#4-what-is-and-isnt-collected)
5. [Check that it works](#5-check-that-it-works)
6. [Turn it off](#6-turn-it-off)
7. [A privacy-notice snippet](#7-a-privacy-notice-snippet)
8. [Try it without your own app: demos and the simulator](#8-try-it-without-your-own-app)
9. [Reference](#9-reference)

## 1. Run Abigaail on your machine

You need Node.js 22.13 or newer (Node 24 recommended) and git.

```bash
git clone https://github.com/sharedwaysaltar/Abigaail.git
cd Abigaail
git checkout dev
npm install
npm run check          # type-check and tests; should end with all tests passing
```

Start the server. It receives events on `http://127.0.0.1:4318/ingest` and runs the agents:

```bash
npm run dev:server
```

Data lives in `./data/` (never committed): the database `abigaail.db` and
`salt.bin`, the secret for the day's visitor IDs, kept out of the database on purpose.

To see the results in a browser, set up the dashboard once (it needs a secret and a user):

```bash
cp apps/dashboard/.env.example apps/dashboard/.env
# In apps/dashboard/.env, set ABIGAAIL_DASHBOARD_SECRET to the output of: openssl rand -base64 32
set -a; . apps/dashboard/.env; set +a        # the user command needs the same secret
npm run user:create -- owner                 # asks for a password, shows an authenticator secret once
npm run dashboard                            # http://localhost:4319
```

Add the secret to an authenticator app, confirm one code, then sign in with name,
password and code. The dashboard is for your machine or a VPN only, never the public
internet (see [docs/HOSTING.md](docs/HOSTING.md)).

## 2. Connect a Node app

This works for any long-running Node process: plain `node:http`, Express, Fastify and
others. It captures requests through Node's built-in `diagnostics_channel`, so it
patches nothing in your app.

**Step 1: build the SDK packages.** They are not on the npm registry, so you build them
from this repository and install the files. In the Abigaail folder:

```bash
npm run build
mkdir -p ../abigaail-sdk
npm pack -w @abigaail/schema -w @abigaail/core -w @abigaail/node --pack-destination ../abigaail-sdk
```

**Step 2: install them in your app, all in one command.** Installing them together
means npm takes every `@abigaail/*` package from these files and never looks for one on
the public registry, where someone else could publish the same name.

```bash
cd /path/to/your-app
npm install ../abigaail-sdk/abigaail-schema-0.1.0.tgz \
            ../abigaail-sdk/abigaail-core-0.1.0.tgz \
            ../abigaail-sdk/abigaail-node-0.1.0.tgz
```

`@abigaail/schema` brings `zod` with it; the SDK itself does not use it at run time.

**Step 3: create the app in Abigaail and get its key.** In the Abigaail folder:

```bash
npm run app:create -- my-app
```

It prints an ingest key starting with `abk_`, **once**. Abigaail stores only a hash of
it. The key can only send events for this one app; it cannot read anything.

**Step 4: set the environment variables** for your app (in its `.env`, systemd unit, or
however it gets its configuration). Never commit the key.

| Variable | Required | Value |
|---|---|---|
| `ABIGAAIL_ENDPOINT` | yes | `http://127.0.0.1:4318/ingest` when the app runs on the same machine as Abigaail. Across machines, only over HTTPS (see below). |
| `ABIGAAIL_INGEST_KEY` | yes | The `abk_…` key from step 3 |
| `ABIGAAIL_RELEASE` | recommended | The deployed version, e.g. the git commit. Without it the release is `unknown` and deploys cannot be told apart from restarts. |
| `ABIGAAIL_ENVIRONMENT` | no | `production`, `staging`, `development` or `test`. Default: from `NODE_ENV`. |
| `ABIGAAIL_REGION` | no | Where the app runs, as a hosting region code such as `LON1` (uppercase letters, digits, hyphens). Sent once when the app starts; it places the app on the dashboard's map. Without it the app is listed as "not on the map". |

If the endpoint or key is missing, the SDK switches itself off (and says so once);
your app runs as before.

Over plain `http://` to *another* machine, the SDK leaves out the visitor's IP address
and user agent, so you get no visitor counts or bot detection. Put HTTPS in front of
the server (for example Caddy) before connecting apps on other machines.

**Step 5: start the SDK when your app starts,** before it handles requests:

```js
import { init } from "@abigaail/node";

const abigaail = init({
  // Your route patterns, so /user/42 and /user/43 count as one route.
  routes: ["/", "/user/[id]", "/api/orders/[orderId]"],
  // Behind Caddy or nginx on the same machine: 1. Facing the internet directly: leave it out.
  trustProxy: 1,
});
```

Paths that match no pattern are cleaned automatically (number- and ID-like
segments become `[id]`), so raw URLs are never stored even without `routes`.

**Step 6: report the errors you catch.** Only the error's class name and stack frames
(file, line, function) are sent, never its message:

```js
} catch (err) {
  abigaail.captureError(err, { route: "/user/[id]" });
  res.statusCode = 500;
  res.end();
}
```

**Optional:** on a clean shutdown, call `await abigaail.shutdown()` so the last events
are sent and Abigaail knows the stop was intended (otherwise it looks like a crash).
The SDK never adds signal handlers itself.

## 3. Connect a Next.js app

Written against Next 16 (App Router). The steps are the Node ones with two differences.

**Install** the four packages together (steps 1 and 2 above, with `@abigaail/next` added):

```bash
# In the Abigaail folder:
npm run build
npm pack -w @abigaail/schema -w @abigaail/core -w @abigaail/node -w @abigaail/next --pack-destination ../abigaail-sdk
# In your app:
npm install ../abigaail-sdk/abigaail-schema-0.1.0.tgz ../abigaail-sdk/abigaail-core-0.1.0.tgz \
            ../abigaail-sdk/abigaail-node-0.1.0.tgz ../abigaail-sdk/abigaail-next-0.1.0.tgz
```

Create the app and key and set the same environment variables (steps 3 and 4). **Never
prefix them with `NEXT_PUBLIC_`**: Next would put the key in the browser bundle, so the
SDK refuses to start if any `NEXT_PUBLIC_ABIGAAIL_*` variable exists.

**Add `instrumentation.ts`** at the project root (next to `app/`). The imports stay inside the
runtime check so Edge bundles never see Node-only code:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register } = await import("@abigaail/next");
    await register(); // same options as init() above, e.g. { trustProxy: 1 }
  }
}

export async function onRequestError(...args: Parameters<typeof import("@abigaail/next").onRequestError>) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { onRequestError } = await import("@abigaail/next");
    onRequestError(...args);
  }
}
```

**Keep the packages out of the bundle** in `next.config.mjs`, so instrumentation and your
route handlers share one SDK instance:

```js
export default {
  serverExternalPackages: ["@abigaail/next", "@abigaail/node", "@abigaail/core", "@abigaail/schema"],
};
```

Route patterns come from the build (`.next/routes-manifest.json`), so `next build` then
`next start` reports `/blog/[slug]` instead of each URL. Under `next dev` there is no
manifest yet and paths are cleaned by the ID heuristic. Errors thrown in pages and route
handlers reach Abigaail through `onRequestError` (class name and route only).

## 4. What is and isn't collected

**Sent by the SDK, for each:**

- **Request to your app:** method, route pattern (`/user/[id]`, never the URL),
  status, duration, request and response size (from `content-length` only), release,
  the referring site's domain only, and flags for suspicious requests (a scanner path
  like `/.env`, an injection-like pattern, a 401, a 429). Only the flag's name is sent,
  never the text that triggered it.
- **Call your app makes** (fetch, `http.request`): the host name only, method, status,
  duration, and whether it failed or timed out.
- **Error:** the class name (`TypeError`) and stack frames as project-relative file, line and
  function. Never the message, which can contain user data.
- **Metrics,** every 30 s: memory, CPU, event-loop delay, and the SDK's own queue and
  dropped-event counts.
- **Lifecycle:** start, a heartbeat every minute, clean shutdown, and the region code (at start).

**Used once at ingest, then discarded:** the visitor's IP address and user agent travel
with each request event. The server uses them in memory to compute a visitor ID
(a keyed hash with a secret that is replaced every day, so visitors cannot be linked
across days or across apps), a browser family (e.g. `chrome`) and whether the request
came from a bot. The IP address and user agent are never written to disk.

**Never collected:** IP addresses (beyond that moment at ingest), emails, names, user
IDs, cookies, tokens, authorization headers, request or response bodies, form inputs,
query-string values, error messages, or any other free text. The server checks every
event against an allowlist and refuses a whole batch if anything else is in it.

**How long it is kept:** until you delete it. Automatic deletion of old data is
planned, not built yet. The visitor-ID secret is the exception: it is replaced at
midnight UTC and the old one is erased.

Bots (crawlers, AI crawlers, scripts such as `curl`) and scanner probes are recorded but
counted separately: they never affect an app's health status.

## 5. Check that it works

Start your app and open a few pages **in a browser**. Then, in the Abigaail folder:

```bash
npm run app:list                  # "last event" should be a few seconds ago
npm run events:tail -- my-app     # the latest events: requests, heartbeats, the start
npm run findings -- my-app        # the app's status and anything the agents found
```

Events arrive within about 5 seconds (the SDK sends in batches). In the dashboard, the
app's **Live** tab shows them as they arrive (it needs `ABIGAAIL_LIVE_TOKEN`, see section 9).

Expect the status to be **grey ("too little data")** at first. Health judges an app
only once it has at least 20 requests from real visitors in 15 minutes. Requests made
with `curl` or other scripts count as bots and never turn it green. Comparisons with the
app's usual behaviour start after it has a few days of history.

If nothing arrives, look at your app's output first: the SDK prints one line, prefixed
`[abigaail]`, when the endpoint or key is missing, a `NEXT_PUBLIC_ABIGAAIL_*` variable
exists, the endpoint is plain http to another machine, or `trustProxy` looks wrong. A
**wrong key** prints nothing in the app: Abigaail answers 401 and the SDK quietly backs
off. If `app:list` shows no last event, compare the key with the one `app:create`
printed (or create a new app); many requests with unknown keys also show up in
`npm run findings` under "Abigaail itself".

## 6. Turn it off

- **In one app, right away:** remove `ABIGAAIL_INGEST_KEY` (or `ABIGAAIL_ENDPOINT`) and
  restart it, or pass `enabled: false` to `init` / `register`. The SDK then does nothing.
- **From Abigaail's side:** `npm run app:disable -- my-app` revokes the key. Ingest
  answers 403, the SDK backs off and keeps the app running normally. There is no
  re-enable: create a new app and key to reconnect.
- **For good:** remove the `init` call or `instrumentation.ts` and uninstall the packages.

The SDK never blocks or slows your app, with or without Abigaail: if the server is down,
events are dropped from a small fixed-size queue and the SDK retries later.

## 7. A privacy-notice snippet

Adapt this for your privacy notice. Fill in the brackets, and only state a retention
period you actually enforce: Abigaail does not delete old data automatically yet.

> We monitor this service with Abigaail, a monitoring tool we host ourselves. For each
> request it records technical information: the page or API route, the response status
> and time, the referring website's domain, and errors in our code. When your request
> arrives, your IP address and browser's user-agent string are used briefly, without being
> stored, to derive your browser type, whether the request comes from an automated
> client, and a pseudonymous visitor identifier. That identifier is a keyed hash that
> changes every day, so your visits cannot be linked from one day to the next. It is
> still personal data. We do not set cookies for this. The data stays on our own server
> and is not shared with anyone. We use it to keep the service working and secure
> (legitimate interest). We keep it for [period]. Contact [contact] with questions or to
> exercise your rights.

## 8. Try it without your own app

Two demo apps are included (`apps/demo-node`, `apps/demo-next`). Create an app for them,
copy their `.env.example` to `.env`, add the key, and run `npm run demo:node` (port 3001)
or `npm run demo:next` (port 3000).

**The bad-traffic simulator** shows every agent signal firing and then resolving, and
checks each one automatically:

```bash
npm run sim -- list                 # scenarios and the finding each must produce
npm run sim -- run slow-route       # one scenario (about 20 min)
npm run sim -- run all              # every scenario (about 55 min)
npm run sim -- run all --app next   # demo-next (build it first: npm run build -w @abigaail/demo-next)
npm run sim -- reset                # delete the simulator's data
```

Keep the machine awake while it runs (on Linux, prefix the command with `systemd-inhibit`):
if it sleeps, the simulator notices the gap and stops instead of judging.

The simulator runs its own server and demo app on a separate database in `data/sim/`,
seeds four weeks of normal history there so the agents have a baseline, then sends
realistic traffic: visitors on an hour-of-week curve, crawlers and scanner probes, a
failing dependency, a slow route, a burst of server errors, a crash loop, an outage, a
traffic collapse and a deploy. It prints PASS or FAIL for each expected finding, with how
long it took to appear and to resolve. It only talks to demo apps on this machine and
never touches `data/abigaail.db`; stop `npm run dev:server` and the demo first (it needs
their ports). To watch a run in the dashboard, set `ABIGAAIL_DB_PATH=./data/sim/abigaail.db`
in `apps/dashboard/.env` (and the same `ABIGAAIL_LIVE_TOKEN` for both, for the Live view).

## 9. Reference

### Commands

| Command | What it does |
|---|---|
| `npm run check` | Type-check and run all tests |
| `npm run build` | Compile the packages to `dist/` |
| `npm run dev:server` | Build and start the server (ingest + agents) |
| `npm run app:create -- <name>` | Register an app and print its ingest key (shown once) |
| `npm run app:disable -- <name>` | Revoke an app's key |
| `npm run app:list` | Apps, their state and last event |
| `npm run events:tail -- <name> [n]` | An app's latest events |
| `npm run findings -- <name>` | An app's status and open findings |
| `npm run agents:once` | Run every agent once now and print the findings |
| `npm run dashboard` | Build and start the dashboard on http://localhost:4319 |
| `npm run user:create -- <name>` | Create a dashboard user (also `user:disable`, `user:reset-mfa`, `user:unlock`) |
| `npm run sim -- <command>` | The bad-traffic simulator (section 8) |

### Server settings

`ABIGAAIL_DB_PATH` (default `./data/abigaail.db`), `ABIGAAIL_SALT_PATH` (default
`./data/salt.bin`), `ABIGAAIL_HOST` (default `127.0.0.1`), `ABIGAAIL_PORT` (default
`4318`), `ABIGAAIL_AGENTS=off` to run ingest only. The Live view's feed listens on
`127.0.0.1` only, port `ABIGAAIL_LIVE_PORT` (default `4320`), and only when
`ABIGAAIL_LIVE_TOKEN` is set (`openssl rand -base64 32`; the dashboard needs the same value).
`GET /healthz` answers 503 when the agents have stalled: point an external uptime check
at it. Before hosting anywhere, go through [docs/HOSTING.md](docs/HOSTING.md).

### What the SDK guarantees

Monitoring must never become the outage. The SDK (`@abigaail/core`):

- never throws into your code and never waits on the network while handling a request;
- keeps at most 1000 events in memory, then drops and counts the rest;
- samples request events when its queue is more than half full (errors are always kept);
- gives up on a send after 2 s, and after 3 failures in a row backs off from 30 s up to 5 min;
- never keeps your process alive, and does nothing at all when misconfigured.

Each guarantee has a test in `packages/core/test/client.test.ts`.

### Sending a batch by hand

```bash
curl -i http://127.0.0.1:4318/ingest \
  -H 'content-type: application/json' \
  -H 'x-abigaail-key: abk_PASTE_YOUR_KEY' \
  -d '{"schema_version":1,"sdk":{"name":"curl","version":"1"},"release":"abc123","environment":"development",
       "events":[{"type":"request","event_id":"3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b","client_ts":0,
                  "method":"GET","route":"/user/[id]","status":200,"duration_ms":12}]}'
```

Expect `202 {"accepted":1,"duplicates":0}`; the same batch again gives `"duplicates":1`.
A wrong key gives 401, and an extra field such as `"email":"x"` gives 400: the schema
is an allowlist (`packages/schema/test/validate.test.ts`).

### Layout

```
packages/
  schema/    Event schema v1: types and the server's strict validation
  core/      @abigaail/core: the fail-open event client and route cleaning
  node/      @abigaail/node: the Node adapter
  next/      @abigaail/next: the Next.js adapter
  store/     @abigaail/store: the SQLite store; every query scoped by app
  insights/  @abigaail/insights: baselines and the dashboard's numbers
  auth/      @abigaail/auth: passwords, TOTP and sessions for the dashboard
apps/
  server/    Ingest server, agents, and the app and user command-line tools
  dashboard/ Next.js dashboard, read-only on the monitoring data
  sim/       The bad-traffic simulator
  demo-node/ demo-next/   Demo apps
docs/        Specification, decisions, roadmap, agent design, hosting checklist
```

### Contributing

`dev` holds all work; `main` only receives tested chunks through a pull request from
`dev`. Each chunk: plan it, build it in small commits on `dev` with `npm run check`
passing before each, test it locally (the manual test is in
[docs/ROADMAP.md](docs/ROADMAP.md)), then open the `dev` → `main` pull request. Details
in [CLAUDE.md](CLAUDE.md). Requirements: [docs/SPEC.md](docs/SPEC.md); decisions and why:
[docs/DECISIONS.md](docs/DECISIONS.md); how the agents think: [docs/AGENTS.md](docs/AGENTS.md).
