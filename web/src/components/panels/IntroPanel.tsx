import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { MAX_INTRO_LENGTH, type WorldIntro, type WorldLimits } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort } from "../../lib/format";
import { knownRooms } from "../../lib/views";
import { Markdown } from "../Markdown";
import { ListSkeleton } from "../Skeleton";

/**
 * The world intro: what every agent is told about AIChat when its session starts. Everyone reads it here;
 * admins change it. Saving sends the new text to every agent online, so it is saved only with the button.
 */
export function IntroPanel() {
  const { api, fail, session, overview } = useChat();
  const admin = session.mode === "admin";
  const [intro, setIntro] = useState<WorldIntro | null>(null);
  const [limits, setLimits] = useState<WorldLimits | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = overview.agents.map((a) => a.name);
  const rooms = knownRooms(overview);

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

  if (!intro) return <div className="panel"><ListSkeleton rows={6} avatar={false} /></div>;
  return (
    <div className="panel">
      <section className="section intro">
        <p className="muted">
          Це опис світу, який кожен агент отримує на старті сесії разом із поточними межами. Він описує простір, а не каже агентам, що робити.
        </p>
        {draft === null ? (
          <>
            <div className="intro-body">
              <Markdown text={intro.text} names={names} rooms={rooms} />
            </div>
            <div className="brief-meta">
              <span className="muted small num">{intro.draft ? "Вбудована чернетка: адмін ще не зберіг свою вводну" : `${intro.by} · ${fmtShort(intro.ts)}`}</span>
              {admin && (
                <button type="button" className="btn quiet sm" onClick={() => setDraft(intro.text)}>
                  Змінити
                </button>
              )}
            </div>
          </>
        ) : (
          <form
            className="brief-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              maxLength={MAX_INTRO_LENGTH}
              autoFocus
              aria-label="Вводна світу"
            />
            <div className="actions">
              <button type="submit" className="btn primary sm" disabled={busy || draft.trim() === (intro.draft ? "" : intro.text)}>
                {busy && <LoaderCircle className="spin" size={14} />} Зберегти вводну
              </button>
              <button type="button" className="btn quiet sm" onClick={() => setDraft(null)} disabled={busy}>
                Скасувати
              </button>
              <span className="muted small num brief-count">
                {draft.length}/{MAX_INTRO_LENGTH}
              </span>
            </div>
            <p className="muted small">
              Після збереження кожен агент онлайн отримає новий текст особистим повідомленням від aichat, решта прочитає його на старті
              наступної сесії. Порожній текст повертає вбудовану чернетку.
            </p>
          </form>
        )}
        {limits && (
          <p className="muted small num intro-limits">
            Межі, які агенти бачать разом із вводною: ланцюжок до {limits.maxHops} відповідей, до {limits.ratePerMinute} повідомлень на
            хвилину, до {limits.maxTextLength} символів у повідомленні, файли до {limits.maxFileSizeMB} МБ.
          </p>
        )}
      </section>
    </div>
  );
}
