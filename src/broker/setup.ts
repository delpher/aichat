// Ready-to-copy steps for connecting a newly added agent, shown in the web UI.

export interface SetupStep {
  title: string;
  text?: string;
  code?: string;
  /** Hint for highlighting / labelling the code block: json, bash, powershell, text. */
  lang?: string;
  /** A file to download in the browser (the bundled adapter). */
  download?: { url: string; filename: string };
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
}

export const TOKEN_PLACEHOLDER = "<TOKEN>";
export const DIR_PLACEHOLDER = "<AICHAT_DIR>";

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function buildSetup(c: SetupContext): Setup {
  const http = c.httpUrl.replace(/\/+$/, "");
  const ws = http.replace(/^http/i, "ws");
  const dir = (c.projectDir || DIR_PLACEHOLDER).replace(/\\/g, "/").replace(/\/+$/, "");
  const dirNote = c.projectDir
    ? []
    : [{ title: "Папка для адаптера", text: `Замініть ${DIR_PLACEHOLDER} на папку на комп'ютері агента, куди ви покладете файл адаптера. Щоб шлях підставлявся сам, задайте його в налаштуваннях (projectDir).` }];
  const download = (file: string): SetupStep => ({
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
    return {
      kind: c.kind,
      steps: [
        ...dirNote,
        download("claude-channel.mjs"),
        {
          title: "Створіть .mcp.json",
          text: `Покладіть цей файл у папку, де працюватиме Claude Code агента ${c.name} (у кожного агента своя папка й свій токен).`,
          code: JSON.stringify(mcp, null, 2),
          lang: "json",
        },
        {
          title: "Запустіть Claude Code з папки, де лежить .mcp.json",
          text: "Підтвердьте попередження про development channels і запит на MCP-сервер aichat.",
          code: "claude --dangerously-load-development-channels server:aichat",
          lang: "bash",
        },
      ],
    };
  }

  if (c.kind === "openai") {
    return {
      kind: c.kind,
      steps: [
        ...dirNote,
        download("openai-agent.mjs"),
        {
          title: "Запуск (bash)",
          text: "Для локальної моделі додайте OPENAI_BASE_URL, наприклад http://localhost:11434/v1 (Ollama).",
          code: [
            `AICHAT_URL=${sq(ws)} AICHAT_TOKEN=${sq(c.token)} \\`,
            `OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4.1 \\`,
            `AGENT_PROMPT="Ти ${c.name}, коротко відповідаєш у чаті" node ${sq(`${dir}/openai-agent.mjs`)}`,
          ].join("\n"),
          lang: "bash",
        },
        {
          title: "Запуск (PowerShell)",
          code: [
            `$env:AICHAT_URL = ${psq(ws)}`,
            `$env:AICHAT_TOKEN = ${psq(c.token)}`,
            `$env:OPENAI_API_KEY = 'sk-...'`,
            `$env:OPENAI_MODEL = 'gpt-4.1'`,
            `$env:AGENT_PROMPT = ${psq(`Ти ${c.name}, коротко відповідаєш у чаті`)}`,
            `node ${psq(`${dir}/openai-agent.mjs`)}`,
          ].join("\n"),
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
