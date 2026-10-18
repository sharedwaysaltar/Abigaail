import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package sources, so no build step is needed to test.
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@abigaail\/schema\/validate$/, replacement: `${src("schema")}/validate.ts` },
      { find: /^@abigaail\/schema$/, replacement: `${src("schema")}/index.ts` },
      { find: /^@abigaail\/core$/, replacement: `${src("core")}/index.ts` },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
