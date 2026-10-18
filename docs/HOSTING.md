# Hosting checklist

Requirements for any machine that runs the Abigaail server. Hosting itself is
decided later (see DECISIONS #2); this list grows as chunks land.

- [ ] **Full-disk encryption** on every volume that holds `data/` (database, WAL,
      `salt.bin`) and swap. Overwriting the salt in place cannot reach SSD
      wear-levelling copies or filesystem journal / copy-on-write remnants
      (DECISIONS #24); encryption at rest is what covers those.
- [ ] **Exclude `data/salt.bin` from backups.** It is a one-day secret; restoring an
      old one would let that day's visitor hashes be recomputed. A lost salt only
      means a new one is generated.
- [ ] `data/` owned by the service user, directory mode 0700; `salt.bin` stays 0600.
- [ ] **Ingest only over HTTPS.** Apps must reach `/ingest` through TLS (e.g. Caddy in
      front). Over plain http to another machine the SDK withholds visitor IP/UA
      (DECISIONS #36), so visitor hashes, bot class and geo stay empty.
- [ ] Ingest keys and other secrets come from the environment, never from files in the repo.
