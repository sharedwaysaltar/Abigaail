export async function GET() {
  await new Promise((r) => setTimeout(r, 300));
  return Response.json({ ok: true });
}
