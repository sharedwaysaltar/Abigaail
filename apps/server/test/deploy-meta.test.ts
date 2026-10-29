// Deploy metadata end to end (deploy_v1, DECISIONS #130): the real SDK
// against the real ingest server. It travels on its own event, independent of
// runtime signals, held until the server announces it, sent once; an invalid
// value is left out with a warning that names the setting, never the value.

import { afterEach, beforeEach, expect, it } from "vitest";
import { init, type AbigaailNode, type NodeOptions } from "@abigaail/node";
import { startServer, type TestServer } from "./helpers.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LOCK = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

let s: TestServer;
let key: string;
let appId: string;
let sdk: AbigaailNode | undefined;
const warnings: string[] = [];

beforeEach(async () => {
  s = await startServer();
  ({ key, app: { id: appId } } = s.store.createApp("shop", "test"));
  warnings.length = 0;
});
afterEach(async () => {
  await sdk?.shutdown(500);
  sdk = undefined;
  await s.close();
});

function start(release: string, env: Record<string, string>, opts: NodeOptions = {}): AbigaailNode {
  sdk = init({
    endpoint: `${s.url}/ingest`,
    ingestKey: key,
    release,
    environment: "production",
    flushIntervalMs: 0,
    metricsIntervalMs: 0,
    heartbeatIntervalMs: 0,
    env,
    onInternalError: (e) => warnings.push(e instanceof Error ? e.message : String(e)),
    ...opts,
  });
  return sdk;
}
const deploy = (release: string) => s.store.deploys(appId).find((d) => d.release === release);

it("a fresh start with runtimeSignals: false records commit, previous release and lockfile", async () => {
  const a = start("v2.0.0", { ABIGAAIL_COMMIT: SHA, ABIGAAIL_PREVIOUS_RELEASE: "v1.9.3", ABIGAAIL_LOCKFILE_HASH: LOCK }, { runtimeSignals: false });
  // The first batch (boot) learns the features; the deploy event follows in the same flush.
  await a.flush();
  expect(deploy("v2.0.0")).toMatchObject({ commit_sha: SHA, previous_release: "v1.9.3", lockfile_hash: LOCK });
  expect(a.stats()).toMatchObject({ unsupported: 0, invalid: 0, rejected: 0 });
  expect(warnings.filter((w) => w.includes("ABIGAAIL_"))).toEqual([]);
});

it("a release that is a SHA is its own commit; nothing else needs setting", async () => {
  const a = start(SHA, {}, { runtimeSignals: false });
  await a.flush();
  await a.flush();
  expect(deploy(SHA)).toMatchObject({ commit_sha: SHA, previous_release: null, lockfile_hash: null });
});

it("without any deploy metadata nothing extra is sent", async () => {
  const a = start("v2.0.0", {});
  await a.flush();
  await a.flush();
  expect(deploy("v2.0.0")).toMatchObject({ commit_sha: null, previous_release: null, lockfile_hash: null });
});

it("an invalid value is left out with a warning naming the setting, never the value", async () => {
  const a = start("v2.0.0", { ABIGAAIL_COMMIT: "my-branch", ABIGAAIL_LOCKFILE_HASH: "/srv/app/package-lock.json", ABIGAAIL_PREVIOUS_RELEASE: "v1.9.3" }, { runtimeSignals: false });
  await a.flush();
  await a.flush();
  expect(deploy("v2.0.0")).toMatchObject({ commit_sha: null, previous_release: "v1.9.3", lockfile_hash: null });
  expect(warnings.join("\n")).toMatch(/ABIGAAIL_COMMIT is not a git commit SHA/);
  expect(warnings.join("\n")).toMatch(/ABIGAAIL_LOCKFILE_HASH is not a SHA-256/);
  expect(warnings.join("\n")).not.toMatch(/my-branch|package-lock|\/srv/);
});
