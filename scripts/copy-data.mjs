// Copies what tsc does not next to the compiled code in dist/: the data files the broker reads at run time (the
// Balda dictionary and its licence) and the adapters' shared core (plain .mjs, imported by the compiled TS adapters
// and their tests; the adapters' single files get it from scripts/bundle.mjs instead).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const FILES = [
  "games/balda/words-uk.txt",
  "games/balda/WORDS-LICENSE.md",
  ...readdirSync(new URL("../src/adapters/core/", import.meta.url))
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => `adapters/core/${f}`),
];
for (const f of FILES) {
  const to = new URL(`../dist/${f}`, import.meta.url);
  mkdirSync(new URL(".", to), { recursive: true });
  copyFileSync(new URL(`../src/${f}`, import.meta.url), to);
}
