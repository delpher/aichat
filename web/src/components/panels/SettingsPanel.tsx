import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import type { Settings } from "../../api/types";
import { useChat } from "../../context";
import { ListSkeleton } from "../Skeleton";
import { Status, type StatusValue } from "./Status";
import { UpdateBox } from "./UpdateBox";
import { IntroSettings } from "./IntroPanel";

type Limits = Partial<Record<keyof Settings, { min: number; max: number }>>;

const NUMBER_FIELDS: { name: keyof Settings; label: string; help: string }[] = [
  {
    name: "maxHops",
    label: "Довжина ланцюжка відповідей",
    help: "Після стількох відповідей поспіль брокер зупиняє ланцюжок, щоб агенти не відповідали один одному вічно.",
  },
  { name: "ratePerMinute", label: "Повідомлень на хвилину", help: "Від одного учасника. Решту брокер відхиляє." },
  { name: "maxTextLength", label: "Довжина повідомлення, символів", help: "Довші повідомлення брокер відхиляє." },
  { name: "maxFileSizeMB", label: "Розмір файлу, МБ", help: "Більші файли брокер відхиляє." },
  { name: "maxNotes", label: "Записів у нотатнику агента", help: "Понад це агент нових записів не додасть." },
  { name: "maxNoteLength", label: "Довжина запису в нотатнику, символів", help: "Довші записи брокер відхиляє." },
];

const WAKE_FIELDS: { name: keyof Settings; label: string; help: string }[] = [
  { name: "wakeAfterMinutes", label: "Пробудження: відсутність, хвилин", help: "Агент, якого не було стільки, прокидається." },
  {
    name: "wakeAfterMessages",
    label: "Пробудження: пропущено повідомлень",
    help: "Або стільки пропущених повідомлень у кімнатах, навіть після короткої відсутності.",
  },
];

const TEXT_FIELDS: { name: keyof Settings; label: string; help: string; placeholder: string }[] = [
  {
    name: "publicUrl",
    label: "Публічна адреса брокера",
    help: "Як до брокера звертаються інші комп'ютери. Порожньо: адреса цієї сторінки.",
    placeholder: "http://aichat.home.arpa:8787",
  },
  {
    name: "projectDir",
    label: "Папка для адаптера на комп'ютері агента",
    help: "Куди кладуть claude-channel.mjs. Підставляється в .mcp.json; порожньо: <AICHAT_DIR>.",
    placeholder: "C:/aichat",
  },
];
const ALL = [...NUMBER_FIELDS, ...WAKE_FIELDS, ...TEXT_FIELDS].map((f) => f.name).concat("wakeMode");

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
      .catch((err) =>
        err instanceof AuthError ? fail(err, "") : setStatus({ text: `Не вдалося завантажити: ${err.message}`, error: true }),
      )
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [api, fail]);

  const check = (name: keyof Settings): { value?: string | number; error?: string } => {
    const raw = (form[name] ?? "").trim();
    if (name === "wakeMode") return raw === "on" || raw === "off" ? { value: raw } : { error: "on або off" };
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
        <ListSkeleton rows={4} avatar={false} label="Завантаження налаштувань" />
      </div>
    );
  const dirty = !!saved && ALL.some((k) => (form[k] ?? "").trim() !== String(saved[k] ?? ""));
  return (
    <div className="panel">
      <form
        className="section settings"
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
              <label key={name} className={`field${f.changed ? " changed" : ""}${f.bad ? " bad" : ""}`} title={`${name} в agents.json`}>
                <span>{label}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label={label}
                  value={form[name] ?? ""}
                  min={lim?.min}
                  max={lim?.max}
                  readOnly={!editable || busy}
                  onChange={(e) => setForm({ ...form, [name]: e.target.value })}
                />
                <small>
                  {f.bad ? <span className="field-error">{f.error}</span> : help}
                  {lim && !f.bad ? (
                    <span className="num">
                      {" "}
                      Від {lim.min} до {lim.max}.
                    </span>
                  ) : (
                    ""
                  )}
                </small>
              </label>
            );
          })}
        </div>
        <h2>Пробудження агентів</h2>
        <label className={`field${field("wakeMode").changed ? " changed" : ""}`} title="wakeMode в agents.json">
          <span>Режим пробудження</span>
          <select
            aria-label="Режим пробудження"
            value={form.wakeMode ?? "off"}
            disabled={!editable || busy}
            onChange={(e) => setForm({ ...form, wakeMode: e.target.value })}
          >
            <option value="off">Вимкнено: агент отримує всі пропущені повідомлення</option>
            <option value="on">Увімкнено: пропущене в кімнатах не надсилається, а йде в пробудження</option>
          </select>
          <small>Особисті повідомлення й ходи в партіях доходять завжди. Людей це не стосується.</small>
        </label>
        <div className="settings-grid">
          {WAKE_FIELDS.map(({ name, label, help }) => {
            const f = field(name);
            const lim = limits[name];
            return (
              <label key={name} className={`field${f.changed ? " changed" : ""}${f.bad ? " bad" : ""}`} title={`${name} в agents.json`}>
                <span>{label}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label={label}
                  value={form[name] ?? ""}
                  min={lim?.min}
                  max={lim?.max}
                  readOnly={!editable || busy}
                  onChange={(e) => setForm({ ...form, [name]: e.target.value })}
                />
                <small>
                  {f.bad ? <span className="field-error">{f.error}</span> : help}
                  {lim && !f.bad ? (
                    <span className="num">
                      {" "}
                      Від {lim.min} до {lim.max}.
                    </span>
                  ) : (
                    ""
                  )}
                </small>
              </label>
            );
          })}
        </div>
        <h2>Адреси</h2>
        {TEXT_FIELDS.map(({ name, label, help, placeholder }) => {
          const f = field(name);
          return (
            <label key={name} className={`field${f.changed ? " changed" : ""}${f.bad ? " bad" : ""}`} title={`${name} в agents.json`}>
              <span>{label}</span>
              <input
                value={form[name] ?? ""}
                placeholder={placeholder}
                readOnly={!editable || busy}
                onChange={(e) => setForm({ ...form, [name]: e.target.value })}
              />
              <small>{f.bad ? <span className="field-error">{f.error}</span> : help}</small>
            </label>
          );
        })}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!editable || busy || !dirty}>
            {busy && <LoaderCircle className="spin" size={16} />} Зберегти
          </button>
          {dirty && (
            <button type="button" className="btn quiet" disabled={!editable || busy} onClick={() => saved && fill(saved)}>
              Скасувати зміни
            </button>
          )}
          <Status value={status} />
        </div>
      </form>
      <IntroSettings />
      <UpdateBox />
    </div>
  );
}
