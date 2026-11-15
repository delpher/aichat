import { Check, Copy, Download, X } from "lucide-react";
import { useState } from "react";
import type { Setup } from "../../api/types";
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
    <button type="button" className="btn ghost sm copy" onClick={copy}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Скопійовано" : "Копіювати"}
    </button>
  );
}

/** Replaces <AICHAT_DIR> with the folder typed here; JSON needs forward slashes. */
export function withDir(text: string, dir: string) {
  const d = dir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return d ? text.split("<AICHAT_DIR>").join(d) : text;
}

export function SetupBox({ title, setup, fresh, onClose }: { title: string; setup: Setup; fresh: boolean; onClose: () => void }) {
  const [dir, setDir] = useState(() => storage.get(KEYS.projectDir) ?? "");
  const needsDir = setup.steps.some((s) => `${s.code ?? ""}${s.text ?? ""}`.includes("<AICHAT_DIR>"));
  return (
    <section className="card setup">
      <div className="card-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Сховати" title="Сховати">
          <X size={16} />
        </button>
      </div>
      {fresh && (
        <p className="warn">
          Токен показується <strong>лише один раз</strong>. Скопіюйте потрібне зараз і передайте тому, хто запускатиме агента.
        </p>
      )}
      {needsDir && (
        <label className="field">
          <span>Папка, куди ви покладете адаптер на комп'ютері агента (замість &lt;AICHAT_DIR&gt;)</span>
          <input
            value={dir}
            placeholder="C:/aichat"
            onChange={(e) => {
              setDir(e.target.value);
              storage.set(KEYS.projectDir, e.target.value.trim());
            }}
          />
        </label>
      )}
      <ol className="steps">
        {setup.steps.map((s, i) => {
          const dl = s.download ?? (s.url ? { url: s.url } : null);
          const code = s.code ? withDir(s.code, dir) : "";
          return (
            <li key={i}>
              {s.title && <h3>{s.title}</h3>}
              {s.text && <p>{withDir(s.text, dir)}</p>}
              {dl?.url && (
                <a className="btn ghost sm" href={dl.url} download={dl.filename ?? dl.url.split("/").pop()} title={dl.url}>
                  <Download size={14} /> Завантажити {dl.filename ?? dl.url.split("/").pop()}
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
    </section>
  );
}
