import type { Measure } from "@abigaail/insights";
import { ms, pct, rate, sourceLabel } from "@/lib/format";

const show = (m: Measure, v: number | null) => (m.unit === "ms" ? ms(v) : m.unit === "%" ? pct(v) : rate(v));
const split = (text: string) => {
  const match = /^([^a-z%/]+)\s?(.*)$/i.exec(text);
  return match ? [match[1]!.trim(), match[2]!] : [text, ""];
};

/** Is "now" far enough from usual to say so? Twice the usual, or half for traffic. */
function off(m: Measure): boolean {
  if (m.value === null || m.usual === null) return false;
  if (m.unit === "/min") return m.usual >= 1 && (m.value < m.usual / 2 || m.value > m.usual * 2);
  if (m.unit === "%") return m.value >= 1 && m.value > 2 * m.usual + 0.5;
  return m.value > 2 * m.usual && m.value - m.usual > 50;
}

export function Figures({ measures }: { measures: Measure[] }) {
  return (
    <div className="figures">
      {measures.map((m) => {
        const [num, unit] = m.value === null ? ["—", ""] : split(show(m, m.value));
        return (
          <div className="figure" key={m.label}>
            <div className="label">{m.label}</div>
            <div className={`value${m.value === null ? " grey" : ""}`}>
              {num}
              {unit ? <span className="unit">{unit}</span> : null}
            </div>
            <div className={`usual${off(m) ? " off" : ""}`}>
              {m.value === null
                ? "Too little data"
                : m.usual === null
                  ? "No usual value yet"
                  : `Usually ${show(m, m.usual)}`}
            </div>
            {m.usual !== null && m.value !== null ? <div className="faint small">{sourceLabel(m.source)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
