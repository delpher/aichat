import { SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Api } from "../api/http";
import { REACTIONS, type Session } from "../api/types";
import { isAdmin, useChat } from "../context";

async function sendReaction(
  api: Api,
  session: Session,
  fail: (err: unknown, where: string) => void,
  id: number,
  as: string,
  emoji: string,
  remove: boolean,
) {
  const method = remove ? "DELETE" : "POST";
  try {
    if (isAdmin(session)) {
      await api.send(method, `/admin/api/messages/${id}/reactions`, { as, emoji });
    } else {
      await api.send(method, `/api/messages/${id}/reactions`, { emoji });
    }
  } catch (e) {
    fail(e, "Реакцію не збережено");
  }
}

/** Reaction chips shown under a message; clickable to toggle when `canReact` and `me` are set. */
export function ReactionList({
  id,
  reactions,
  me,
  canReact,
}: {
  id: number;
  reactions?: Record<string, string[]>;
  me?: string;
  canReact: boolean;
}) {
  const { api, session, fail } = useChat();
  const [busyEmoji, setBusyEmoji] = useState<string | null>(null);
  const entries = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  if (!entries.length) return null;

  const toggle = async (emoji: string, mine: boolean) => {
    if (!me || !canReact) return;
    setBusyEmoji(emoji);
    try {
      await sendReaction(api, session, fail, id, me, emoji, mine);
    } finally {
      setBusyEmoji(null);
    }
  };

  return (
    <span className="msg-reactions">
      {entries.map(([emoji, who]) => {
        const mine = Boolean(me && who.includes(me));
        const tip = `${emoji} ${who.join(", ")}`;
        if (!canReact || !me) {
          return (
            <span key={emoji} className="msg-react readonly" title={tip}>
              <span>{emoji}</span>
              <span className="num">{who.length}</span>
            </span>
          );
        }
        return (
          <button
            key={emoji}
            type="button"
            className={`msg-react${mine ? " on" : ""}`}
            aria-pressed={mine}
            aria-label={`${emoji} ${who.length}`}
            title={tip}
            disabled={busyEmoji !== null}
            onClick={() => void toggle(emoji, mine)}
          >
            <span>{emoji}</span>
            <span className="num">{who.length}</span>
          </button>
        );
      })}
    </span>
  );
}

/** Picker button in `.msg-tools` that opens the 8-emoji reaction palette. */
export function ReactionPicker({
  id,
  reactions,
  as,
}: {
  id: number;
  reactions?: Record<string, string[]>;
  as: string;
}) {
  const { api, session, fail } = useChat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (emoji: string) => {
    const mine = Boolean(reactions?.[emoji]?.includes(as));
    setOpen(false);
    setBusy(true);
    try {
      await sendReaction(api, session, fail, id, as, emoji, mine);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={wrap} className="react-wrap">
      <button
        type="button"
        className="icon-btn sm"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Реакція"
        aria-label="Реакція"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <SmilePlus size={15} />
      </button>
      {open && (
        <div className="react-picker" role="group" aria-label="Вибрати реакцію">
          {REACTIONS.map((emoji) => {
            const mine = Boolean(reactions?.[emoji]?.includes(as));
            return (
              <button
                key={emoji}
                type="button"
                className={`react-opt${mine ? " on" : ""}`}
                aria-pressed={mine}
                aria-label={emoji}
                title={mine ? `Зняти ${emoji}` : `Поставити ${emoji}`}
                onClick={() => void pick(emoji)}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
