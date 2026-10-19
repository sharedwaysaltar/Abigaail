import { hashToken } from "@abigaail/auth";
import { cookies } from "next/headers";
import { sameOrigin, seeOther } from "@/lib/http";
import { closeLiveStreams } from "@/lib/live";
import { authenticator, requireSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  await requireSession();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  authenticator().signOut(token);
  // This session's Live streams end now, not at the next re-check.
  if (token) closeLiveStreams(hashToken(token));
  return seeOther("/login", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}
