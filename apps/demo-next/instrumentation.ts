// Abigaail wiring. Import inside the runtime check so edge bundles never see
// Node-only code.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register } = await import("@abigaail/next");
    await register();
  }
}

export async function onRequestError(...args: Parameters<typeof import("@abigaail/next").onRequestError>) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { onRequestError } = await import("@abigaail/next");
    onRequestError(...args);
  }
}
