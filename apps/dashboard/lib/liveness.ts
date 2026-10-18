import type { Liveness } from "@abigaail/insights";
import { ago, span } from "./format";

/** Process uptime, said as such: "Running for 3 d 4 h". Never a percentage. */
export function livenessText(l: Liveness, now: number): string {
  switch (l.kind) {
    case "running":
      return `Running for ${span(now - l.since)}`;
    case "silent":
      return `Silent for ${span(now - l.since)}`;
    case "stopped":
      return `Stopped ${ago(l.since, now)}`;
    case "never":
      return "No events yet";
  }
}
