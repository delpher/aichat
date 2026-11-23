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
 * Links inside plain text (not in code or links), by an explicit syntax (alexey, AIChat 3120-3130):
 * - `@name` a known participant, `#room` a known room (never a bare number: "PR #80" is just text);
 * - `[[msg:1234]]` message 1234 in this conversation, `[[msg:lobby/1234]]` in a room, `[[msg:@name/1234]]` in a
 *   direct conversation with that participant;
 * - `[[user:name]]` and `[[room:name]]`, the explicit forms (a room may be called "12");
 * - a game room (`#game-21`, `[[room:game-21]]`) links to its game (alexey, 3135).
 * Anything else stays as written. A @ or # counts only at the start of a word (not "a#b" or "&#38;").
 */
const REF = /\[\[(msg|room|user):([^\]\s]{1,140})\]\]|([@#])([A-Za-z0-9_-]{1,64})/g;
const MSG = /^(?:(@?[A-Za-z0-9_-]{1,64})\/)?(\d{1,9})$/;
const GAME_ROOM = /^game-\d{1,9}$/;

function refPlugin(names: string[], rooms: string[]) {
  const people = new Set(names);
  const roomSet = new Set(rooms);
  const isRoom = (name: string) => roomSet.has(name) || GAME_ROOM.test(name);
  type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
  const span = (type: string, props: Record<string, string>, text: string): Node => ({
    type,
    data: { hName: "span", hProperties: props },
    children: [{ type: "text", value: text }],
  });
  /** The link for one match, or null to leave the text as it is. */
  const link = (m: RegExpExecArray, v: string): Node | null => {
    if (m[1]) {
      const [kind, arg] = [m[1], m[2]];
      if (kind === "user") return people.has(arg) ? span("mention", { className: "mention" }, `@${arg}`) : null;
      if (kind === "room") return isRoom(arg) ? span("roomRef", { className: "room-ref", dataRoom: arg }, `#${arg}`) : null;
      const ref = MSG.exec(arg);
      if (!ref) return null;
      const [, place, id] = ref;
      const props: Record<string, string> = { className: "msg-ref", dataMsg: id };
      if (place) props.dataPlace = place;
      return span("msgRef", props, place ? `${place.startsWith("@") ? "" : "#"}${place}/${id}` : `#${id}`);
    }
    // @ or # only at the start of a word: not "a#b", "x@y.z" or "&#38;"
    if (m.index > 0 && /[\w&#@]/.test(v[m.index - 1])) return null;
    if (m[3] === "@") return people.has(m[4]) ? span("mention", { className: "mention" }, m[0]) : null;
    return isRoom(m[4]) && !/^\d+$/.test(m[4]) ? span("roomRef", { className: "room-ref", dataRoom: m[4] }, m[0]) : null;
  };
  return () => (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children) return;
      if (node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
      const out: Node[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !/[@#]|\[\[/.test(child.value ?? "")) {
          walk(child);
          out.push(child);
          continue;
        }
        const v = child.value!;
        let last = 0;
        for (let m = REF.exec(v); m; m = REF.exec(v)) {
          const made = link(m, v);
          if (!made) continue;
          if (m.index > last) out.push({ type: "text", value: v.slice(last, m.index) });
          out.push(made);
          last = m.index + m[0].length;
        }
        REF.lastIndex = 0;
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
