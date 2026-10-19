import { dashboardConfig } from "@/lib/config";
import { reader } from "@/lib/data";
import { openRelay, SSE_HEADERS } from "@/lib/live";
import { authenticator, requireApiSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

// The Live view's event stream: the server's loopback feed for one app, relayed
// after the session check. The live token stays here; the browser never sees it.
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { name } = await params;
  const app = reader().appByName(decodeURIComponent(name));
  if (!app) return plain(404, "No such app");
  const { livePort, liveToken } = dashboardConfig();
  if (!liveToken) return plain(503, "Live view is off");
  const relay = await openRelay({
    sessionHash: auth.tokenHash,
    signal: req.signal,
    stillValid: () => authenticator().peekSession(auth.token) !== undefined,
    upstream: (signal) =>
      fetch(`http://127.0.0.1:${livePort}/live?app=${encodeURIComponent(app.id)}`, {
        headers: { authorization: `Bearer ${liveToken}` },
        cache: "no-store",
        signal,
      }),
  });
  if (!relay.ok) return plain(relay.status, relay.status === 429 ? "Too many live views open" : relay.status === 503 ? "Live view is off" : "Live feed unavailable");
  return new Response(relay.stream, { headers: SSE_HEADERS });
}
