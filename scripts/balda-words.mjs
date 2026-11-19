// Builds src/games/balda/words-uk.txt, the Balda dictionary, from VESUM (brown-uk/dict_uk, data/dict/base.lst):
//   curl -fsSLo base.lst https://raw.githubusercontent.com/brown-uk/dict_uk/master/data/dict/base.lst
//   node scripts/balda-words.mjs base.lst
// Keeps common nouns as the dictionary lists them (nominative singular; plural-only nouns as they are),
// written in lowercase Ukrainian letters only: no proper names, abbreviations, slang, archaic or pre-2019
// spellings, and no words with an apostrophe or a hyphen (a Balda cell holds one letter).
// The list is a derivative of VESUM and keeps its licence: see src/games/balda/WORDS-LICENSE.md.
import { readFileSync, writeFileSync } from "node:fs";

const [src] = process.argv.slice(2);
if (!src) {
  console.error("usage: node scripts/balda-words.mjs <path to VESUM base.lst>");
  process.exit(2);
}
const WORD = /^[абвгґдеєжзиіїйклмнопрстуфхцчшщьюя]{2,}$/;
const SKIP = /:(prop|pname|abbr|slang|bad|arch|up92|alt|rare|obsc|vulg)\b/;
const words = new Set();
for (const raw of readFileSync(src, "utf8").split("\n")) {
  const line = raw.replace(/#.*/, "").trim();
  if (!line) continue;
  const [lemma, ...rest] = line.split(/\s+/);
  const tags = rest.join(" ");
  const noun = /^\/n/.test(tags) || /^noun:/.test(tags);
  if (!noun || SKIP.test(tags) || !WORD.test(lemma)) continue;
  words.add(lemma);
}
const out = [...words].sort((a, b) => a.localeCompare(b, "uk"));
writeFileSync(new URL("../src/games/balda/words-uk.txt", import.meta.url), out.join("\n") + "\n");
console.log(`${out.length} words`);
