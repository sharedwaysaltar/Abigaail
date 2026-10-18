// Runs one agent over every app and over Abigaail itself, isolating failures
// per scope. Used inside the worker, and directly by tests.

import type { Agent, AgentContext, WorkerResult } from "./types.js";

/** The error's class name only, never its message (messages can carry data). */
export function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : "Error";
}

export function evaluate(agent: Agent, ctx: AgentContext): WorkerResult {
  const result: WorkerResult = { findings: [], evaluated: [], failed: [] };
  if (agent.forApp) {
    for (const app of ctx.apps) {
      try {
        const found = agent.forApp(ctx, app);
        result.findings.push(...found.map((f) => ({ ...f, app_id: app.id })));
        result.evaluated.push(app.id);
      } catch (err) {
        // One app's odd data never hides the others.
        result.failed.push({ app_id: app.id, error_class: errorClass(err) });
      }
    }
  }
  if (agent.forSystem) {
    try {
      result.findings.push(...agent.forSystem(ctx).map((f) => ({ ...f, app_id: null })));
      result.evaluated.push(null);
    } catch (err) {
      result.failed.push({ app_id: null, error_class: errorClass(err) });
    }
  }
  return result;
}
