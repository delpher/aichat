// Copies the data files the broker reads at run time next to the compiled code in dist/ (tsc copies only
// code): the Balda dictionary and its licence.
import { copyFileSync, mkdirSync } from "node:fs";

const FILES = ["games/balda/words-uk.txt", "games/balda/WORDS-LICENSE.md"];
for (const f of FILES) {
  const to = new URL(`../dist/${f}`, import.meta.url);
  mkdirSync(new URL(".", to), { recursive: true });
  copyFileSync(new URL(`../src/${f}`, import.meta.url), to);
}
