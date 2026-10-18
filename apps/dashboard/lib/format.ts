// Plain-English numbers and times. Times are shown in UTC, labelled.

import type { AppStatus } from "@abigaail/store";

export const STATUS_LABEL: Record<AppStatus, string> = {
  green: "Healthy",
  amber: "Worth a look",
  red: "Needs you",
  grey: "Too little data",
};

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v >= 10_000) return `${(v / 1000).toFixed(0)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`;
  if (v >= 10) return `${Math.round(v)} ms`;
  return `${v.toFixed(1)} ms`;
}

export function rate(perMin: number | null | undefined): string {
  if (perMin === null || perMin === undefined) return "—";
  if (perMin >= 100) return `${Math.round(perMin).toLocaleString("en-GB")}/min`;
  if (perMin >= 10) return `${perMin.toFixed(0)}/min`;
  if (perMin === 0) return "0/min";
  return `${perMin.toFixed(1)}/min`;
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "0%";
  if (v < 0.1) return "<0.1%";
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
}

/** "3 d 4 h", "2 h 5 min", "12 min", "40 s". */
export function span(msLong: number): string {
  const s = Math.max(0, Math.round(msLong / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const ago = (ts: number, now: number): string => `${span(now - ts)} ago`;

/** "18 Oct 14:05 UTC". */
export function when(ts: number): string {
  const d = new Date(ts);
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "14:00". */
export const hourLabel = (ts: number): string => `${String(new Date(ts).getUTCHours()).padStart(2, "0")}:00`;

export function sourceLabel(source: "hour-of-week" | "daily" | "none"): string {
  return source === "hour-of-week" ? "same hour, last 4 weeks" : source === "daily" ? "same hour, last 7 days" : "no history yet";
}
