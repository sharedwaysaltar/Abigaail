/** @type {import('next').NextConfig} */
export default {
  // Load the Abigaail packages from node_modules at runtime instead of bundling
  // them, so instrumentation and request handlers share one SDK instance.
  serverExternalPackages: ["@abigaail/next", "@abigaail/node", "@abigaail/core", "@abigaail/schema"],
};
