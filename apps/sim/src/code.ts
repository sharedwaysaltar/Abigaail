// The simulator's stand-in for a GitHub repository (DECISIONS #138): fixed
// commits for its releases, what GitHub's compare of them answers, and a fake
// fine-grained token. The live server reaches it through fake-github.ts (a
// preload in the simulator's server process only); the replay stores the same
// diff as the server's GitHub job would. Nothing here is a real repository or token.

export const SIM_REPO = "abigaail-sim/demo";
/** Not a real token; only fake-github.ts accepts it. */
export const SIM_GITHUB_TOKEN = "github_pat_SIMULATED_fixture_only_0000000000";
/** The deploy step's commit for each simulated release (ABIGAAIL_COMMIT). */
export const SIM_COMMITS: Readonly<Record<string, string>> = {
  "sim-r1": "51a1000000000000000000000000000000000001",
  "sim-r2": "51a2000000000000000000000000000000000002",
};
/** In every patch the fixture serves; it must never reach the database (checked live and in tests). */
export const PATCH_MARKER = "SIM_PATCH_TEXT_MUST_NEVER_BE_STORED";

/**
 * GitHub's compare of sim-r1 with sim-r2: applyDiscount (faults.mjs, the
 * bad-deploy bug at line 135) changed in lines 133-136, and the README.
 */
export const SIM_COMPARE = {
  status: "ahead",
  total_commits: 1,
  files: [
    {
      filename: "apps/demo-node/faults.mjs",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: `@@ -133,3 +133,4 @@ export function applyDiscount(cart) {\n /** ${PATCH_MARKER} */\n-  return cart.total * 0.9;\n+  // ${PATCH_MARKER}\n+  return cart.totals.amount * 0.9;\n }`,
    },
    {
      filename: "apps/demo-node/README.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ -1,2 +1,3 @@\n # demo-node\n+${PATCH_MARKER}\n`,
    },
  ],
} as const;

/** The server's environment for the link (ABIGAAIL_GITHUB_REPO_<APP> / _TOKEN_<APP>). */
export function simGithubEnv(appName: string): Record<string, string> {
  const suffix = appName.toUpperCase().replace(/-/g, "_");
  return { [`ABIGAAIL_GITHUB_REPO_${suffix}`]: SIM_REPO, [`ABIGAAIL_GITHUB_TOKEN_${suffix}`]: SIM_GITHUB_TOKEN };
}
