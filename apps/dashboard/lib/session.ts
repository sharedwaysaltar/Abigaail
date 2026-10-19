import { Authenticator, hashToken, SecretKey } from "@abigaail/auth";
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

/**
 * For API routes a script calls (the Live stream): the signed-in user, or a
 * 401 Response, never a redirect, so the client can stop and say "Signed out".
 * Read-only (peekSession): an open stream and its reconnects never refresh
 * last_seen, so they cannot keep an idle session alive. Use it as
 * `const auth = await requireApiSession(); if (auth instanceof Response) return auth;`
 * (the static test accepts exactly that form).
 */
export async function requireApiSession(): Promise<{ user: string; token: string; tokenHash: string } | Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = authenticator().peekSession(token);
  if (!s || !token) return new Response("Signed out", { status: 401, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  return { user: s.user, token, tokenHash: hashToken(token) };
}
