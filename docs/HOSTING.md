# Hosting checklist

Requirements for any machine that runs the Abigaail server. Hosting itself is
decided later (see DECISIONS #2); this list grows as chunks land.

- [ ] **Full-disk encryption** on every volume that holds `data/` (database, WAL,
      `salt.bin`) and swap. Overwriting the salt in place cannot reach SSD
      wear-levelling copies or filesystem journal / copy-on-write remnants
      (DECISIONS #24); encryption at rest is what covers those.
- [ ] **Backups must not outlive retention.** Abigaail deletes raw events after
      `ABIGAAIL_RETAIN_EVENTS_DAYS` (default 30) and erases them from the database file
      (DECISIONS #89); a backup kept longer still holds them. Keep backups of `data/` for at
      most that many days.
- [ ] **Free disk of at least 2.2 × the database once**, at the first start after upgrading to
      chunk 7: the server converts the file to incremental vacuum (a one-time VACUUM, temp copy
      in `data/`). Without the room it skips this, keeps running and reports `vacuum_pending`;
      deleted data is still erased, but the file cannot shrink until a restart with room.
- [ ] **Exclude `data/salt.bin` from backups.** It is a one-day secret; restoring an
      old one would let that day's visitor hashes be recomputed. A lost salt only
      means a new one is generated.
- [ ] `data/` owned by the service user, directory mode 0700; `salt.bin` stays 0600.
- [ ] **Ingest only over HTTPS.** Apps must reach `/ingest` through TLS (e.g. Caddy in
      front). Over plain http to another machine the SDK withholds visitor IP/UA
      (DECISIONS #36), so visitor hashes, bot class and geo stay empty.
- [ ] Ingest keys and other secrets come from the environment, never from files in the repo.
- [ ] **External uptime check on `/healthz`.** It answers 503 when the Watchdog has
      stopped running (DECISIONS #45), so this check watches the watcher. Alert on
      anything but 200.
- [ ] **The dashboard is never exposed publicly.** Reach it over a VPN (e.g. Tailscale) or put
      an IP allowlist in front, plus TLS. It binds 127.0.0.1:4319 by default; behind one local
      reverse proxy set `ABIGAAIL_DASHBOARD_TRUST_PROXY=1` so the sign-in throttle sees the
      client's address (DECISIONS #62, #64).
- [ ] `ABIGAAIL_DASHBOARD_SECRET` (`openssl rand -base64 32`) is set in the environment of both
      the dashboard and anyone running `npm run user:*`. Losing it means re-enrolling every
      user's authenticator (`user:reset-mfa`).
- [ ] `data/auth.db` (users, sessions, sign-in audit) is in `data/`, mode 0600, and backed up
      with the database.
- [ ] Only `/ingest` and `/healthz` are proxied publicly. The Live feed listener
      (127.0.0.1:4320) stays on loopback and is never proxied; its host cannot be changed
      (DECISIONS #72).
- [ ] `ABIGAAIL_LIVE_TOKEN` (`openssl rand -base64 32`) is set to the same value for the server
      and the dashboard, from the environment. Without it the Live view is off; nothing else changes.
- [ ] No `NEXT_PUBLIC_ABIGAAIL_*` variable exists in the dashboard's environment (it refuses to start).
- [ ] **Alerts:** the server may connect out to the webhook (443), the SMTP server (465 or 587) and the
      heartbeat URL, and nothing else needs to be opened. Their settings and secrets are in the
      server's environment only (`ABIGAAIL_ALERT_*`, `ABIGAAIL_SMTP_*`, `ABIGAAIL_HEARTBEAT_URL`).
      `ABIGAAIL_ALERT_WEBHOOK_ALLOW_PRIVATE=1` only for a receiver on your own network (DECISIONS #96).
- [ ] **Two independent ways to hear about trouble:** configure both alert channels, or one channel
      plus `ABIGAAIL_HEARTBEAT_URL` / an uptime check on `/healthz`. A single channel cannot report its
      own failure (DECISIONS #98), and nothing inside Abigaail can report the server being down.
