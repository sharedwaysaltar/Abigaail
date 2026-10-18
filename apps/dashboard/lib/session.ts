import { Authenticator, SecretKey } from "@abigaail/auth";
import { openAuthStore } from "@abigaail/store";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { dashboardConfig } from "./config";

/** __Host-: Secure, Path=/ and no Domain are enforced by the browser. */
export const SESSION_COOKIE = "__Host-abigaail_session";

const KEY = Symbol.for("abigaail.dashboard.auth");
type G = typeof globalThis & { [KEY]?: Authenticator };

export function authenticator(): Authenticator {
  const g = globalThis as G;
  return (g[KEY] ??= new Authenticator(openAuthStore(dashboardConfig().authDbPath), SecretKey.fromEnv()));
}

/**
 * The signed-in user, or a redirect to /login. Every page and route handler
 * calls this itself (a layout's check does not cover every request); a test
 * fails if one does not.
 */
export async function requireSession(): Promise<{ user: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = authenticator().session(token);
  if (!s) redirect("/login");
  return { user: s.user };
}
