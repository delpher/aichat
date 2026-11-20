// Ready-to-copy steps for connecting a newly added agent, shown in the web UI.

export interface SetupStep {
  title: string;
  text?: string;
  code?: string;
  /** Hint for highlighting / labelling the code block: json, bash, powershell, text. */
  lang?: string;
  /** A file to download in the browser (the bundled adapter). */
  download?: { url: string; filename: string };
  /** Part of the step-by-step way; the web UI folds these under "Вручну" below the one-command way. */
  manual?: boolean;
}

export interface Setup {
  kind: string;
  steps: SetupStep[];
}

export interface SetupContext {
  name: string;
  kind: string;
  /** The agent's token, or a placeholder when only showing the instructions again. */
  token: string;
  /** Base HTTP address of the broker as other machines see it, e.g. http://aichat.lan:8787 */
  httpUrl: string;
  /** Folder on the agent's machine where the adapter file is put; empty when unknown. */
  projectDir: string;
  webhook?: string;
  /** Who is adding the agent or looking at its instructions: the Codex channel takes tasks only from its owners. */
  owner?: string;
}

export const TOKEN_PLACEHOLDER = "<TOKEN>";
export const DIR_PLACEHOLDER = "<AICHAT_DIR>";

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Claude Code hooks that run aichat-hook.mjs on the events it reports (see src/adapters/aichat-hook.ts). */
export function hookSettings(hookPath: string) {
  const run = [{ type: "command", command: `node "${hookPath}"`, timeout: 5 }];
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: run }],
      PreToolUse: [{ matcher: "*", hooks: run }],
      Notification: [{ hooks: run }],
      Stop: [{ hooks: run }],
    },
  };
}

export function buildSetup(c: SetupContext): Setup {
  const http = c.httpUrl.replace(/\/+$/, "");
  const ws = http.replace(/^http/i, "ws");
  const dir = (c.projectDir || DIR_PLACEHOLDER).replace(/\\/g, "/").replace(/\/+$/, "");
  const dirNote: SetupStep[] = c.projectDir
    ? []
    : [
        {
          title: "Папка для адаптера",
          text: `Замініть ${DIR_PLACEHOLDER} на папку на комп'ютері агента, куди ви покладете файл адаптера. Щоб шлях підставлявся сам, задайте його в налаштуваннях (projectDir).`,
          manual: true,
        },
      ];
  // The one-command way puts the adapter in projectDir, or in ~/.aichat when that is not set.
  const quickDir = { bash: c.projectDir ? sq(dir) : `"$HOME/.aichat"`, ps: c.projectDir ? psq(dir) : `"$HOME\\.aichat"` };
  const quickFile = (file: string) => ({
    bash: c.projectDir ? sq(`${dir}/${file}`) : `"$HOME/.aichat/${file}"`,
    ps: c.projectDir ? psq(`${dir}/${file}`) : `"$HOME\\.aichat\\${file}"`,
  });
  /** Shell lines that download one adapter file into the folder. */
  const getFile = (file: string) => ({
    bash: `curl -fsSL ${http}/client/${file} -o ${quickFile(file).bash}`,
    ps: `Invoke-WebRequest ${http}/client/${file} -OutFile ${quickFile(file).ps}`,
  });
  /** Shell lines that create the folder and download one adapter file into it. */
  const fetchFile = (file: string) => ({
    bash: `mkdir -p ${quickDir.bash} && ${getFile(file).bash}`,
    ps: `New-Item -ItemType Directory -Force ${quickDir.ps} | Out-Null; ${getFile(file).ps}`,
  });
  const download = (file: string): SetupStep => ({
    manual: true,
    title: `Завантажте адаптер ${file}`,
    text: `Покладіть файл у ${dir}. Потрібен лише Node.js 22 або новіший; копія проєкту AIChat і npm install не потрібні.`,
    code: [
      `# bash`,
      `curl -o ${sq(`${dir}/${file}`)} ${http}/client/${file}`,
      `# PowerShell`,
      `Invoke-WebRequest ${http}/client/${file} -OutFile ${psq(`${dir}/${file}`)}`,
    ].join("\n"),
    lang: "text",
    download: { url: `${http}/client/${file}`, filename: file },
  });

  if (c.kind === "claude") {
    const mcp = {
      mcpServers: {
        aichat: {
          command: "node",
          args: [`${dir}/claude-channel.mjs`],
          env: { AICHAT_URL: ws, AICHAT_TOKEN: c.token },
        },
      },
    };
    const install = `install --url ${sq(ws)} --token ${sq(c.token)} --statusline`;
    const installPs = `install --url ${psq(ws)} --token ${psq(c.token)} --statusline`;
    const f = fetchFile("claude-channel.mjs");
    // the hook goes next to the adapter, where `install` finds it and registers it in .claude/settings.local.json
    const hookBash = getFile("aichat-hook.mjs").bash;
    const hookPs = getFile("aichat-hook.mjs").ps;
    return {
      kind: c.kind,
      steps: [
        {
          title: "Підключіть однією командою",
          text: `Виконайте в папці, де працюватиме Claude Code агента ${c.name}. Команда завантажить адаптер і хук статусу, створить .mcp.json (або допише сервер aichat до наявного) і .claude/settings.local.json з хуками, щоб у чаті було видно, що агент робить, і з рядком статусу, з якого AIChat бачить використання акаунту (ліміти, контекст, витрати сесії). Якщо у вас уже є свій рядок статусу, він лишається: дані передаються йому далі. Без рядка статусу приберіть --statusline. Потрібен лише Node.js 22 або новіший.`,
          code: `${f.bash} && ${hookBash} && node ${quickFile("claude-channel.mjs").bash} ${install}`,
          lang: "bash",
        },
        {
          title: "Те саме в PowerShell (Windows)",
          code: `${f.ps}; ${hookPs}; node ${quickFile("claude-channel.mjs").ps} ${installPs}`,
          lang: "powershell",
        },
        {
          title: "Запустіть Claude Code з тієї ж папки",
          text: "Підтвердьте попередження про development channels і запит на MCP-сервер aichat. Щойно агент підключиться, тут з'явиться позначка.",
          code: "claude --dangerously-load-development-channels server:aichat",
          lang: "bash",
        },
        ...dirNote,
        download("claude-channel.mjs"),
        {
          manual: true,
          title: "Створіть .mcp.json",
          text: `Покладіть цей файл у папку, де працюватиме Claude Code агента ${c.name} (у кожного агента своя папка й свій токен).`,
          code: JSON.stringify(mcp, null, 2),
          lang: "json",
        },
        download("aichat-hook.mjs"),
        {
          manual: true,
          title: "Статус агента: створіть .claude/settings.local.json",
          text:
            "Необов'язково, але тоді в чаті видно, що агент працює (і над чим) або чекає дозволу. " +
            "Покладіть файл у підпапку .claude тієї ж папки; адресу й токен хук бере з .mcp.json.",
          code: JSON.stringify(hookSettings(`${dir}/aichat-hook.mjs`), null, 2),
          lang: "json",
        },
        {
          manual: true,
          title: "Використання акаунту: рядок статусу",
          text:
            "Необов'язково, але тоді власник акаунту бачить у вебі ліміти, контекст і витрати агента. Допишіть statusLine до того ж .claude/settings.local.json. " +
            "Якщо у вас уже є свій рядок статусу, замініть --line на | і вашу команду: хук передасть їй дані далі.",
          code: JSON.stringify({ statusLine: { type: "command", command: `node "${dir}/aichat-hook.mjs" statusline --line` } }, null, 2),
          lang: "json",
        },
      ],
    };
  }

  if (c.kind === "openai") {
    const f = fetchFile("openai-agent.mjs");
    return {
      kind: c.kind,
      steps: [
        {
          title: "Завантажте й запустіть однією командою (bash)",
          text: "Впишіть свій OPENAI_API_KEY і модель. Для локальної моделі додайте OPENAI_BASE_URL, наприклад http://localhost:11434/v1 (Ollama). Щойно агент підключиться, тут з'явиться позначка.",
          code: [
            `${f.bash} && \\`,
            `AICHAT_URL=${sq(ws)} AICHAT_TOKEN=${sq(c.token)} \\`,
            `OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4.1 \\`,
            `AGENT_PROMPT="Ти ${c.name}, коротко відповідаєш у чаті" node ${quickFile("openai-agent.mjs").bash}`,
          ].join("\n"),
          lang: "bash",
        },
        {
          title: "Те саме в PowerShell (Windows)",
          code: [
            f.ps,
            `$env:AICHAT_URL = ${psq(ws)}`,
            `$env:AICHAT_TOKEN = ${psq(c.token)}`,
            `$env:OPENAI_API_KEY = 'sk-...'`,
            `$env:OPENAI_MODEL = 'gpt-4.1'`,
            `$env:AGENT_PROMPT = ${psq(`Ти ${c.name}, коротко відповідаєш у чаті`)}`,
            `node ${quickFile("openai-agent.mjs").ps}`,
          ].join("\n"),
          lang: "powershell",
        },
        ...dirNote,
        download("openai-agent.mjs"),
      ],
    };
  }

  if (c.kind === "opencode") {
    // OpenCode loads plugins from .opencode/plugins/ of the folder it runs in; the plugin reads aichat.config.json
    // from that folder and the token from tokenFile, so the token stays out of the project folder.
    const plugin = ".opencode/plugins/aichat-channel/index.js";
    const tokenFile = `~/.secrets/aichat-${c.name}-token`;
    const config = { url: `${ws}/ws`, tokenFile, wake: "always", paused: true };
    return {
      kind: c.kind,
      steps: [
        {
          title: "Завантажте плагін",
          text: `Виконайте в папці, де працюватиме OpenCode агента ${c.name}. Потрібен OpenCode 2.3.2 або новіший (API плагінів V2); копія проєкту AIChat і npm install не потрібні.`,
          code: `mkdir -p .opencode/plugins/aichat-channel && curl -fsSL ${http}/client/opencode-channel.js -o ${plugin}`,
          lang: "bash",
        },
        {
          title: "Те саме в PowerShell (Windows)",
          code: `New-Item -ItemType Directory -Force .opencode/plugins/aichat-channel | Out-Null; Invoke-WebRequest ${http}/client/opencode-channel.js -OutFile ${plugin}`,
          lang: "powershell",
        },
        {
          title: "Збережіть токен у файл поза папкою агента",
          text: "Так токен не потрапить у git і в чат. Плагін бере його звідти сам.",
          code: [
            `# bash`,
            `mkdir -p ~/.secrets && printf '%s' ${sq(c.token)} > ${tokenFile} && chmod 600 ${tokenFile}`,
            `# PowerShell`,
            `New-Item -ItemType Directory -Force "$HOME\\.secrets" | Out-Null; Set-Content -NoNewline -Path "$HOME\\.secrets\\aichat-${c.name}-token" -Value ${psq(c.token)}`,
          ].join("\n"),
          lang: "text",
        },
        {
          title: "Створіть aichat.config.json у тій самій папці",
          text: `wake: "always" будить модель на кожне повідомлення, "mention" лише коли в тексті є ім'я агента (воно є й у вітанні брокера на новій сесії), "never" кладе їх у сесію без ходу моделі. Необов'язково: rooms — кімнати, куди вступати при кожному підключенні, наприклад ["lobby"] (кімнати, які дав адмін, і так будуть). "paused": true вимикає підключення до брокера, тули лишаються; з нього безпечно почати.`,
          code: JSON.stringify(config, null, 2),
          lang: "json",
        },
        {
          title: "Запустіть OpenCode з тієї ж папки",
          text: "Якщо OpenCode вже працює, виконайте opencode reload. Поки стоїть paused: true, плагін завантажиться й створить окрему сесію AIChat, але до брокера не підключиться: так безпечно перевірити, що все на місці.",
          code: "opencode",
          lang: "bash",
        },
        {
          title: "Увімкніть підключення",
          text: "Поставте в aichat.config.json \"paused\": false і виконайте opencode reload. Вхідні складатимуться в сесію AIChat. Щойно агент підключиться, тут з'явиться позначка.",
          code: "opencode reload",
          lang: "bash",
        },
      ],
    };
  }

  if (c.kind === "antigravity") {
    // agy-channel.mjs runs `agy acp` with its own profile (--app-data-dir, a folder under ~/.gemini), outside the
    // agent's folder, so the agent's login and history stay apart from the person's Antigravity.
    const agentDir = `$HOME\\aichat-agents\\${c.name}`;
    const profile = `antigravity-aichat-${c.name}`;
    const tokenFile = `$HOME\\.secrets\\aichat-${c.name}-token`;
    const owner = c.owner || "<OWNER>";
    return {
      kind: c.kind,
      steps: [
        {
          title: "Збережіть токен у файл поза папкою агента",
          text: "Так токен не потрапить у git і в чат. Адаптер бере його звідти сам.",
          code: `New-Item -ItemType Directory -Force "$HOME\\.secrets" | Out-Null; Set-Content -NoNewline -Path "${tokenFile}" -Value ${psq(c.token)}`,
          lang: "powershell",
        },
        {
          title: "Завантажте й встановіть адаптер",
          text: `Потрібні Node.js 22 або новіший і Antigravity CLI (agy); копія проєкту AIChat не потрібна. Папка агента — ${agentDir}, окремий профіль Antigravity (своя історія розмов) — ~\\.gemini\\${profile}, поза нею. Завдання агент братиме лише від власників (--owners, через кому), решта учасників для нього — співрозмовники. --approve-aichat-tools дозволяє йому без питань користуватися лише інструментами AIChat; решту дозволів адаптер відхиляє. Наявних файлів установник не перезаписує.`,
          code: [
            `Invoke-WebRequest ${http}/client/agy-channel.mjs -OutFile "$env:TEMP\\agy-channel.mjs"`,
            `node "$env:TEMP\\agy-channel.mjs" install --dir "${agentDir}" --profile ${profile} --token-file "${tokenFile}" --url ${psq(http)} --owners ${psq(owner)} --rooms lobby --approve-aichat-tools`,
          ].join("\n"),
          lang: "powershell",
        },
        {
          title: "Увійдіть в Antigravity, якщо ще не входили",
          text: "Вхід Google спільний для всіх профілів Antigravity на цьому комп'ютері. Якщо agy тут уже працює, крок можна пропустити; інакше увійдіть один раз.",
          code: `agy acp --app-data-dir ${profile} --login`,
          lang: "powershell",
        },
        {
          title: "Перевірте, не підключаючись",
          text: "probe перевіряє вхід, інструменти AIChat і розмову агента, але до брокера не підключається.",
          code: `Set-Location "${agentDir}"; node .\\agy-channel.mjs probe --config .\\aichat.config.json`,
          lang: "powershell",
        },
        {
          title: "Увімкніть підключення",
          text: `Поставте в ${agentDir}\\aichat.config.json "paused": false і запустіть адаптер. Зупинка — .\\stop.ps1, стан — node .\\agy-channel.mjs status --config .\\aichat.config.json. Після фатальної помилки адаптер завершується, і його треба запустити знову. Щойно агент підключиться, тут з'явиться позначка.`,
          code: `Set-Location "${agentDir}"; .\\start.ps1`,
          lang: "powershell",
        },
      ],
    };
  }

  if (c.kind === "codex") {
    // codex-channel.mjs runs Codex App Server in a separate CODEX_HOME, outside the agent's folder, so the agent's own
    // login and history stay apart from the person's Codex and file_send can never reach them.
    const agentDir = `$HOME\\aichat-agents\\${c.name}`;
    const codexHome = `$HOME\\.codex-aichat-${c.name}`;
    const tokenFile = `$HOME\\.secrets\\aichat-${c.name}-token`;
    const owner = c.owner || "<OWNER>";
    return {
      kind: c.kind,
      steps: [
        {
          title: "Збережіть токен у файл поза папкою агента",
          text: "Так токен не потрапить у git і в чат. Адаптер бере його звідти сам.",
          code: `New-Item -ItemType Directory -Force "$HOME\\.secrets" | Out-Null; Set-Content -NoNewline -Path "${tokenFile}" -Value ${psq(c.token)}`,
          lang: "powershell",
        },
        {
          title: "Завантажте й встановіть адаптер",
          text: `Потрібні Node.js 22 або новіший і Codex CLI 0.169 або новіший; копія проєкту AIChat не потрібна. Папка агента — ${agentDir}, окремий профіль Codex (свій вхід, налаштування й історія) — ${codexHome}, поза нею. Завдання агент братиме лише від власників (--owners, через кому), решта учасників для нього — співрозмовники. --approve-aichat-tools дозволяє йому без питань користуватися лише інструментами AIChat; команди й далі обмежені його папкою. Наявних файлів установник не перезаписує.`,
          code: [
            `Invoke-WebRequest ${http}/client/codex-channel.mjs -OutFile "$env:TEMP\\codex-channel.mjs"`,
            `node "$env:TEMP\\codex-channel.mjs" install --dir "${agentDir}" --home "${codexHome}" --token-file "${tokenFile}" --url ${psq(http)} --owners ${psq(owner)} --rooms lobby --approve-aichat-tools`,
          ].join("\n"),
          lang: "powershell",
        },
        {
          title: "Увійдіть у Codex для цього профілю",
          text: "Один раз, у тому самому вікні PowerShell. Вхід зберігається в профілі агента, а не у вашому.",
          code: `$env:CODEX_HOME = "${codexHome}"; codex login`,
          lang: "powershell",
        },
        {
          title: "Перевірте, не підключаючись",
          text: "probe перевіряє вхід, інструменти AIChat і розмову агента, але до брокера не підключається.",
          code: `Set-Location "${agentDir}"; node .\\codex-channel.mjs probe --config .\\aichat.config.json`,
          lang: "powershell",
        },
        {
          title: "Увімкніть підключення",
          text: `Поставте в ${agentDir}\\aichat.config.json "paused": false і запустіть адаптер. Зупинка — .\\stop.ps1, стан — node .\\codex-channel.mjs status --config .\\aichat.config.json. Після фатальної помилки адаптер завершується, і його треба запустити знову. Щойно агент підключиться, тут з'явиться позначка.`,
          code: `Set-Location "${agentDir}"; .\\start.ps1`,
          lang: "powershell",
        },
      ],
    };
  }

  if (c.kind === "human") {
    return {
      kind: c.kind,
      steps: [
        {
          title: "Вебінтерфейс",
          text: `Передайте людині адресу і токен. Вона відкриває адресу й вводить токен у полі входу.`,
          code: `${http}/\n${c.token}`,
          lang: "text",
        },
        {
          title: "Або термінальний чат (з копії проєкту AIChat)",
          code: `npm run chat -- --url ${ws} --token ${c.token}`,
          lang: "bash",
        },
      ],
    };
  }

  return {
    kind: c.kind,
    steps: [
      {
        title: c.webhook ? "Вхідні повідомлення приходять на webhook" : "Отримувати повідомлення",
        text: c.webhook
          ? `Брокер надсилає кожне повідомлення POST-запитом на ${c.webhook} з тілом {"type":"message","message":{...}} і заголовком Authorization: Bearer <токен агента>.`
          : "Опитуйте вхідні (після читання вони позначаються доставленими) або підключіться по WebSocket до /ws.",
        ...(c.webhook ? {} : { code: `curl -H "Authorization: Bearer ${c.token}" ${http}/api/inbox`, lang: "bash" }),
      },
      {
        title: "Надіслати повідомлення",
        code: `curl -X POST -H "Authorization: Bearer ${c.token}" -H "content-type: application/json" \\\n  -d '{"room":"lobby","text":"Привіт"}' ${http}/api/messages`,
        lang: "bash",
      },
    ],
  };
}
