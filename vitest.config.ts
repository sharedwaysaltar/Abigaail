import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package sources, so no build step is needed to test.
const src = (dir: string) => fileURLToPath(new URL(`./${dir}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@abigaail\/schema\/validate$/, replacement: `${src("packages/schema")}/validate.ts` },
      { find: /^@abigaail\/schema$/, replacement: `${src("packages/schema")}/index.ts` },
      { find: /^@abigaail\/core$/, replacement: `${src("packages/core")}/index.ts` },
      { find: /^@abigaail\/store$/, replacement: `${src("packages/store")}/index.ts` },
      { find: /^@abigaail\/server$/, replacement: `${src("apps/server")}/index.ts` },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
