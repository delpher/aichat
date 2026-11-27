import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "../../api/http";
import type { BrokerTool } from "../../api/types";
import { useChat } from "../../context";
import { plural } from "../../lib/format";
import { ListSkeleton } from "../Skeleton";
import { CopyButton } from "./SetupBox";

const GROUP_LABEL: Record<string, string> = {
  chat: "Чат",
  games: "Ігри",
  notes: "Нотатник",
  brief: "Брифи",
  rooms: "Кімнати",
  world: "Світ",
  admin: "Адмін",
};

const groupLabel = (group: string) => GROUP_LABEL[group] ?? group;

/** Compact human-readable type label for a JSON Schema property. */
export function formatSchemaType(spec: Record<string, unknown>): string {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    return spec.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (spec.type === "array") {
    const items = spec.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      const inner = formatSchemaType(items as Record<string, unknown>);
      return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
    }
    return "array";
  }
  if (Array.isArray(spec.type)) return spec.type.map(String).join(" | ");
  if (typeof spec.type === "string") return spec.type;
  return "any";
}

function ToolCard({ tool }: { tool: BrokerTool }) {
  const properties = Object.entries(tool.inputSchema?.properties ?? {});
  const required = new Set(Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : []);
  const reqCount = properties.filter(([name]) => required.has(name)).length;
  const meta =
    properties.length === 0
      ? "Без параметрів"
      : reqCount > 0
        ? `${properties.length} ${plural(properties.length, ["параметр", "параметри", "параметрів"])} · ${reqCount} ${plural(reqCount, ["обов'язковий", "обов'язкові", "обов'язкових"])}`
        : `${properties.length} ${plural(properties.length, ["параметр", "параметри", "параметрів"])}`;
  // Exact projection that MCP tools/list returns to agents.
  const rawJson = JSON.stringify(
    { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
    null,
    2,
  );

  return (
    <li className="card tool-card">
      <div className="tool-head">
        <code className="tool-name">{tool.name}</code>
        <span className="tool-group" title={`Група: ${tool.group}`}>
          {groupLabel(tool.group)}
        </span>
        <span className="tool-meta">{meta}</span>
      </div>
      <p className="tool-desc">{tool.description}</p>
      <details className="manual tool-params">
        <summary>
          {properties.length > 0
            ? `Параметри (${properties.length})`
            : "JSON-схема (як у tools/list)"}
        </summary>
        {properties.length > 0 ? (
          <>
            <ul className="tool-param-list">
              {properties.map(([paramName, rawSpec]) => {
                const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : {};
                const desc = typeof spec.description === "string" ? spec.description : "";
                return (
                  <li key={paramName} className="tool-param">
                    <div className="tool-param-head">
                      <code className="tool-param-name">{paramName}</code>
                      <span className="tool-param-type">{formatSchemaType(spec)}</span>
                      {required.has(paramName) && <span className="tool-req">обов'язковий</span>}
                    </div>
                    {desc && <p className="tool-param-desc">{desc}</p>}
                  </li>
                );
              })}
            </ul>
            <details className="tool-raw">
              <summary>JSON-схема (як у tools/list)</summary>
              <div className="code">
                <div className="code-head">
                  <span className="code-lang">json</span>
                  <CopyButton text={rawJson} />
                </div>
                <pre>
                  <code>{rawJson}</code>
                </pre>
              </div>
            </details>
          </>
        ) : (
          <div className="code">
            <div className="code-head">
              <span className="code-lang">json</span>
              <CopyButton text={rawJson} />
            </div>
            <pre>
              <code>{rawJson}</code>
            </pre>
          </div>
        )}
      </details>
    </li>
  );
}

/** Settings → Tools: read-only view of the MCP tools the broker exposes to agents (alexey, AIChat 3824). */
export function ToolsPanel() {
  const { api, fail } = useChat();
  const [tools, setTools] = useState<BrokerTool[] | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setBusy(true);
    setError("");
    try {
      const d = await api.get<{ tools?: BrokerTool[] }>("/admin/api/tools");
      if (seq !== seqRef.current) return;
      setTools(Array.isArray(d.tools) ? d.tools : []);
    } catch (err) {
      if (seq !== seqRef.current) return;
      if (err instanceof AuthError) fail(err, "");
      else setError((err as Error).message || "Не вдалося завантажити список інструментів.");
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  }, [api, fail]);

  useEffect(() => {
    void load();
    return () => {
      seqRef.current++;
    };
  }, [load]);

  const list = tools ?? [];
  const groups = [...new Set(list.map((t) => t.group))];
  const activeGroup = group && groups.includes(group) ? group : null;
  const visible = activeGroup ? list.filter((t) => t.group === activeGroup) : list;

  return (
    <section className="section" aria-label="Інструменти брокера">
      <div className="section-head">
        <h2>
          Інструменти брокера
          {tools !== null && <span className="count">{list.length}</span>}
        </h2>
        <button type="button" className="btn ghost sm" onClick={() => void load()} disabled={busy}>
          {busy && tools !== null && <LoaderCircle className="spin" size={14} />} Оновити
        </button>
      </div>
      <p className="tools-intro">
        Каталог MCP-інструментів (<code>/mcp</code>), які брокер віддає агентам у <code>tools/list</code> — із тими самими назвами, описами та
        схемами параметрів.
      </p>

      {groups.length > 1 && (
        <div className="tools-groups" role="group" aria-label="Фільтр за групою">
          <button
            type="button"
            className={`pick-item${activeGroup === null ? " on" : ""}`}
            aria-pressed={activeGroup === null}
            onClick={() => setGroup(null)}
          >
            Усі <span className="muted num">{list.length}</span>
          </button>
          {groups.map((g) => {
            const count = list.filter((t) => t.group === g).length;
            return (
              <button
                key={g}
                type="button"
                className={`pick-item${activeGroup === g ? " on" : ""}`}
                aria-pressed={activeGroup === g}
                onClick={() => setGroup(g)}
              >
                {groupLabel(g)} <span className="muted num">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="card">
          <p className="status error" role="alert">
            Не вдалося завантажити інструменти: {error}
          </p>
          <div className="actions">
            <button type="button" className="btn ghost sm" onClick={() => void load()} disabled={busy}>
              Повторити
            </button>
          </div>
        </div>
      )}

      {busy && tools === null ? (
        <ListSkeleton rows={3} avatar={false} label="Завантаження інструментів" />
      ) : !error && visible.length === 0 ? (
        <p className="muted">Брокер поки не зареєстрував жодного MCP-інструмента.</p>
      ) : (
        visible.length > 0 && (
          <ul className="tools-list">
            {visible.map((t) => (
              <ToolCard key={t.name} tool={t} />
            ))}
          </ul>
        )
      )}
    </section>
  );
}
