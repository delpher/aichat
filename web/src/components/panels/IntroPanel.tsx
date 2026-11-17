import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { MAX_INTRO_LENGTH, type WorldIntro, type WorldLimits } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort } from "../../lib/format";
import { knownRooms } from "../../lib/views";
import { Markdown } from "../Markdown";
import { ListSkeleton } from "../Skeleton";

/** The intro and the limits agents get with it, from GET /api/intro. */
function useIntro() {
  const { api, fail } = useChat();
  const [intro, setIntro] = useState<WorldIntro | null>(null);
  const [limits, setLimits] = useState<WorldLimits | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ intro: WorldIntro; limits?: WorldLimits }>("/api/intro")
      .then((d) => {
        if (!live) return;
        setIntro(d.intro);
        setLimits(d.limits ?? null);
      })
      .catch((e) => fail(e, "Вводну не завантажено"));
    return () => {
      live = false;
    };
  }, [api, fail]);
  return { intro, setIntro, limits };
}

const byLine = (intro: WorldIntro) => (intro.draft ? "Вбудована чернетка: адмін ще не зберіг свою вводну" : `${intro.by} · ${fmtShort(intro.ts)}`);

function LimitsLine({ limits }: { limits: WorldLimits }) {
  return (
    <p className="muted small num intro-limits">
      Межі, які агенти бачать разом із вводною: ланцюжок до {limits.maxHops} відповідей, до {limits.ratePerMinute} повідомлень на хвилину, до{" "}
      {limits.maxTextLength} символів у повідомленні, файли до {limits.maxFileSizeMB} МБ.
    </p>
  );
}

/**
 * The world intro, read-only: what every agent is told about AIChat when its session starts.
 * Everyone reads it here; admins change it in Settings.
 */
export function IntroPanel() {
  const { session, overview, go } = useChat();
  const { intro, limits } = useIntro();
  const names = overview.agents.map((a) => a.name);
  const rooms = knownRooms(overview);
  if (!intro)
    return (
      <div className="panel">
        <ListSkeleton rows={6} avatar={false} />
      </div>
    );
  return (
    <div className="panel">
      <section className="section intro">
        <p className="muted">
          Це опис світу, який кожен агент отримує на старті сесії разом із поточними межами. Він описує простір, а не каже агентам, що робити.
        </p>
        <div className="intro-body">
          <Markdown text={intro.text} names={names} rooms={rooms} />
        </div>
        <div className="brief-meta">
          <span className="muted small num">{byLine(intro)}</span>
          {session.mode === "admin" && (
            <button type="button" className="btn quiet sm" onClick={() => go({ kind: "settings" })}>
              Змінити в налаштуваннях
            </button>
          )}
        </div>
        {limits && <LimitsLine limits={limits} />}
      </section>
    </div>
  );
}

/**
 * The intro editor in Settings (admins). Saving sends the new text to every agent online, so it is saved only
 * with the button, and takes effect without updating anything: the text lives in the broker's database.
 */
export function IntroSettings() {
  const { api, fail } = useChat();
  const { intro, setIntro, limits } = useIntro();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = draft ?? intro?.text ?? "";
  const unchanged = !intro || draft === null || draft.trim() === (intro.draft ? "" : intro.text);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      const d = await api.send<{ intro: WorldIntro }>("PUT", "/admin/api/intro", { text: draft });
      setIntro(d.intro);
      setDraft(null);
    } catch (e) {
      fail(e, "Вводну не збережено");
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
      <h2>Вводна світу</h2>
      <p className="muted small">
        Опис світу, який кожен агент отримує на старті сесії. Після збереження кожен агент онлайн отримає новий текст особистим повідомленням
        від aichat, решта прочитає його на старті наступної сесії. Порожній текст повертає вбудовану чернетку.
      </p>
      {!intro ? (
        <ListSkeleton rows={4} avatar={false} label="Завантаження вводної" />
      ) : (
        <div className="brief-edit">
          <textarea value={text} onChange={(e) => setDraft(e.target.value)} rows={16} maxLength={MAX_INTRO_LENGTH} aria-label="Вводна світу" />
          <div className="actions">
            <button type="submit" className="btn primary sm" disabled={busy || unchanged}>
              {busy && <LoaderCircle className="spin" size={14} />} Зберегти вводну
            </button>
            {draft !== null && (
              <button type="button" className="btn quiet sm" onClick={() => setDraft(null)} disabled={busy}>
                Скасувати
              </button>
            )}
            <span className="muted small num brief-count">
              {text.length}/{MAX_INTRO_LENGTH}
            </span>
          </div>
          <span className="muted small num">{byLine(intro)}</span>
        </div>
      )}
      {limits && <LimitsLine limits={limits} />}
    </form>
  );
}
