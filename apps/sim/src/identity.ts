// Synthetic, non-personal request identity. Nothing here looks like a real
// person: no IP addresses (the simulator never sends X-Forwarded-For, so the
// demo's SDK sees 127.0.0.1), no emails or names, user ids are integers,
// referrers use reserved .example names (RFC 2606). Visitors differ only by a
// build number in an otherwise ordinary browser user agent.

/** Marks simulated browsers. Must not trip any bot rule in apps/server/src/derive.ts (tested). */
export const SIM_TOKEN = "AbigaailSim/1";

/** Distinct simulated visitors per day. */
export const VISITORS = 600;

/** A browser user agent for simulated visitor `n` (Chrome or Firefox on Linux). */
export function humanUa(n: number): string {
  const build = 1000 + (n % VISITORS);
  return n % 3 === 2
    ? `Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0.${build} ${SIM_TOKEN}`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.${build}.0 Safari/537.36 ${SIM_TOKEN}`;
}

export type BotKind = "crawler" | "ai_crawler" | "automation";

/** Bot user agents, by the class ingest should give them (tested against classifyUserAgent). */
export const BOT_UAS: Record<BotKind, readonly string[]> = {
  crawler: ["Mozilla/5.0 (compatible; SimCrawler/1.0; +https://crawler.example/)"],
  ai_crawler: ["Mozilla/5.0 (compatible; GPTBot/1.2; simulated)", "Mozilla/5.0 (compatible; ClaudeBot/1.0; simulated)"],
  automation: ["curl/8.5.0", "python-requests/2.32.3"],
};

/** Scanner probes (sent with a browser user agent, so the scanner_path flag is what keeps them out). */
export const SCANNER_PATHS: readonly string[] = ["/.env", "/.git/HEAD", "/wp-login.php", "/phpmyadmin/index.php", "/cgi-bin/test"];

/** Injection-like probes on real routes (flagged injection_like). Fixed strings. */
export const INJECTION_PATHS: Record<"node" | "next", readonly string[]> = {
  node: ["/search?q=%27%20or%201%3D1", "/user/7?id=..%2f..%2fetc%2fpasswd"],
  next: ["/?q=%27%20or%201%3D1", "/user/7?id=..%2f..%2fetc%2fpasswd"],
};

/** Referrers for human traffic: reserved example names only. */
export const REFERRERS: readonly string[] = ["https://search.example/", "https://news.example/item", "https://social.example/post"];

/** Share of human requests that carry a referrer. */
export const REFERRER_SHARE = 0.3;
