const links = [
  ["/user/42?email=someone@example.com", "Dynamic page (query value must not be stored)"],
  ["/about", "Page inside a route group"],
  ["/api/slow", "Slow route handler (~300 ms)"],
  ["/api/boom", "Route handler that throws (500 + error event)"],
  ["/api/outbound", "Route handler that calls example.com (outbound event)"],
  ["/.env", "Scanner probe (404, unmatched, scanner_path flag)"],
];

export default function Home() {
  return (
    <main>
      <h1>Abigaail demo</h1>
      <p>Each link produces events. Watch them with <code>npm run events:tail -- demo</code>.</p>
      <ul>
        {links.map(([href, label]) => (
          <li key={href}>
            <a href={href}>{label}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
