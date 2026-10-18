export async function GET(): Promise<Response> {
  throw new TypeError("demo failure for someone@example.com (this message must never be stored)");
}
