/** Server configuration from the environment. Secrets never live in files. */
export interface Config {
  dbPath: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ABIGAAIL_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("ABIGAAIL_PORT must be a port number");
  return {
    dbPath: env.ABIGAAIL_DB_PATH || "./data/abigaail.db",
    host: env.ABIGAAIL_HOST || "127.0.0.1",
    port,
  };
}
