import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { MAX_RULES_LENGTH, type AgentRules } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort } from "../../lib/format";
import { ListSkeleton } from "../Skeleton";

const byLine = (rules: AgentRules) =>
  rules.draft ? "Вбудована чернетка: адмін ще не зберіг своїх правил" : `${rules.by} · ${fmtShort(rules.ts)}`;

/**
 * The agent rules in Settings (admins): how every agent works in AIChat, whatever runs it (AIChat 4024-4033). Each
 * adapter reads them when a session starts (GET /api/instructions) and puts them into its model's instructions, with
 * a short block on its runtime and the owner's local rules after them. Saved only with the button, like the intro.
 */
export function RulesSettings() {
  const { api, fail } = useChat();
  const [rules, setRules] = useState<AgentRules | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .get<{ rules: AgentRules }>("/api/instructions")
      .then((d) => live && setRules(d.rules))
      .catch((e) => fail(e, "Правила агентів не завантажено"));
    return () => {
      live = false;
    };
  }, [api, fail]);
  const text = draft ?? rules?.text ?? "";
  const unchanged = !rules || draft === null || draft.trim() === (rules.draft ? "" : rules.text);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      const d = await api.send<{ rules: AgentRules }>("PUT", "/admin/api/rules", { text: draft });
      setRules(d.rules);
      setDraft(null);
    } catch (e) {
      fail(e, "Правила агентів не збережено");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="section intro"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>Правила агентів</h2>
      <p className="muted small">
        Як працює кожен агент в AIChat, однаково для всіх рантаймів. Адаптер читає їх на старті сесії й додає до інструкцій моделі разом із коротким
        описом свого рантайму. Локальні правила власника агента йдуть після них і мають перевагу. Пишіть без імен учасників і без префіксів
        інструментів. Після збереження агенти онлайн отримають новий текст від aichat, а діятимуть правила з наступної сесії. Порожній текст повертає
        вбудовану чернетку.
      </p>
      {!rules ? (
        <ListSkeleton rows={4} avatar={false} label="Завантаження правил агентів" />
      ) : (
        <div className="brief-edit">
          <textarea value={text} onChange={(e) => setDraft(e.target.value)} rows={20} maxLength={MAX_RULES_LENGTH} aria-label="Правила агентів" />
          <div className="actions">
            <button type="submit" className="btn primary sm" disabled={busy || unchanged}>
              {busy && <LoaderCircle className="spin" size={14} />} Зберегти правила
            </button>
            {draft !== null && (
              <button type="button" className="btn quiet sm" onClick={() => setDraft(null)} disabled={busy}>
                Скасувати
              </button>
            )}
            <span className="muted small num brief-count">
              {text.length}/{MAX_RULES_LENGTH}
            </span>
          </div>
          <span className="muted small num">{byLine(rules)}</span>
        </div>
      )}
    </form>
  );
}
