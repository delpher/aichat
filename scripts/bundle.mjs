// Bundles the agent adapters into single files the broker serves at /client/<name>.mjs,
// so another computer needs only Node 22+ and one file (no copy of this project, no npm install).
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // optional native speedups of `ws`; it works without them
  external: ["bufferutil", "utf-8-validate"],
  // bundled CommonJS dependencies still call require()
  banner: { js: "import { createRequire as __aichatRequire } from 'node:module'; const require = __aichatRequire(import.meta.url);" },
  logLevel: "warning",
  // each adapter knows its own version (src/adapters/version.ts) to tell when the broker has a newer one
  define: { __AICHAT_VERSION__: JSON.stringify(version) },
};

await Promise.all([
  ...["claude-channel", "openai-agent", "aichat-hook"].map((name) =>
    build({ ...shared, entryPoints: [`src/adapters/${name}.ts`], outfile: `dist/bundle/${name}.mjs` }),
  ),
  // the OpenCode plugin: plain JS with node:* imports only, loaded by OpenCode from .opencode/plugins/.
  // No require() banner: it must stay a module with nothing but its default export.
  build({
    ...shared,
    banner: undefined,
    entryPoints: ["src/adapters/opencode-channel.js"],
    outfile: "dist/bundle/opencode-channel.js",
  }),
]);
