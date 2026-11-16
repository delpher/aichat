import { LoaderCircle, Save, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import type { Settings } from "../../api/types";
import { useChat } from "../../context";
import { Status, type StatusValue } from "./Status";
import { UpdateBox } from "./UpdateBox";

type Limits = Partial<Record<keyof Settings, { min: number; max: number }>>;

const NUMBER_FIELDS: { name: keyof Settings; label: string; help: string }[] = [
  {
    name: "maxHops",
    label: "Максимальна довжина ланцюжка відповідей",
    help: "Кожна відповідь з reply_to збільшує лічильник hops. Коли він досягає цього значення, брокер відхиляє наступну відповідь, щоб агенти не відповідали один одному вічно.",
  },
  { name: "ratePerMinute", label: "Повідомлень за хвилину від одного учасника", help: "Повідомлення понад цей ліміт брокер відхиляє." },
  { name: "maxTextLength", label: "Максимальна довжина повідомлення, символів", help: "Довші повідомлення брокер не приймає." },
  { name: "maxFileSizeMB", label: "Максимальний розмір файлу, МБ", help: "Більші файли брокер не приймає. Файли зберігаються в data/files поруч із базою." },
];

const TEXT_FIELDS: { name: keyof Settings; label: string; help: string; placeholder: string }[] = [
  {
    name: "publicUrl",
    label: "Публічна адреса брокера",
    help: "Адреса, за якою брокер доступний з інших комп'ютерів. Її підставляють у команди запуску агентів. Якщо поле порожнє, береться адреса цієї сторінки.",
    placeholder: "http://aichat.home.arpa:8787",
  },
  {
    name: "projectDir",
    label: "Папка для адаптера на комп'ютері агента",
    help: "Куди на комп'ютері агента кладуть завантажений адаптер (claude-channel.mjs). Шлях підставляється в .mcp.json. Якщо поле порожнє, в інструкції буде <AICHAT_DIR>.",
    placeholder: "C:/aichat",
  },
];
const ALL = [...NUMBER_FIELDS, ...TEXT_FIELDS].map((f) => f.name);

export function SettingsPanel() {
  const { api, fail } = useChat();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Limits>({});
  const [editable, setEditable] = useState(true);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<StatusValue>(null);

  const fill = (s: Settings) => {
    setSaved(s);
    setForm(Object.fromEntries(ALL.map((k) => [k, String(s[k] ?? "")])));
  };

  useEffect(() => {
    let live = true;
    api
      .get<{ settings: Settings; limits: Limits; editable: boolean }>("/admin/api/settings")
      .then((d) => {
        if (!live) return;
        setLimits(d.limits ?? {});
        setEditable(d.editable !== false);
        fill(d.settings);
        if (d.editable === false) setStatus({ text: "Брокер запущено без файлу конфігурації, тому налаштування лише для читання." });
      })
      .catch((err) => (err instanceof AuthError ? fail(err, "") : setStatus({ text: `Не вдалося завантажити: ${err.message}`, error: true })))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [api, fail]);

  const check = (name: keyof Settings): { value?: string | number; error?: string } => {
    const raw = (form[name] ?? "").trim();
    if (name === "publicUrl" || name === "projectDir") {
      if (name === "publicUrl" && raw && !/^https?:\/\/[^\s/]+/.test(raw)) return { error: "адреса має починатися з http:// або https://" };
      return { value: raw };
    }
    if (!/^-?\d+$/.test(raw)) return { error: "потрібне ціле число" };
    const n = Number(raw);
    const lim = limits[name];
    if (lim && (n < lim.min || n > lim.max)) return { error: `від ${lim.min} до ${lim.max}` };
    return { value: n };
  };

  const save = async () => {
    if (!saved) return;
    const patch: Record<string, string | number> = {};
    for (const name of ALL) {
      const r = check(name);
      if (r.error) {
        setStatus({ text: "Виправте позначені поля.", error: true });
        return;
      }
      if (String(r.value) !== String(saved[name] ?? "")) patch[name] = r.value!;
    }
    if (!Object.keys(patch).length) {
      setStatus({ text: "Змін немає." });
      return;
    }
    setBusy(true);
    try {
      const d = await api.send<{ settings: Settings }>("PATCH", "/admin/api/settings", patch);
      fill(d.settings);
      setStatus({ text: "Збережено. Зміни вже діють.", ok: true });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Не збережено: ${(err as Error).message}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const field = (name: keyof Settings) => {
    const r = check(name);
    const changed = saved && (form[name] ?? "").trim() !== String(saved[name] ?? "");
    return { bad: !!r.error && (form[name] ?? "") !== "", error: r.error, changed };
  };

  if (!saved && busy)
    return (
      <div className="panel">
        <LoaderCircle className="spin" />
      </div>
    );
  return (
    <div className="panel">
      <form
        className="card settings"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>Ліміти</h2>
        <div className="settings-grid">
          {NUMBER_FIELDS.map(({ name, label, help }) => {
            const f = field(name);
            const lim = limits[name];
            return (
              <label key={name} className={`field${f.changed ? " changed" : ""}${f.bad ? " bad" : ""}`}>
                <span>
                  {label} <code>{name}</code>
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={form[name] ?? ""}
                  min={lim?.min}
                  max={lim?.max}
                  readOnly={!editable || busy}
                  onChange={(e) => setForm({ ...form, [name]: e.target.value })}
                />
                <small>
                  {help}
                  {lim ? ` Допустимо: ${lim.min}–${lim.max}.` : ""}
                  {f.bad && <b className="field-error"> {f.error}</b>}
                </small>
              </label>
            );
          })}
        </div>
        <h2>Адреси</h2>
        {TEXT_FIELDS.map(({ name, label, help, placeholder }) => {
          const f = field(name);
          return (
            <label key={name} className={`field${f.changed ? " changed" : ""}${f.bad ? " bad" : ""}`}>
              <span>
                {label} <code>{name}</code>
              </span>
              <input
                value={form[name] ?? ""}
                placeholder={placeholder}
                readOnly={!editable || busy}
                onChange={(e) => setForm({ ...form, [name]: e.target.value })}
              />
              <small>
                {help}
                {f.bad && <b className="field-error"> {f.error}</b>}
              </small>
            </label>
          );
        })}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!editable || busy}>
            <Save size={16} /> Зберегти
          </button>
          <button type="button" className="btn ghost" disabled={!editable || busy} onClick={() => saved && fill(saved)}>
            <Undo2 size={16} /> Скасувати зміни
          </button>
          <Status value={status} />
        </div>
        <p className="muted small">Зміни записуються в agents.json і діють одразу, без перезапуску брокера.</p>
      </form>
      <UpdateBox />
    </div>
  );
}
