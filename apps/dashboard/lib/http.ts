// Small helpers for the POST route handlers.

/**
 * Whether a POST comes from one of our own pages, so a form on another site
 * cannot post here. Sec-Fetch-Site decides when the browser sends it (only
 * "same-origin" passes; "same-site", "cross-site" and "none" do not). Without
 * it, the Origin header must name this host; a missing or "null" Origin fails.
 */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export const field = (form: FormData, name: string, max: number): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};
