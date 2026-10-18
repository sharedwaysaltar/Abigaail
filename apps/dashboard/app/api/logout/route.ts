import { cookies } from "next/headers";
import { sameOrigin, seeOther } from "@/lib/http";
import { authenticator, requireSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  await requireSession();
  authenticator().signOut((await cookies()).get(SESSION_COOKIE)?.value);
  return seeOther("/login", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}
