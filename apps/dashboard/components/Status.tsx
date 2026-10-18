import type { AppStatus } from "@abigaail/store";
import { STATUS_LABEL } from "@/lib/format";

/**
 * Status is never colour alone: each one has its own shape and a label.
 * Healthy = solid green, Worth a look = red ring, Needs you = solid red,
 * Too little data = grey.
 */
export function StatusMark({ status, size = 10 }: { status: AppStatus; size?: number }) {
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: "none" }}>
      {status === "amber" ? (
        <circle cx={r} cy={r} r={r - 1} fill="none" stroke="var(--red)" strokeWidth={1.75} />
      ) : (
        <circle cx={r} cy={r} r={r} fill={status === "red" ? "var(--red)" : status === "green" ? "var(--green)" : "var(--grey)"} />
      )}
    </svg>
  );
}

export function Status({ status, label = true }: { status: AppStatus; label?: boolean }) {
  return (
    <span className="status">
      <StatusMark status={status} />
      {label ? <span className="status-label">{STATUS_LABEL[status]}</span> : <span className="sr-only">{STATUS_LABEL[status]}</span>}
    </span>
  );
}
