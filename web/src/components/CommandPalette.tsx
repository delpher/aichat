import { BookOpen, Gamepad2, Hash, Inbox, LayoutGrid, LoaderCircle, Search, Settings, UserCog } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { fmtShort } from "../lib/format";
import { dm, isGameRoom, type View } from "../lib/views";
import { Avatar } from "./Avatar";
import { snippet } from "./MessageItem";

interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

const fold = (s: string) => s.toLocaleLowerCase();
/** Search waits this long after the last keystroke. */
const DEBOUNCE_MS = 250;

/** One line of a message around the first match, with the match marked. */
function Excerpt({ text, query }: { text: string; query: string }) {
  const i = fold(text).indexOf(fold(query));
  if (i < 0) return <>{text.slice(0, 120)}</>;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + query.length + 80);
  return (
    <>
      {start > 0 && "…"}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length, end)}
      {end < text.length && "…"}
    </>
  );
}

/** Ctrl+K: jump to any room, conversation or page, and search message text. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { overview, session, sender, go, api, openMessage, fail } = useChat();
  const admin = session.mode === "admin";
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const kinds = useMemo(() => new Map(overview.agents.map((a) => [a.name, a.kind])), [overview.agents]);

  // ---- places to go ----
  const places = useMemo<Item[]>(() => {
    const nav = (v: View) => () => go(v);
    const out: Item[] = [];
    if (admin) out.push({ key: "all", label: "Усі повідомлення", icon: <Inbox size={16} />, run: nav({ kind: "all" }) });
    for (const r of [...overview.rooms].filter((r) => !isGameRoom(r.name)).sort((x, y) => x.name.localeCompare(y.name)))
      out.push({
        key: `r:${r.name}`,
        label: `#${r.name}`,
        hint: "кімната",
        icon: <Hash size={16} />,
        run: nav({ kind: "room", room: r.name }),
      });
    for (const a of [...overview.agents].sort((x, y) => x.name.localeCompare(y.name))) {
      if (a.name === sender) continue;
      out.push({
        key: `d:${a.name}`,
        label: a.name,
        hint: a.online ? "особисті · онлайн" : "особисті",
        icon: <Avatar name={a.name} kind={a.kind} size="sm" />,
        run: nav(dm(sender, a.name)),
      });
    }
    out.push({ key: "games", label: "Міні-ігри", icon: <Gamepad2 size={16} />, run: nav({ kind: "games" }) });
    out.push({ key: "intro", label: "Вводна світу", icon: <BookOpen size={16} />, run: nav({ kind: "intro" }) });
    if (admin)
      out.push(
        { key: "people", label: "Агенти й люди", icon: <UserCog size={16} />, run: nav({ kind: "people" }) },
        { key: "rooms", label: "Керування кімнатами", icon: <LayoutGrid size={16} />, run: nav({ kind: "rooms" }) },
        { key: "settings", label: "Налаштування", icon: <Settings size={16} />, run: nav({ kind: "settings" }) },
      );
    return out;
  }, [overview, admin, sender, go]);

  const query = q.trim();
  const shownPlaces = (query ? places.filter((p) => fold(p.label).includes(fold(query.replace(/^[#@]/, "")))) : places).slice(
    0,
    query ? 6 : 8,
  );

  // ---- message search ----
  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const t = setTimeout(() => {
      api
        .get<{ messages: ChatMessage[] }>(`${admin ? "/admin/api/search" : "/api/search"}?q=${encodeURIComponent(query)}&limit=20`)
        .then((d) => live && setResults(d.messages))
        .catch((e) => live && (setResults([]), fail(e, "Пошук")))
        .finally(() => live && setSearching(false));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, admin, api, fail]);

  const found: Item[] = (results ?? []).map((m) => ({
    key: `m:${m.id}`,
    label: m.from,
    icon: <Avatar name={m.from} kind={kinds.get(m.from)} size="sm" />,
    run: () => openMessage(m),
  }));
  const items = [...shownPlaces, ...found];
  useEffect(() => setIdx(0), [query, results]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIdx((i) => (items.length ? (i + d + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(idx);
    }
  };

  const where = (m: ChatMessage) =>
    m.room ? `#${m.room}` : m.to === sender ? "вам" : m.from === sender ? `→ ${m.to}` : `${m.from} → ${m.to}`;

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Пошук і перехід" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          {searching ? <LoaderCircle size={18} className="spin muted" /> : <Search size={18} className="muted" />}
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Кімната, людина або текст повідомлення"
            aria-label="Пошук"
            aria-controls="palette-list"
            aria-activedescendant={items[idx] ? `pal-${idx}` : undefined}
            role="combobox"
            aria-expanded
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shownPlaces.length > 0 && (
            <li className="palette-group" role="presentation">
              Перейти
            </li>
          )}
          {shownPlaces.map((it, i) => (
            <li key={it.key} id={`pal-${i}`} role="option" aria-selected={i === idx} data-idx={i}>
              <button type="button" className={i === idx ? "on" : ""} onClick={() => choose(i)} onMouseEnter={() => setIdx(i)}>
                <span className="palette-icon">{it.icon}</span>
                <span className="palette-label">{it.label}</span>
                {it.hint && <span className="muted small">{it.hint}</span>}
              </button>
            </li>
          ))}
          {query.length >= 2 && (
            <li className="palette-group" role="presentation">
              Повідомлення
            </li>
          )}
          {(results ?? []).map((m, j) => {
            const i = shownPlaces.length + j;
            return (
              <li key={m.id} id={`pal-${i}`} role="option" aria-selected={i === idx} data-idx={i}>
                <button
                  type="button"
                  className={`palette-msg${i === idx ? " on" : ""}`}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setIdx(i)}
                >
                  <span className="palette-icon">{found[j].icon}</span>
                  <span className="palette-msg-body">
                    <span className="palette-msg-head">
                      <strong>{m.from}</strong>
                      <span className="muted small">{where(m)}</span>
                      <span className="muted small num">{fmtShort(m.ts)}</span>
                    </span>
                    <span className="palette-excerpt">
                      <Excerpt text={snippet(m)} query={query} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {query.length >= 2 && results && !results.length && !searching && (
            <li className="palette-empty muted" role="presentation">
              Нічого не знайдено
            </li>
          )}
          {query.length === 1 && (
            <li className="palette-empty muted small" role="presentation">
              Для пошуку в повідомленнях введіть щонайменше 2 символи
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
