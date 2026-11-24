import { useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import type { Settings } from "../../api/types";
import { useChat } from "../../context";
import { fmtSize } from "../../lib/format";
import { CopyButton } from "./SetupBox";

interface ClientManifest {
  version?: string;
  files?: Record<string, { sha256?: string; size?: number }>;
}

const RUN_CMD = "%USERPROFILE%\\aichat-agents\\aichat-manager.cmd";

/** PowerShell one-liner that downloads to %TEMP%, checks SHA-256 against manifest.json, then installs and starts the manager. */
export function managerInstallCommand(brokerUrl: string): string {
  const b = brokerUrl.trim().replace(/\/+$/, "").replace(/'/g, "''");
  return `$b='${b}'; $d="$HOME\\aichat-agents\\.manager"; $t=Join-Path $env:TEMP 'aichat-manager.mjs'; curl.exe -fsSL -o $t "$b/client/aichat-manager.mjs"; if (!$?) { throw 'не вдалося завантажити менеджер' }; $m = curl.exe -fsSL "$b/client/manifest.json" | ConvertFrom-Json; if ((Get-FileHash $t -Algorithm SHA256).Hash -ne $m.files.'aichat-manager.mjs'.sha256) { Remove-Item $t; throw 'SHA-256 не збігається з manifest.json брокера' }; New-Item -ItemType Directory -Force $d | Out-Null; Move-Item -Force $t "$d\\aichat-manager.mjs"; node "$d\\aichat-manager.mjs" install --broker $b`;
}

/** Settings → Manager: how to install and run the local agent manager from this broker. */
export function ManagerBox() {
  const { api, overview, fail } = useChat();
  const [publicUrl, setPublicUrl] = useState("");
  const [manifest, setManifest] = useState<ClientManifest | null>(null);
  const [manifestError, setManifestError] = useState("");

  useEffect(() => {
    let live = true;
    api
      .get<{ settings: Settings }>("/admin/api/settings")
      .then((d) => {
        if (live && d.settings?.publicUrl) setPublicUrl(d.settings.publicUrl);
      })
      .catch((err) => {
        if (live && err instanceof AuthError) fail(err, "");
      });

    fetch("/client/manifest.json", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ClientManifest;
      })
      .then((d) => {
        if (live) {
          setManifest(d);
          setManifestError("");
        }
      })
      .catch((err) => {
        if (live) setManifestError((err as Error).message || "недоступно");
      });

    return () => {
      live = false;
    };
  }, [api, fail]);

  const rawBroker = (publicUrl.trim() || window.location.origin).replace(/\/+$/, "");
  const isHttp = rawBroker.toLowerCase().startsWith("http://");
  const version = manifest?.version || overview.version || "";
  const bundle = manifest?.files?.["aichat-manager.mjs"];
  const installCmd = managerInstallCommand(rawBroker);

  return (
    <section className="card" aria-label="Менеджер агентів">
      <div className="card-head">
        <h2>Менеджер агентів</h2>
        {version && <span className="muted small num">v{version}</span>}
      </div>
      <p>
        Локальна веб-панель для комп'ютера з агентами: показує статус і логи, дозволяє запускати, зупиняти й оновлювати адаптери та редагувати
        налаштування без клонування репозиторію.
      </p>
      <p className="muted small">
        Вимоги: <b>Windows</b> та <b>Node.js 22+</b> (один файл без <code>npm install</code> і без Git).
      </p>
      <p>
        Менеджер буде завантажено й запущено з <code>{rawBroker}</code>.
      </p>
      {isHttp && (
        <p className="warn">
          З'єднання через <code>http://</code> не захищене шифруванням — встановлюйте менеджер лише в довіреній локальній мережі. Перевірка SHA-256
          у команді нижче захищає від пошкодженого завантаження, але не від підміни джерела.
        </p>
      )}
      {manifestError && (
        <p className="muted small">
          Маніфест брокера (<code>/client/manifest.json</code>) зараз не відповідає ({manifestError}). Переконайтеся, що брокер оновлено до версії з
          підтримкою менеджера.
        </p>
      )}
      <ol className="steps">
        <li>
          <h3>Встановлення та перший запуск</h3>
          <p>
            Відкрийте PowerShell і виконайте команду. Вона завантажить <code>aichat-manager.mjs</code> у тимчасову теку, звірить SHA-256 із{" "}
            <code>manifest.json</code> брокера, перенесе файл у <code>%USERPROFILE%\aichat-agents\.manager\</code> та запустить менеджер.
          </p>
          <div className="code manager-code">
            <div className="code-head">
              <span className="code-lang">PowerShell</span>
              <CopyButton text={installCmd} />
            </div>
            <pre>
              <code>{installCmd}</code>
            </pre>
          </div>
          {bundle?.sha256 && (
            <p className="muted small num" style={{ marginTop: "var(--space-2)" }}>
              SHA-256: <code>{bundle.sha256}</code>
              {typeof bundle.size === "number" ? ` · ${fmtSize(bundle.size)}` : ""}
            </p>
          )}
        </li>
        <li>
          <h3>Як запускати надалі</h3>
          <p>
            Після встановлення поруч із теками агентів з'явиться ярлик запуску. Надалі менеджер сам перевіряє й встановлює власні оновлення зі своєї
            сторінки.
          </p>
          <div className="code manager-code">
            <div className="code-head">
              <span className="code-lang">Команда запуску</span>
              <CopyButton text={RUN_CMD} />
            </div>
            <pre>
              <code>{RUN_CMD}</code>
            </pre>
          </div>
        </li>
      </ol>
    </section>
  );
}
