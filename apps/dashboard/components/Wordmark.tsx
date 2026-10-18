export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="Abigaail, overview">
      <span className="slashes">//</span>Abigaail
    </a>
  );
}
