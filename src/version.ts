import { readFileSync } from "node:fs";

/**
 * Version of this build, from package.json (next to dist/ in a checkout, a release archive and the Docker image).
 * Releases are tagged v<VERSION>; the release workflow refuses a tag that does not match package.json.
 */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();
