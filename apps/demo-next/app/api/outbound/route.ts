export async function GET() {
  try {
    const res = await fetch("https://example.com/?q=never-stored", { signal: AbortSignal.timeout(3000) });
    return Response.json({ status: res.status });
  } catch {
    return Response.json({ status: "failed (offline?)" }, { status: 502 });
  }
}
