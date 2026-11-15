// Bundles the agent adapters into single files the broker serves at /client/<name>.mjs,
// so another computer needs only Node 22+ and one file (no copy of this project, no npm install).
import { build } from "esbuild";

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
};

await Promise.all(
  ["claude-channel", "openai-agent", "aichat-hook"].map((name) =>
    build({ ...shared, entryPoints: [`src/adapters/${name}.ts`], outfile: `dist/bundle/${name}.mjs` }),
  ),
);
