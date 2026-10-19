import type { Severity as Level } from "@abigaail/store";

export const SEVERITY_LABEL: Record<Level, string> = {
  critical: "Critical",
  warning: "Warning",
  unknown: "Unknown",
  info: "Info",
};

/**
 * Never colour alone: critical = solid red, warning = red ring, unknown = solid
 * grey, info = faint ring; always with the word next to it.
 */
export function SeverityMark({ severity, size = 10 }: { severity: Level; size?: number }) {
  const r = size / 2;
  const ring = severity === "warning" || severity === "info";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: "none" }}>
      {ring ? (
        <circle cx={r} cy={r} r={r - 1} fill="none" stroke={severity === "warning" ? "var(--red)" : "var(--faint)"} strokeWidth={1.75} />
      ) : (
        <circle cx={r} cy={r} r={r} fill={severity === "critical" ? "var(--red)" : "var(--grey)"} />
      )}
    </svg>
  );
}

export function Severity({ severity }: { severity: Level }) {
  return (
    <span className="status">
      <SeverityMark severity={severity} />
      <span className="status-label">{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}
