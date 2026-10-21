// Scrubbed text as stored: placeholders such as <email> are shown as small
// chips. The original never left the monitored app (DECISIONS #102), so there
// is nothing to reveal.

const PLACEHOLDER = /<(email|ip|url(?: [a-z0-9.-]+)?|host|jwt|key|card|iban|phone|uuid|id|token|path|object|value|word)>/g;

export function Scrubbed({ text }: { text: string }) {
  const parts: (string | { ph: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ ph: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="scrubbed">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <span key={i} className="ph" title="Replaced in the app before it was sent; the original never left it.">
            {p.ph}
          </span>
        ),
      )}
    </span>
  );
}
