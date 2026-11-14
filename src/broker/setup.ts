// Ready-to-copy steps for connecting a newly added agent, shown in the web UI.

export interface SetupStep {
  title: string;
  text?: string;
  code?: string;
  /** Hint for highlighting / labelling the code block: json, bash, powershell, text. */
  lang?: string;
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
  /** Folder of the AIChat project on the agent's machine; empty when unknown. */
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
    : [{ title: "Шлях до AIChat", text: `Замініть ${DIR_PLACEHOLDER} на папку AIChat на комп'ютері агента (там, де виконано npm install і npm run build). Щоб підставлявся сам, задайте projectDir у налаштуваннях.` }];

  if (c.kind === "claude") {
    const mcp = {
      mcpServers: {
        aichat: {
          command: "node",
          args: [`${dir}/dist/adapters/claude-channel.js`],
          env: { AICHAT_URL: ws, AICHAT_TOKEN: c.token },
        },
      },
    };
    return {
      kind: c.kind,
      steps: [
        ...dirNote,
        {
          title: "1. Створіть .mcp.json",
          text: `Покладіть цей файл у папку, де працюватиме Claude Code агента ${c.name} (у кожного агента своя папка й свій токен).`,
          code: JSON.stringify(mcp, null, 2),
          lang: "json",
        },
        {
          title: "2. Запустіть Claude Code з цієї папки",
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
        {
          title: "Запуск (bash)",
          text: "Для локальної моделі додайте OPENAI_BASE_URL, наприклад http://localhost:11434/v1 (Ollama).",
          code: [
            `cd ${sq(dir)}`,
            `AICHAT_URL=${sq(ws)} AICHAT_TOKEN=${sq(c.token)} \\`,
            `OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4.1 \\`,
            `AGENT_PROMPT="Ти ${c.name}, коротко відповідаєш у чаті" npm run openai-agent`,
          ].join("\n"),
          lang: "bash",
        },
        {
          title: "Запуск (PowerShell)",
          code: [
            `Set-Location ${psq(dir)}`,
            `$env:AICHAT_URL = ${psq(ws)}`,
            `$env:AICHAT_TOKEN = ${psq(c.token)}`,
            `$env:OPENAI_API_KEY = 'sk-...'`,
            `$env:OPENAI_MODEL = 'gpt-4.1'`,
            `$env:AGENT_PROMPT = ${psq(`Ти ${c.name}, коротко відповідаєш у чаті`)}`,
            "npm run openai-agent",
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
          title: "Або термінальний чат",
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
