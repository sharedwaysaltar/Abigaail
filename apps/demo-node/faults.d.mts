// Types for faults.mjs, so tests can import it.

export interface Faults {
  readonly dependency: "ok" | "failing";
  readonly slowSearch: boolean;
  readonly userErrorShare: number;
}

export interface FaultProcess {
  send?: (msg: unknown) => unknown;
  env: Record<string, string | undefined>;
  on(event: "message", listener: (msg: unknown) => void): unknown;
}

export const NORMAL_MS: Record<string, [number, number]>;
export const DEPENDENCY_MS: [number, number];
export const SLOW_SEARCH_MS: number;
export const NORMAL_FAULTS: Faults;
export function parseFaults(msg: unknown): Faults | undefined;
export function faultControl(proc?: FaultProcess): { enabled: boolean; get: () => Faults };
