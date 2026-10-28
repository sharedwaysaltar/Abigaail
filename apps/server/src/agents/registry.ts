// Every agent the runner schedules. A new agent = one file plus one line here.

import { health } from "./health.js";
import { resilience } from "./resilience.js";
import { rollout } from "./rollout.js";
import type { Agent } from "./types.js";
import { usage } from "./usage.js";
import { watchdog } from "./watchdog.js";

export const AGENTS: readonly Agent[] = [usage, health, watchdog, resilience, rollout];

export function agentByName(name: string): Agent | undefined {
  return AGENTS.find((a) => a.name === name);
}
