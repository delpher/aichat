import { Check, Copy } from "lucide-react";
import { memo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { rehypeCode } from "../lib/highlight";

/** A fenced code block: highlighted by language (when the block names one) with a copy button. */
function CodeBlock({ children, lang }: { children: React.ReactNode; lang: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = pre.current?.innerText ?? "";
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{lang}</span>
        <button type="button" className="icon-btn sm" onClick={copy} title="Копіювати код" aria-label="Копіювати код">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  );
}

/** Language named on a fence (```ts) as react-markdown passes it: the code element's class "language-ts". */
function langOf(children: React.ReactNode): string {
  const code = Array.isArray(children) ? children[0] : children;
  const cls = (code as { props?: { className?: string } } | null)?.props?.className ?? "";
  return /language-([\w+#-]+)/.exec(cls)?.[1] ?? "";
}

// Unknown languages stay plain text; only languages named on the fence are highlighted (no guessing).
const rehypePlugins = [rehypeCode];

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
  pre: ({ children }) => <CodeBlock lang={langOf(children)}>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Highlights @name mentions of known participants and #room references to known rooms inside plain text.
 * A #room counts only at the start of a word (not "a#b" or "&#38;"), so issue numbers like "#12" stay text
 * unless a room is called that.
 */
function refPlugin(names: string[], rooms: string[]) {
  const people = new Set(names);
  const roomSet = new Set(rooms);
  type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
  return () => (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children) return;
      if (node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
      const out: Node[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !/[@#]/.test(child.value ?? "")) {
          walk(child);
          out.push(child);
          continue;
        }
        const re = /([@#])([A-Za-z0-9_-]{1,64})/g;
        const v = child.value!;
        let last = 0;
        for (let m = re.exec(v); m; m = re.exec(v)) {
          const room = m[1] === "#";
          if (room ? !roomSet.has(m[2]) || (m.index > 0 && /[\w&#]/.test(v[m.index - 1])) : !people.has(m[2])) continue;
          if (m.index > last) out.push({ type: "text", value: v.slice(last, m.index) });
          out.push({
            type: room ? "roomRef" : "mention",
            data: { hName: "span", hProperties: room ? { className: "room-ref", dataRoom: m[2] } : { className: "mention" } },
            children: [{ type: "text", value: m[0] }],
          });
          last = m.index + m[0].length;
        }
        if (last < v.length) out.push({ type: "text", value: v.slice(last) });
      }
      node.children = out;
    };
    walk(tree);
  };
}

export const Markdown = memo(function Markdown({ text, names = [], rooms = [] }: { text: string; names?: string[]; rooms?: string[] }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, refPlugin(names, rooms)]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
