import { Check, X } from "lucide-react";
import { useState } from "react";
import type { Setup, SetupStep } from "../../api/types";
import { useChat } from "../../context";
import { KEYS, storage } from "../../lib/storage";

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* the user can copy by hand */
      }
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="btn quiet sm copy" onClick={copy}>
      {done && <Check size={14} />} {done ? "Скопійовано" : "Копіювати"}
    </button>
  );
}

/** Replaces <AICHAT_DIR> with the folder typed here; JSON needs forward slashes. */
export function withDir(text: string, dir: string) {
  const d = dir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return d ? text.split("<AICHAT_DIR>").join(d) : text;
}

/** Live connection state of the agent being set up: waiting until its first connection, then connected. */
function Connection({ name, human }: { name: string; human: boolean }) {
  const { overview } = useChat();
  const online = !!overview.agents.find((a) => a.name === name)?.online;
  return (
    <p className={`connection${online ? " on" : ""}`} role="status">
      {online ? (
        <>
          <Check size={16} /> {name} {human ? "увійшов" : "підключився"} і зараз онлайн.
        </>
      ) : (
        <>
          <span className="pulse" /> Чекаємо, поки {name} {human ? "увійде" : "підключиться"}…
        </>
      )}
    </p>
  );
}

function Steps({ steps, dir, start = 1 }: { steps: SetupStep[]; dir: string; start?: number }) {
  return (
    <ol className="steps" start={start}>
      {steps.map((s, i) => {
        const dl = s.download ?? (s.url ? { url: s.url } : null);
        const code = s.code ? withDir(s.code, dir) : "";
        return (
          <li key={i}>
            {s.title && <h3>{s.title}</h3>}
            {s.text && <p>{withDir(s.text, dir)}</p>}
            {dl?.url && (
              <a className="btn ghost sm" href={dl.url} download={dl.filename ?? dl.url.split("/").pop()} title={dl.url}>
                Завантажити {dl.filename ?? dl.url.split("/").pop()}
              </a>
            )}
            {code && (
              <div className="code">
                <div className="code-head">
                  <span className="code-lang">{s.lang ?? ""}</span>
                  <CopyButton text={code} />
                </div>
                <pre>
                  <code>{code}</code>
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function SetupBox({
  name,
  title,
  setup,
  fresh,
  onClose,
}: {
  name: string;
  title: string;
  setup: Setup;
  fresh: boolean;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(() => storage.get(KEYS.projectDir) ?? "");
  const quick = setup.steps.filter((s) => !s.manual);
  const manual = setup.steps.filter((s) => s.manual);
  const needsDir = manual.some((s) => `${s.code ?? ""}${s.text ?? ""}`.includes("<AICHAT_DIR>"));
  return (
    <section className="card setup">
      <div className="card-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Сховати" title="Сховати">
          <X size={16} />
        </button>
      </div>
      {fresh ? (
        <p className="warn">
          Токен показується <strong>лише один раз</strong>. Скопіюйте потрібне зараз і передайте тому, хто запускатиме агента.
        </p>
      ) : (
        <p className="muted small">Токен в інструкції замінено на &lt;TOKEN&gt;. Якщо токен загубився, натисніть «Новий токен».</p>
      )}
      <Connection name={name} human={setup.kind === "human"} />
      <Steps steps={quick} dir={dir} />
      {manual.length > 0 && (
        <details className="manual">
          <summary>Вручну, крок за кроком</summary>
          {needsDir && (
            <label className="field">
              <span>Папка адаптера на комп'ютері агента</span>
              <input
                value={dir}
                placeholder="C:/aichat"
                onChange={(e) => {
                  setDir(e.target.value);
                  storage.set(KEYS.projectDir, e.target.value.trim());
                }}
              />
              <small>Підставиться замість &lt;AICHAT_DIR&gt; у командах нижче.</small>
            </label>
          )}
          <Steps steps={manual} dir={dir} />
        </details>
      )}
    </section>
  );
}
