// Lets a child process run package sources with Node's type stripping
// (tests have no build step): `@abigaail/<pkg>` resolves to packages/<pkg>/src,
// and a relative "./x.js" to "./x.ts" when only the source exists.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    const pkg = /^@abigaail\/([a-z]+)(\/validate)?$/.exec(specifier);
    if (pkg) {
      const file = new URL(`packages/${pkg[1]}/src/${pkg[2] ? "validate" : "index"}.ts`, root);
      return next(file.href, context);
    }
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const ts = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (!existsSync(fileURLToPath(new URL(specifier, context.parentURL))) && existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
