// Entry point for `npm run user:*` (see users.ts).

import { loadConfig } from "./config.js";
import { prompt } from "./prompt.js";
import { runUserCommand } from "./users.js";

const [command, name] = process.argv.slice(2);
try {
  await runUserCommand(command, name, {
    env: process.env,
    authDbPath: loadConfig().authDbPath,
    prompt,
    print: (line) => console.log(line),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
