import { AUTH } from "@abigaail/auth";
import { field, sameOrigin, seeOther } from "@/lib/http";
import { authenticator, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// Sign-in: the one route that does not require a session. Every failure looks
// the same to the browser; the reason goes to the auth audit log only.
export async function POST(req: Request): Promise<Response> {
  // The throttle keys on x-abigaail-peer, which only server.mjs sets reliably.
  if (process.env.ABIGAAIL_DASHBOARD_SERVER !== "1") return new Response("Start the dashboard with npm run dashboard.", { status: 503 });
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const form = await req.formData();
  const result = await authenticator().signIn({
    name: field(form, "name", 64),
    password: field(form, "password", 1024),
    code: field(form, "code", 16),
    address: req.headers.get("x-abigaail-peer") ?? "unknown",
  });
  if (!result.ok) return seeOther("/login?e=1");
  const maxAge = Math.floor(AUTH.sessionMaxMs / 1000);
  return seeOther("/", `${SESSION_COOKIE}=${result.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
}
