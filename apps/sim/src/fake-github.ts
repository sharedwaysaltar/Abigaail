// Loaded with --import into the simulator's own server process only (never by
// `npm run dev:server`): answers that process's calls to https://api.github.com
// from the fixture in code.ts, so a live run exercises the real GitHub job
// without a network or a real token. Every other request goes to the real fetch.
// ABIGAAIL_SIM_GITHUB=down answers every call with a network error (GitHub down).

import { PATCH_MARKER, SIM_COMMITS, SIM_COMPARE, SIM_GITHUB_TOKEN, SIM_REPO } from "./code.js";

const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.github.com") return realFetch(input, init);
  if (process.env.ABIGAAIL_SIM_GITHUB === "down") throw new TypeError("fetch failed");
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== `Bearer ${SIM_GITHUB_TOKEN}`) return json(401, { message: "Bad credentials" });
  if (url.pathname === `/repos/${SIM_REPO}`) return json(200, { full_name: SIM_REPO });
  if (url.pathname === `/repos/${SIM_REPO}/compare/${SIM_COMMITS["sim-r1"]}...${SIM_COMMITS["sim-r2"]}`) return json(200, SIM_COMPARE);
  if (url.pathname === `/repos/${SIM_REPO}/compare/${SIM_COMMITS["sim-r2"]}...${SIM_COMMITS["sim-r1"]}`) {
    // The rollback: the same change undone.
    return json(200, { ...SIM_COMPARE, files: SIM_COMPARE.files.map((f) => ({ ...f, patch: f.patch.replace(PATCH_MARKER, `${PATCH_MARKER}_undo`) })) });
  }
  return json(404, { message: "Not Found" });
};
