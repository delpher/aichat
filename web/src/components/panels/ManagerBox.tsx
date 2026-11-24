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

export type ManagerOs = "windows" | "linux";

const RUN_CMD: Record<ManagerOs, string> = {
  windows: "%USERPROFILE%\\aichat-agents\\aichat-manager.cmd",
  linux: "~/aichat-agents/aichat-manager.sh",
};

/** One-liner that downloads to a temp file, checks SHA-256 against manifest.json, then installs and starts the manager. */
export function managerInstallCommand(brokerUrl: string, os: ManagerOs = "windows"): string {
  if (os === "linux") {
    const b = brokerUrl.trim().replace(/\/+$/, "").replace(/'/g, "'\\''");
    return `b='${b}'; d="$HOME/aichat-agents/.manager"; t="$(mktemp)"; curl -fsSL -o "$t" "$b/client/aichat-manager.mjs" && h="$(curl -fsSL "$b/client/manifest.json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).files["aichat-manager.mjs"].sha256))')" && [ "$(sha256sum "$t" | cut -d" " -f1)" = "$h" ] && mkdir -p "$d" && mv "$t" "$d/aichat-manager.mjs" && node "$d/aichat-manager.mjs" install --broker "$b" || { rm -f "$t"; echo "Встановлення не вдалося: файл не завантажився або SHA-256 не збігся"; }`;
  }
  const b = brokerUrl.trim().replace(/\/+$/, "").replace(/'/g, "''");
  return `$b='${b}'; $d="$HOME\\aichat-agents\\.manager"; $t=Join-Path $env:TEMP 'aichat-manager.mjs'; curl.exe -fsSL -o $t "$b/client/aichat-manager.mjs"; if (!$?) { throw 'не вдалося завантажити менеджер' }; $m = curl.exe -fsSL "$b/client/manifest.json" | ConvertFrom-Json; if ((Get-FileHash $t -Algorithm SHA256).Hash -ne $m.files.'aichat-manager.mjs'.sha256) { Remove-Item $t; throw 'SHA-256 не збігається з manifest.json брокера' }; New-Item -ItemType Directory -Force $d | Out-Null; Move-Item -Force $t "$d\\aichat-manager.mjs"; node "$d\\aichat-manager.mjs" install --broker $b`;
}

/** Settings → Manager: how to install and run the local agent manager from this broker. */
export function ManagerBox() {
  const { api, overview, fail } = useChat();
  const [os, setOs] = useState<ManagerOs>("windows");
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
  const installCmd = managerInstallCommand(rawBroker, os);
  const runCmd = RUN_CMD[os];

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
        Вимоги: <b>Windows</b> або <b>Linux</b> та <b>Node.js 22+</b> (один файл без <code>npm install</code> і без Git; на Linux для термінальних
        агентів потрібен <code>tmux</code>).
      </p>
      <p>
        Менеджер буде завантажено й запущено з <code>{rawBroker}</code>.
      </p>
      <div className="seg" role="tablist" aria-label="Операційна система" style={{ width: "fit-content", marginBottom: "var(--space-3)" }}>
        <button
          type="button"
          role="tab"
          aria-selected={os === "windows"}
          className={os === "windows" ? "on" : ""}
          onClick={() => setOs("windows")}
        >
          Windows (PowerShell)
        </button>
        <button type="button" role="tab" aria-selected={os === "linux"} className={os === "linux" ? "on" : ""} onClick={() => setOs("linux")}>
          Linux (bash)
        </button>
      </div>
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
          {os === "windows" ? (
            <p>
              Відкрийте PowerShell і виконайте команду. Вона завантажить <code>aichat-manager.mjs</code> у тимчасову теку, звірить SHA-256 із{" "}
              <code>manifest.json</code> брокера, перенесе файл у <code>%USERPROFILE%\aichat-agents\.manager\</code> та запустить менеджер.
            </p>
          ) : (
            <p>
              Відкрийте термінал (bash) і виконайте команду. Вона завантажить <code>aichat-manager.mjs</code> у тимчасовий файл, звірить SHA-256 із{" "}
              <code>manifest.json</code> брокера, перенесе файл у <code>~/aichat-agents/.manager/</code> та запустить менеджер.
            </p>
          )}
          <div className="code manager-code">
            <div className="code-head">
              <span className="code-lang">{os === "windows" ? "PowerShell" : "bash"}</span>
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
            Після встановлення поруч із теками агентів з'явиться скрипт запуску. Надалі менеджер сам перевіряє й встановлює власні оновлення зі своєї
            сторінки.
          </p>
          <div className="code manager-code">
            <div className="code-head">
              <span className="code-lang">Команда запуску</span>
              <CopyButton text={runCmd} />
            </div>
            <pre>
              <code>{runCmd}</code>
            </pre>
          </div>
        </li>
      </ol>
    </section>
  );
}
