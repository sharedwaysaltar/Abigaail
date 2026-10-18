/** @type {import('next').NextConfig} */
export default {
  // node:sqlite and the store must load from node_modules at runtime, not be bundled.
  serverExternalPackages: ["@abigaail/store", "@abigaail/insights", "@abigaail/auth", "@abigaail/schema"],
  poweredByHeader: false,
};
