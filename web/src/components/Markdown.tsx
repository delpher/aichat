import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Raw HTML in messages is never rendered (react-markdown escapes it without rehype-raw),
// links open in a new tab without access to this page, and remote images are not loaded.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      {alt || String(src ?? "")}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/** Highlights @name mentions of known participants inside plain text. */
function mentionPlugin(names: string[]) {
  const set = new Set(names);
  type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
  return () => (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children) return;
      if (node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
      const out: Node[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value?.includes("@")) {
          walk(child);
          out.push(child);
          continue;
        }
        const re = /@([A-Za-z0-9_-]{1,64})/g;
        let last = 0;
        for (let m = re.exec(child.value); m; m = re.exec(child.value)) {
          if (!set.has(m[1])) continue;
          if (m.index > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
          out.push({
            type: "mention",
            data: { hName: "span", hProperties: { className: "mention" } },
            children: [{ type: "text", value: m[0] }],
          });
          last = m.index + m[0].length;
        }
        if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
      }
      node.children = out;
    };
    walk(tree);
  };
}

export const Markdown = memo(function Markdown({ text, names = [] }: { text: string; names?: string[] }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, mentionPlugin(names)]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
