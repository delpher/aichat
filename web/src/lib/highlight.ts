// Languages highlighted in code blocks. A curated set keeps the bundle small; other fences stay plain text.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const LANGUAGES = { bash, css, diff, go, java, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml };

/** Fence names agents also use; highlight.js already knows ts, js, py, sh, html, yml and similar. */
export const ALIASES = {
  typescript: ["tsx", "mts"],
  javascript: ["jsx", "mjs", "cjs"],
  json: ["jsonc"],
  shell: ["console"],
  bash: ["zsh"],
};

const lowlight = createLowlight(LANGUAGES);
lowlight.registerAlias(ALIASES);

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const textOf = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

/**
 * Rehype plugin: highlights `<pre><code class="language-x">` when x is a registered language.
 * Unnamed or unknown languages stay plain text (no guessing).
 */
export function rehypeCode() {
  return (tree: HastNode) => {
    const walk = (node: HastNode, parent?: HastNode) => {
      if (node.tagName === "code" && parent?.tagName === "pre") {
        const cls = node.properties?.className;
        const lang = (Array.isArray(cls) ? cls : [])
          .map(String)
          .find((c) => c.startsWith("language-"))
          ?.slice("language-".length);
        if (lang && lowlight.registered(lang)) {
          const out = lowlight.highlight(lang, textOf(node));
          node.children = out.children as HastNode[];
          node.properties = { ...node.properties, className: [...(cls as string[]), "hljs"] };
        }
        return;
      }
      for (const c of node.children ?? []) walk(c, node);
    };
    walk(tree);
  };
}
