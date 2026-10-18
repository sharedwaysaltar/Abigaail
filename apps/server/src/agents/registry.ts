// Every agent the runner schedules. A new agent = one file plus one line here.

import type { Agent } from "./types.js";
import { watchdog } from "./watchdog.js";

export const AGENTS: readonly Agent[] = [watchdog];

export function agentByName(name: string): Agent | undefined {
  return AGENTS.find((a) => a.name === name);
}
