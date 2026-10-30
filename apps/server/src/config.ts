import { RETENTION, type RetentionDays, type RetentionPeriod } from "./agents/thresholds.js";
import { loadAlertConfig, type AlertConfig } from "./alerts/config.js";
import { loadGithubConfig, type CodeLinkConfig } from "./github.js";

/** Server configuration from the environment. Keys and secrets never live in the repo. */
export interface Config {
  dbPath: string;
  /** Daily visitor-hash salt file, kept outside the database. */
  saltPath: string;
  host: string;
  port: number;
  /** ABIGAAIL_AGENTS=off disables the agent runner (ingest only). */
  agents: boolean;
  /** Dashboard users and sessions, apart from monitoring data. */
  authDbPath: string;
  /** Live feed port. Its host is always 127.0.0.1 (live.ts); no setting changes that. */
  livePort: number;
  /** Bearer token the dashboard sends to the live feed. Empty: the Live view is off. */
  liveToken: string;
  /** Days kept per table (ABIGAAIL_RETAIN_*_DAYS). */
  retention: RetentionDays;
  /** Alert channels, links and the heartbeat URL (none set: alerts are off). */
  alerts: AlertConfig;
  /** Read-only GitHub links, one per app (ABIGAAIL_GITHUB_REPO_<APP> / ABIGAAIL_GITHUB_TOKEN_<APP>). */
  github: CodeLinkConfig[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ABIGAAIL_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("ABIGAAIL_PORT must be a port number");
  const livePort = Number(env.ABIGAAIL_LIVE_PORT ?? 4320);
  if (!Number.isInteger(livePort) || livePort < 0 || livePort > 65535) throw new Error("ABIGAAIL_LIVE_PORT must be a port number");
  return {
    dbPath: env.ABIGAAIL_DB_PATH || "./data/abigaail.db",
    saltPath: env.ABIGAAIL_SALT_PATH || "./data/salt.bin",
    host: env.ABIGAAIL_HOST || "127.0.0.1",
    port,
    agents: (env.ABIGAAIL_AGENTS ?? "on").toLowerCase() !== "off",
    authDbPath: env.ABIGAAIL_AUTH_DB_PATH || "./data/auth.db",
    livePort,
    liveToken: env.ABIGAAIL_LIVE_TOKEN ?? "",
    retention: loadRetention(env),
    alerts: loadAlertConfig(env),
    github: loadGithubConfig(env),
  };
}

/**
 * Retention periods from ABIGAAIL_RETAIN_<NAME>_DAYS. A value that is not a
 * whole number of days, is below its minimum or above RETENTION.maxDays throws,
 * so the server does not start: clamping would hide a misconfiguration.
 */
export function loadRetention(env: NodeJS.ProcessEnv = process.env): RetentionDays {
  const out = {} as RetentionDays;
  for (const [name, p] of Object.entries(RETENTION.periods) as [RetentionPeriod, (typeof RETENTION.periods)[RetentionPeriod]][]) {
    const key = `ABIGAAIL_RETAIN_${p.env}_DAYS`;
    const raw = env[key]?.trim();
    if (!raw) {
      out[name] = p.days;
      continue;
    }
    if (!/^\d{1,5}$/.test(raw)) throw new Error(`${key} must be a whole number of days (at least ${p.minDays})`);
    const days = Number(raw);
    if (days < p.minDays) throw new Error(`${key}=${days} is below the minimum of ${p.minDays} days`);
    if (days > RETENTION.maxDays) throw new Error(`${key}=${days} is above the maximum of ${RETENTION.maxDays} days`);
    out[name] = days;
  }
  return out;
}
