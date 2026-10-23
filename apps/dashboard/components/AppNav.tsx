/** Overview · Live · Runtime · Findings for one app. The current one is in ink, the rest muted. */
export function AppNav({ name, current }: { name: string; current: "overview" | "live" | "runtime" | "findings" }) {
  const base = `/apps/${encodeURIComponent(name)}`;
  const items = [
    { key: "overview", href: base, label: "Overview" },
    { key: "live", href: `${base}/live`, label: "Live" },
    { key: "runtime", href: `${base}/runtime`, label: "Runtime" },
    { key: "findings", href: `/findings?app=${encodeURIComponent(name)}`, label: "Findings" },
  ] as const;
  return (
    <nav className="subnav" aria-label={`${name} views`}>
      {items.map((i) => (
        <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>
          {i.label}
        </a>
      ))}
    </nav>
  );
}
