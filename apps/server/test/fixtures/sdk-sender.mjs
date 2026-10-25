// A child process sending events through the real SDK (sources, run with
// ts-sources.mjs): `count` metrics, one every `everyMs`, then a flush until
// the queue is empty; each value is its sequence number. Prints the stats as JSON. Used to show that
// ingest during a VACUUM loses no batch.
const [endpoint, ingestKey, count, everyMs, timeoutMs] = process.argv.slice(2);
const { createClient } = await import("@abigaail/core");

const client = createClient({
  endpoint,
  ingestKey,
  release: "r1",
  environment: "test",
  flushIntervalMs: 20,
  timeoutMs: Number(timeoutMs),
  breaker: { failureThreshold: 1000, baseCooldownMs: 10, maxCooldownMs: 50 },
});
for (let i = 0; i < Number(count); i++) {
  client.capture({ type: "metric", name: "cpu_percent", value: i });
  await new Promise((r) => setTimeout(r, Number(everyMs)));
}
// Until a flush (which waits for one already in flight) leaves nothing queued.
for (let i = 0; i < 500; i++) {
  await client.flush();
  if (client.stats().queued === 0) break;
  await new Promise((r) => setTimeout(r, 20));
}
await client.shutdown();
process.stdout.write(JSON.stringify(client.stats()));
