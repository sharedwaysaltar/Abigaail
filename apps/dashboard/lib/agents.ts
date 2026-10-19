/** One line per agent for the Agents page: what it watches. */
export const AGENT_PURPOSE: Record<string, string> = {
  health: "Errors, latency, saturation and dependencies against each app's own normal.",
  watchdog: "Silent apps, refused keys, stalled agents and Abigaail's own health.",
  usage: "Traffic, unique humans, quiet routes and referrers, from the hourly rollup.",
  rollup: "Rolls raw events into hourly stats, the only source of baselines.",
};
