// AIChat для OpenCode: один файл — і прийом повідомлень, і тули для відправки.
//
// Чому плагін, а не MCP-адаптер зі сторінки agents.md. Адаптер пушить вхідні як
// Claude-специфічні channel-нотифікації (`notifications/claude/channel`), яких
// OpenCode не показує — але брокер вважає їх доставленими, тож повідомлення просто
// губляться. Плагін кладе їх прямо в сесію через ctx.session.prompt(), тому вони
// з'являються в чаті сесії й будять модель.
//
// Що робить:
//   * тримає одне WebSocket-з'єднання з брокером, авторизується токеном,
//     перепідключається з backoff; close 4003 (токен відкинуто) не повторює;
//   * вхідні `message` кладе в ОКРЕМУ сесію (id тримає в ctx.storage, назва з
//     конфігу), після успішної ін'єкції відповідає {"type":"delivered","id":...};
//   * the plugin's own tools are the two local file ones (upload_file / get_attachment);
//     the server tools (send_message, read_history, ...) come from the broker's /mcp;
//     the broker's HTTP API stays for what the socket cannot push.
//
// Налаштування (перше знайдене переважає): options плагіна → aichat.config.json у
// теці профілю → типові значення. Токен — з ~/.secrets/aichat-token або AICHAT_TOKEN
// (у файлі й у конфізі він не лежить).
//
// Підключення: файл у <профіль>/.opencode/plugins/ — OpenCode вантажить звідти сам.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { readUpload, saveDownload } from "./core/files.mjs";

const DEFAULTS = {
  url: "ws://aichat.home/ws",
  tokenFile: "~/.secrets/aichat-token",
  wake: "always", // always | mention | never
  paused: false, // true — не підключатися до брокера (пауза), тули працюють
  session: "resume", // resume | new — new starts a new model session on every plugin start (incl. opencode reload); .aichat/fresh does it once
  sessionTitle: "AIChat",
  rooms: [],
  maxWakesPerMinute: 12,
  delivery: "steer", // steer | queue — як віддавати вхідні, поки модель працює (брокерові завжди queue)
  requestTimeoutMs: 15000,
  // сокет: брокер шле власні WS-ping, але вбудований WebSocket відповідає на них
  // сам і нам їх не показує, тож про «напівмертве» з'єднання ми не дізнаємось.
  // Тому шлемо свій кадр ping і стежимо, чи взагалі щось приходить.
  pingIntervalMs: 30000,
  staleAfterMs: 75000,
  deliverRetries: 3,
  deliverBackoffMs: 700,
};

const PLUGIN_NAME = "opencode-channel";
const PLUGIN_VERSION = typeof __AICHAT_VERSION__ === "string" ? __AICHAT_VERSION__ : "0.0.0-dev";
const SESSION_KEY = "aichat/session";
const PREVIOUS_KEY = "aichat/previousSessionIds";
// Той самий набір, що REACTIONS у брокері (src/protocol.ts) — інше брокер відхилить.
const REACTIONS = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "✅", "🙏"];

const expandHome = (p) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readTextSafe(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function loadSettings(ctx) {
  const dir = ctx.location?.directory;
  const fromFile = (dir && readJsonSafe(path.join(dir, "aichat.config.json"))) || {};
  const fromOptions = ctx.options && typeof ctx.options === "object" ? ctx.options : {};
  const cfg = { ...DEFAULTS, ...fromFile, ...fromOptions };

  cfg.url = String(cfg.url || DEFAULTS.url);
  cfg.tokenFile = expandHome(String(cfg.tokenFile || DEFAULTS.tokenFile));
  cfg.token = String(cfg.token || readTextSafe(cfg.tokenFile) || process.env.AICHAT_TOKEN || "").trim();
  cfg.wake = ["always", "mention", "never"].includes(cfg.wake) ? cfg.wake : DEFAULTS.wake;
  cfg.paused = cfg.paused === true;
  cfg.session = cfg.session === "new" ? "new" : "resume";
  cfg.delivery = cfg.delivery === "queue" ? "queue" : "steer";
  cfg.rooms = Array.isArray(cfg.rooms) ? cfg.rooms.map((r) => String(r).replace(/^#/, "")).filter(Boolean) : [];
  // ws://host/ws → http://host
  cfg.httpBase = cfg.url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws\/?$/, "");
  return cfg;
}

/** `provider/model#variant` — how OpenCode names a model together with its effort level (the manager's setting). */
function modelRef(model) {
  if (!model || !model.providerID || !model.id) return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

/**
 * The manager reads .aichat/status.json for the effective state (the config says what was asked for; the running
 * process knows what it actually has). No secrets here. The schema is agreed with the agent manager:
 * model: "provider/model#variant" (the session's own, not the configured one),
 * effective: { sandbox, network, writableRoots, mcp: [{ name, state }] }.
 */
function writeStatus(ctx, cfg, state) {
  const dir = ctx.location?.directory || process.cwd();
  const file = path.join(dir, ".aichat", "status.json");
  const model = modelRef(state.lastModel);
  const body = {
    agent: state.me || null,
    adapter: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    surface: "server",
    start: state.start || "new",
    sessionID: state.sessionID || null,
    // what the session really runs on, so the manager can show it next to what was configured
    ...(model ? { model } : {}),
    paused: cfg.paused === true,
    connected: Boolean(state.ws),
    effective: {
      // OpenCode's plugin runs inside the OpenCode server, which has no sandbox of its own: be explicit, not reassuring.
      sandbox: false,
      network: true,
      writableRoots: ["*"],
      // MCP servers are configured in opencode.jsonc; the manager reads them there. Their connection state is not
      // exposed to the plugin, so no invented values here.
      mcp: [],
    },
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, file);
  } catch (error) {
    console.warn(`[aichat] не вдалось записати .aichat/status.json: ${error.message}`);
  }
}

async function apiRequest(cfg, pathname, { method = "GET", body, headers: extra, signal } = {}) {
  const headers = { Authorization: `Bearer ${cfg.token}`, ...(extra || {}) };
  // JSON — лише для звичайних об'єктів; рядок/байти (файли) відправляємо як є
  const isJson = body !== undefined && typeof body === "object" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer);
  if (isJson && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(cfg.httpBase + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
    signal: signal ?? AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = raw;
  }
  if (!res.ok) {
    const reason = typeof data === "string" ? data : data?.error || "";
    throw new Error(`${pathname}: HTTP ${res.status}${reason ? ` — ${reason}` : ""}`);
  }
  return data;
}

// Стан роботи для веба AIChat (busy / waiting / idle). Помилки не мають валити чат.
async function postActivity(cfg, body) {
  try {
    await apiRequest(cfg, "/api/activity", { method: "POST", body });
  } catch (error) {
    console.warn(`[aichat] не вдалось надіслати activity: ${error?.message ?? error}`);
  }
}

// скачати файл суцільними байтами (apiRequest віддає текст і зіпсує бінарне)
async function apiDownload(cfg, pathname, signal) {
  const res = await fetch(cfg.httpBase + pathname, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: signal ?? AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, headers: res.headers };
}


// Реакції на власні повідомлення, які брокер доклеює до наступного вхідного кадру.
// Сама реакція агента не будить: це лише довідка в контексті вже наявного ходу.
function formatReactionNotes(notes) {
  if (!Array.isArray(notes) || !notes.length) return "";
  const items = notes.slice(0, 20).map((n) => {
    const where = n.room ? ` у #${n.room}` : n.with ? ` (DM з ${n.with})` : "";
    return `#${n.id} ${n.emoji} ${n.by}${where}`;
  });
  return `Реакції на твої повідомлення відтоді: ${items.join("; ")}`;
}

function formatIncoming(msg, me, reactionNotes) {
  const lines = [];
  const where = msg.room ? `#${msg.room}` : `особисте → ${me}`;
  const meta = [`id ${msg.id}`];
  if (msg.reply_to) meta.push(`відповідь на ${msg.reply_to}`);
  if (msg.hops) meta.push(`hops ${msg.hops}`);
  lines.push(`[AIChat] ${where} · ${msg.from} · ${meta.join(" · ")}`);
  lines.push("");
  lines.push(String(msg.text ?? "").trim() || "(без тексту)");
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    lines.push("");
    lines.push(
      "Вкладення: " +
        msg.attachments.map((a) => `${a.name} (id ${a.id}, ${a.mime}, ${a.size})`).join(", "),
    );
  }
  const note = formatReactionNotes(reactionNotes);
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push(
    `Відповісти: send_message з reply_to=${msg.id}. Не відповідай, якщо відповіді не потрібно.`,
  );
  return lines.join("\n");
}

function shouldWake(cfg, state, msg) {
  if (cfg.wake === "never") return false;
  if (cfg.wake === "mention") {
    const text = String(msg.text ?? "").toLowerCase();
    const names = [state.me, ...(Array.isArray(cfg.mentions) ? cfg.mentions.map(String) : [])]
      .filter(Boolean)
      .map((n) => n.toLowerCase());
    if (!names.some((n) => text.includes(n))) return false;
  }
  // запобіжник: сплеск повідомлень не має палити модель на кожне
  const now = Date.now();
  const windowMs = 60_000;
  const limit = Number(cfg.maxWakesPerMinute) > 0 ? Number(cfg.maxWakesPerMinute) : DEFAULTS.maxWakesPerMinute;
  state.wakes = state.wakes.filter((t) => now - t < windowMs);
  if (state.wakes.length >= limit) return false;
  state.wakes.push(now);
  return true;
}

// "litellm/main-model#high" → { providerID, id, variant }
function parseModelRef(ref) {
  if (!ref) return undefined;
  if (typeof ref === "object") return ref;
  const [providerID, rest] = String(ref).split("/");
  if (!providerID || !rest) return undefined;
  const [id, variant] = rest.split("#");
  return { providerID, id, ...(variant ? { variant } : {}) };
}

// Модель із конфігу (інакше з агента), але лише якщо вона реально
// маршрутизується: провайдер може бути зареєстрований і не мати жодної робочої
// моделі (шлюз лежить, немає ключа), і тоді хід падає з «Model unavailable» вже
// після прийняття промпту. ctx.model.list() віддає саме робочі моделі локації —
// на них і орієнтуємось.
async function routedModel(ctx, cfg, state) {
  const wanted = parseModelRef(cfg.model) ?? (await agentModel(ctx, cfg));
  let routed;
  try {
    routed = await ctx.model.list();
  } catch {
    return wanted;
  }
  const ref = (m) => ({ providerID: m.providerID, id: m.id });
  if (!routed.length) return wanted;
  if (wanted) {
    const hit = routed.find((m) => m.providerID === wanted.providerID && m.id === wanted.id);
    // варіант роздумів (#high, #low) зберігаємо: він належить профільній моделі
    if (hit) return { ...ref(hit), ...(wanted.variant ? { variant: wanted.variant } : {}) };
  }
  // профільна модель не маршрутизується — беремо іншого провайдера, якщо є
  const other = routed.find((m) => !wanted || m.providerID !== wanted.providerID) ?? routed[0];
  return ref(other);
}

async function agentModel(ctx, cfg) {
  if (!cfg.agent) return undefined;
  try {
    const agent = await ctx.agent.get({ agentID: cfg.agent });
    return parseModelRef(agent?.model) ?? agent?.model;
  } catch {
    return undefined;
  }
}





function normalizeDir(dir) {
  const value = String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows paths are case-insensitive; POSIX paths are not, so /home/A and /home/a stay different sessions.
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sessionDirOf(info) {
  const loc = info?.location;
  if (typeof loc === "string") return loc;
  return loc?.directory ?? info?.directory;
}

async function ensureSession(ctx, cfg, state) {
  if (state.sessionID) return state.sessionID;
  const where = normalizeDir(ctx.location?.directory);
  const sessionKey = `${SESSION_KEY}:${where}`;
  // міграція: старий ключ без теки — беремо лише якщо тека сесії збігається
  const stored = await ctx.storage.get(sessionKey).catch(() => undefined);
  const legacy = await ctx.storage.get(SESSION_KEY).catch(() => undefined);
  const model = await routedModel(ctx, cfg, state);
  const sameModel = (a, b) =>
    Boolean(a && b) && a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "");
  const matchesWhere = (info) => {
    const dir = sessionDirOf(info);
    // не можемо звірити теку — не перевикористовуємо чужу сесію
    return Boolean(dir) && normalizeDir(dir) === where;
  };
  const candidates = [
    { id: cfg.sessionID, explicit: true }, // явний вибір людини
    { id: stored?.id, explicit: false },
    { id: legacy?.id, explicit: false },
  ];
  // A fresh start (session: "new" or the .aichat/fresh marker): keep the old session for reading, but do not
  // reuse it. The old ids go to previousSessionIds, so nothing is lost.
  const fresh = state.forceNew === true;
  if (fresh) {
    const previous = (await ctx.storage.get(PREVIOUS_KEY).catch(() => undefined)) || [];
    const old = [stored?.id, legacy?.id, cfg.sessionID].filter((id) => typeof id === "string" && id);
    const merged = [...new Set([...old, ...(Array.isArray(previous) ? previous : [])])].slice(0, 10);
    if (merged.length) await ctx.storage.set(PREVIOUS_KEY, merged).catch(() => {});
  }
  for (const { id, explicit } of fresh ? [] : candidates) {
    if (!id) continue;
    try {
      const info = await ctx.session.get({ sessionID: id });
      if (!explicit && !matchesWhere(info)) continue; // інша тека — не наша сесія
      state.sessionID = info.id;
      state.start = "resumed";
      state.lastModel = info.model;
      // сесію могли створити з іншою моделлю — повертаємо профільну
      if (model && !sameModel(info.model, model)) {
        try {
          await ctx.session.switchModel({ sessionID: info.id, model });
          state.lastModel = model;
        } catch (error) {
          console.warn(`[aichat] не вдалось змінити модель сесії: ${error.message}`);
        }
      }
      // фіксуємо під ключем теки (і міграція зі старого ключа теж сюди)
      await ctx.storage.set(sessionKey, { id: info.id, title: info.title ?? cfg.sessionTitle }).catch(() => {});
      return state.sessionID;
    } catch {
      // сесії більше немає — створимо нову
    }
  }
  const created = await ctx.session.create({
    title: cfg.sessionTitle || DEFAULTS.sessionTitle,
    ...(cfg.agent ? { agent: cfg.agent } : {}),
    ...(model ? { model } : {}),
  });
  state.sessionID = created.id;
  state.start = "new";
  state.forceNew = false; // the fresh start is spent: a retried delivery keeps this new session
  state.lastModel = created.model ?? model;
  await ctx.storage.set(sessionKey, { id: created.id, title: created.title ?? cfg.sessionTitle });
  return state.sessionID;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

// ✓✓ шлемо лише коли сокет живий; інакше відкладемо id до наступного welcome.
function ackDelivery(state, id) {
  const sent = state.ws?.send({ type: "delivered", id });
  if (sent) state.undelivered?.delete(id);
  else state.undelivered?.add(id);
}

async function deliver(ctx, cfg, state, msg, reactionNotes) {
  if (!msg || typeof msg !== "object" || !msg.id) return;
  if (msg.from && msg.from === state.me) return; // свої ж повідомлення не ін'єктуємо
  if (state.injected?.has(msg.id)) {
    // повторна доставка того самого id (буває, якщо ack загубився) — не дублюємо хід
    ackDelivery(state, msg.id);
    return;
  }
  const text = formatIncoming(msg, state.me || "тобі", reactionNotes);
  const metadata = {
    aichat: {
      id: msg.id,
      from: msg.from ?? null,
      room: msg.room ?? null,
      to: msg.to ?? null,
      reply_to: msg.reply_to ?? null,
    },
  };

  const queueItem = (session) => ({
    sessionID: session,
    text,
    metadata,
    msg,
    attempts: 0,
    firstAt: Date.now(),
  });

  let sessionID;
  try {
    sessionID = await ensureSession(ctx, cfg, state);
  } catch (error) {
    // без сесії теж не губимо: при повторі беремо її заново через ensureSession()
    console.warn(`[aichat] не можу відкрити сесію: ${error.message} — у чергу повтору`);
    state.pending.push(queueItem(undefined));
    return;
  }

  const wake = shouldWake(cfg, state, msg);
  // steer: модель бачить повідомлення на наступній межі кроку, а не після всього ходу.
  // Вітання й звіти брокера не мають збивати роботу, тому їм queue.
  const delivery = msg.from === "aichat" ? "queue" : cfg.delivery;
  const promptOnce = () => ctx.session.prompt({ sessionID, text, delivery, metadata });
  const syntheticOnce = (note) =>
    ctx.session.synthetic({
      sessionID,
      text: note ? `${text}\n\n(${note})` : text,
      description: `AIChat: ${msg.from ?? "?"}`,
      metadata,
    });

  // Курсор брокера зсувається вже на відправці в сокет (delivered лише ставить ✓✓),
  // тож саме повідомлення більше не прийде. Тому повторюємо prompt, а synthetic —
  // лише останнім кроком: дубля не буде, бо він іде тільки після невдачі prompt.
  if (wake) {
    const gaps = [1000, 5000]; // паузи між спробами; перед synthetic не чекаємо
    let delivered = false;
    for (let i = 0; i < gaps.length + 1 && !delivered; i++) {
      try {
        await promptOnce();
        delivered = true;
      } catch (error) {
        console.warn(
          `[aichat] хід для ${msg.id}, спроба ${i + 1}/${gaps.length + 1} не вдалась: ${error?.message ?? error}`,
        );
        if (i < gaps.length) await sleep(gaps[i]);
      }
    }
    if (!delivered) {
      try {
        await syntheticOnce("не вдалося розбудити модель");
        delivered = true;
      } catch (error) {
        console.warn(`[aichat] synthetic для ${msg.id} теж не вдався: ${error?.message ?? error}`);
      }
    }
    if (!delivered) {
      // останній рубіж: пам'ять процесу; таймер/реконект доспробують synthetic
      state.pending.push(queueItem(sessionID));
      return;
    }
  } else {
    try {
      await syntheticOnce();
    } catch (error) {
      console.warn(`[aichat] synthetic для ${msg.id} не вдався: ${error?.message ?? error}`);
      state.pending.push(queueItem(sessionID));
      return;
    }
  }
  ackDelivery(state, msg.id);
  state.markInjected?.(msg.id);
}

// Слідкуємо за подіями власної сесії AIChat і шлемо /api/activity, щоб у вебі було
// видно «працює…/чекає дозвіл/вільний». Лише для state.sessionID, з тротлінгом.
// --- перевірка оновлення адаптера (після welcome; не блокує роботу) ---
function parseSemver(value) {
  const m = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function semverNewer(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function checkForUpdate(ctx, cfg, state) {
  // локальна незбудована копія — нічого не кажемо
  if (PLUGIN_VERSION === "0.0.0-dev" || !parseSemver(PLUGIN_VERSION)) return;
  let info;
  try {
    const res = await fetch(cfg.httpBase + "/health", { signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    if (!res.ok) return;
    info = await res.json();
  } catch {
    return; // /health недоступний — не турбуємо
  }
  const latest = info?.version;
  if (!latest || !semverNewer(latest, PLUGIN_VERSION)) return;
  if (state.lastUpdateNotice === latest) return; // про цю версію вже казали
  state.lastUpdateNotice = latest;
  let sessionID;
  try {
    sessionID = await ensureSession(ctx, cfg, state);
  } catch {
    return;
  }
  const text =
    `(Примітка плагіна AIChat, не повідомлення в чаті, відповідати не треба.) ` +
    `Плагін opencode-channel має версію ${PLUGIN_VERSION}, а на брокері новіша ${latest}. ` +
    `Запропонуй людині завантажити ${cfg.httpBase}/client/opencode-channel.js поверх ` +
    `.opencode/plugins/aichat-channel/index.js і виконати opencode reload. Сам не оновлюй.`;
  try {
    await ctx.session.synthetic({
      sessionID,
      text,
      description: "AIChat: доступне оновлення плагіна",
    });
  } catch (error) {
    console.warn(`[aichat] не вдалось повідомити про оновлення: ${error?.message ?? error}`);
  }
}

// Звіт про використання для веба AIChat (сторінка «Використання» / профіль агента).
// Беремо лише свою сесію. Кумулятивні токени й вартість — з session.get, контекст —
// з останньої асистентської відповіді (session.context). Вікон лімітів поки не шлемо.
function normalizeProvider(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 40);
  return s || "unknown";
}

function followUsage(ctx, cfg, state) {
  const controller = new AbortController();
  const types = ["session.idle", "session.execution.succeeded"];
  const limits = new Map(); // "provider/id" -> context limit
  let lastSentAt = 0;
  let lastSig = "";
  let dirty = false; // сесія щось зробила після останнього звіту

  const contextLimitFor = async (ref) => {
    if (!ref?.providerID || !ref?.id || !ctx.model?.list) return null;
    const key = `${ref.providerID}/${ref.id}`;
    if (limits.has(key)) return limits.get(key);
    let value = null;
    try {
      const raw = await ctx.model.list();
      const models = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      const hit = models.find((m) => m.providerID === ref.providerID && m.id === ref.id);
      value = hit?.limit?.context ?? null;
    } catch {
      value = null;
    }
    limits.set(key, value);
    return value;
  };

  const report = async () => {
    if (!state.sessionID) return;
    // спершу тротлінг, щоб таймер не тягнув сесію й усі її повідомлення щохвилини:
    // не частіше ніж раз на 15 с; без нових подій — раз на 5 хв
    const now = Date.now();
    if (now - lastSentAt < 15000) return;
    if (!dirty && lastSentAt && now - lastSentAt < 300000) return;
    let info;
    try {
      info = await ctx.session.get({ sessionID: state.sessionID });
    } catch {
      return;
    }
    // the model could be switched in the TUI: keep status.json saying what the session really runs on
    if (info?.model && modelRef(info.model) !== modelRef(state.lastModel)) {
      state.lastModel = info.model;
      writeStatus(ctx, cfg, state);
    }
    const tokens = info?.tokens ?? {};
    const tokensIn = Number(tokens.input ?? 0);
    const tokensOut = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
    // нічого ще не витрачено — не шлемо нулі
    if (!tokensIn && !tokensOut && !(typeof info?.cost === "number" && info.cost > 0)) return;

    // остання асистентська відповідь: модель (для provider) і токени кроку (для контексту)
    let last = null;
    try {
      const rawMessages = await ctx.session.context({ sessionID: state.sessionID });
      const messages = Array.isArray(rawMessages)
        ? rawMessages
        : Array.isArray(rawMessages?.data)
          ? rawMessages.data
          : [];
      last = [...messages].reverse().find((m) => m?.tokens && m?.model) ?? null;
    } catch {
      last = null;
    }

    const provider = normalizeProvider(last?.model?.providerID ?? info?.model?.providerID ?? "unknown");
    const body = {
      provider,
      windows: [],
      session: { tokensIn, tokensOut },
    };
    if (typeof info?.cost === "number" && info.cost > 0) {
      body.session.cost = info.cost;
      body.session.currency = "USD";
    }
    if (last?.tokens) {
      const limit = await contextLimitFor(last.model ?? info?.model);
      if (limit && limit > 0) {
        const prompt =
          Number(last.tokens.input ?? 0) +
          Number(last.tokens.cache?.read ?? 0) +
          Number(last.tokens.cache?.write ?? 0);
        const usedPct = Math.min(100, Math.max(0, (prompt / limit) * 100));
        body.context = { usedPct: Math.round(usedPct * 10) / 10 };
      }
    }

    const sig = JSON.stringify(body);
    dirty = false;
    if (sig === lastSig && now - lastSentAt < 300000) return;
    lastSig = sig;
    lastSentAt = now;
    try {
      await apiRequest(cfg, "/api/usage", { method: "POST", body });
    } catch (error) {
      console.warn(`[aichat] не вдалось надіслати usage: ${error?.message ?? error}`);
    }
  };

  const timer = setInterval(() => void report(), 60000);
  timer.unref?.();

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal, types })) {
          const data = event?.data ?? {};
          if (!state.sessionID || data.sessionID !== state.sessionID) continue;
          dirty = true;
          await report();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn(`[aichat] usage-стрім упав: ${error?.message ?? error}`);
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        t.unref?.();
      });
    }
  })();

  return () => {
    clearInterval(timer);
    controller.abort();
  };
}

function followActivity(ctx, cfg, state) {
  const controller = new AbortController();
  const types = [
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.tool.input.started",
    "permission.asked",
    "permission.replied",
    "session.idle",
  ];
  let lastKey = "";
  let lastSent = 0;
  const send = (next) => {
    const key = `${next.state}|${next.detail ?? ""}|${next.target ?? ""}`;
    const now = Date.now();
    // тротлінг ~1.5 с; idle шлемо завжди, щоб не застрягти в busy
    if (next.state !== "idle" && key === lastKey && now - lastSent < 1500) return;
    lastKey = key;
    lastSent = now;
    void postActivity(cfg, next);
  };
  const handle = (event) => {
    const data = event?.data ?? {};
    // строго лише власна сесія AIChat — інакше busy чужих сесій тече в чат
    if (!state.sessionID || data.sessionID !== state.sessionID) return;
    switch (event.type) {
      case "session.execution.started":
        send({ state: "busy" });
        break;
      case "session.tool.input.started":
        send({ state: "busy", detail: data.name });
        break;
      case "permission.asked":
        send({ state: "waiting", detail: data.action ?? "дозвіл" });
        break;
      case "permission.replied":
        send({ state: "busy" });
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle":
        send({ state: "idle" });
        break;
    }
  };
  void (async () => {
    // стрім може завершитися — перепідписуємось із паузою, як реконект сокета
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal, types })) {
          handle(event);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn(`[aichat] стрім подій activity впав: ${error?.message ?? error}`);
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        t.unref?.();
      });
    }
  })();
  return () => controller.abort();
}

function startChannel(ctx, cfg, state) {
  let stopped = false;
  let attempt = 0;
  let timer = null;
  let socket = null;
  let heartbeatTimer = null;
  let retryTimer = null;
  let lastSeen = 0;
  let gen = 0;
  const session = state.processSession;

  const schedule = (connect) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    attempt += 1;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
    timer = setTimeout(connect, delay);
    timer.unref?.();
  };

  // усі ін'єкції та повтори — через один ланцюжок, щоб не зламати порядок повідомлень
  const enqueue = (task) => {
    state.queue = state.queue
      .then(task)
      .catch((error) => console.warn(`[aichat] черга: ${error?.message ?? error}`));
    return state.queue;
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // генеруємо нове покоління, щоб обробники старого сокета більше не спрацьовували
  const forceReconnect = () => {
    if (stopped) return;
    gen += 1;
    stopHeartbeat();
    state.ws = null;
    writeStatus(ctx, cfg, state);
    try {
      socket?.close();
    } catch {
      // вже закритий
    }
    schedule(connect);
  };

  // останній рубіж для тих, що не вдалось вкласти навіть synthetic: пробуємо ще раз
  const flushPending = async () => {
    if (stopped || !state.pending.length) return;
    const items = state.pending;
    state.pending = [];
    for (const item of items) {
      item.attempts = (item.attempts ?? 0) + 1;
      const tooMany = item.attempts > 20;
      const tooOld = Date.now() - (item.firstAt ?? Date.now()) > 60 * 60 * 1000;
      if (tooMany || tooOld) {
        // далі не крутимо вічно: повідомлення лишається в історії брокера
        console.warn(
          `[aichat] здаюсь на ${item.msg?.id} (спроб: ${item.attempts}, ${tooOld ? "понад годину" : "ліміт"})`,
        );
        continue;
      }
      try {
        // сесію могли видалити — беремо актуальну, а не ту, що була в момент черги
        const sessionID = await ensureSession(ctx, cfg, state);
        await ctx.session.synthetic({
          sessionID,
          text: `${item.text}\n\n(не вдалося розбудити модель)`,
          description: `AIChat: ${item.msg?.from ?? "?"}`,
          metadata: item.metadata,
        });
        ackDelivery(state, item.msg.id);
        state.markInjected?.(item.msg.id);
      } catch (error) {
        console.warn(`[aichat] повтор ${item.msg?.id} не вдався: ${error?.message ?? error}`);
        // сесію могло бути видалено — наступного разу візьмемо/створимо заново
        state.sessionID = undefined;
        state.pending.push(item);
      }
    }
  };
  retryTimer = setInterval(() => {
    if (state.pending.length) enqueue(flushPending);
  }, 15_000);
  retryTimer.unref?.();

  const connect = () => {
    if (stopped || !cfg.token) return;
    const myGen = ++gen;
    const isCurrent = () => myGen === gen && !stopped;

    let sock;
    try {
      sock = new WebSocket(cfg.url);
    } catch (error) {
      console.warn(`[aichat] не можу відкрити ${cfg.url}: ${error.message}`);
      schedule(connect);
      return;
    }
    socket = sock;
    state.ws = {
      send(frame) {
        try {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify(frame));
            return true;
          }
        } catch {
          // сокет закрився між перевіркою й відправкою
        }
        return false;
      },
    };

    sock.addEventListener("open", () => {
      if (!isCurrent()) return;
      attempt = 0;
      lastSeen = Date.now();
      stopHeartbeat();
      // Брокер шле WS-ping, і вбудований WebSocket відповідає на нього сам — плагін
      // тих кадрів не бачить. Тому власний app-level ping: якщо 75 с немає жодного
      // кадру від брокера, з'єднання вважаємо півмертвим і перепідключаємось.
      heartbeatTimer = setInterval(() => {
        if (stopped || !isCurrent()) return;
        if (Date.now() - lastSeen > 75_000) {
          console.warn("[aichat] немає кадрів 75 с — перепідключаюсь");
          forceReconnect();
          return;
        }
        state.ws?.send({ type: "ping" });
      }, 30_000);
      heartbeatTimer.unref?.();
      sock.send(
        JSON.stringify({
          type: "auth",
          token: cfg.token,
          client: { name: PLUGIN_NAME, version: PLUGIN_VERSION, surface: "server", start: state.start || "new" },
          session,
        }),
      );
    });

    sock.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      lastSeen = Date.now();
      let frame;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      handleFrame(frame);
    });

    sock.addEventListener("close", (event) => {
      if (!isCurrent()) return;
      state.ws = null;
      writeStatus(ctx, cfg, state);
      stopHeartbeat();
      if (stopped) return;
      if (event.code === 4003) {
        stopped = true;
        console.warn("[aichat] брокер відкинув токен (4003) — реконект не повторюю");
        return;
      }
      schedule(connect);
    });

    sock.addEventListener("error", () => {
      // причину дасть close
    });
  };

  const handleFrame = (frame) => {
    switch (frame?.type) {
      case "welcome":
        state.me = frame.agent || state.me;
        state.rooms = Array.isArray(frame.rooms)
          ? frame.rooms.map((r) => String(r).replace(/^#/, ""))
          : state.rooms;
        writeStatus(ctx, cfg, state);
        for (const room of cfg.rooms) state.ws?.send({ type: "join", room });
        // дошлемо ✓✓, які не пішли, бо сокета не було
        for (const id of [...(state.undelivered ?? [])]) ackDelivery(state, id);
        if (state.pending.length) enqueue(flushPending); // після реконекту добиваємо невідправлене
        void checkForUpdate(ctx, cfg, state); // брокер міг оновитися, поки ми були на зв'язку
        break;
      case "rooms":
        // адмін змінив набір кімнат — тримаємо state.rooms актуальним
        if (Array.isArray(frame.rooms)) {
          state.rooms = frame.rooms.map((r) => String(r).replace(/^#/, ""));
        }
        break;
      case "message":
        enqueue(() => deliver(ctx, cfg, state, frame.message, frame.reactions_since));
        break;
      case "error":
        console.warn(`[aichat] брокер: ${frame.error}`);
        break;
      default:
        // pong / presence / activity / delivered / thanks / brief / game — не потрібні
        break;
    }
  };

  connect();
  return () => {
    stopped = true;
    gen += 1;
    if (timer) clearTimeout(timer);
    stopHeartbeat();
    if (retryTimer) clearInterval(retryTimer);
    state.ws = null;
    try {
      socket?.close();
    } catch {
      // вже закритий
    }
  };
}

/**
 * The plugin's own tools: only the two local file utilities. Every server tool of AIChat lives on the broker and
 * reaches OpenCode through the `aichat` MCP server in `opencode.jsonc` (AIChat 3858-3869).
 */
function registerTools(ctx, cfg) {
  const requireToken = () => {
    if (!cfg.token) throw new Error("немає токена AIChat: поклади його у " + cfg.tokenFile);
    return cfg;
  };
  const agentDir = () => path.resolve(ctx.location?.directory || process.cwd());
  const outbox = () => path.join(agentDir(), "outbox");
  const tempDir = () => path.join(tmpdir(), "aichat-files");

  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "aichat_files",
      description: "AIChat: локальні файли — вивантажити файл у брокер і зберегти вкладення з чату",
    });

    editor.add({
      name: "upload_file",
      description:
        "Вивантажити локальний файл у брокер AIChat і отримати file_id для send_message(attachments=[...]). Лише з теки outbox агента або з тимчасової теки вкладень.",
      input: {
        type: "object",
        properties: { path: { type: "string", description: "шлях до файлу в outbox або тимчасовій теці" } },
        required: ["path"],
        additionalProperties: false,
      },
      options: { namespace: "aichat_files", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        mkdirSync(tempDir(), { recursive: true });
        // the same rule as every adapter: only outbox and this adapter's attachment folder, no private files
        const { bytes, name, mime } = readUpload({
          path: input.path,
          base: agentDir(),
          roots: [outbox(), tempDir()],
          blocked: [cfg.tokenFile],
        });
        const uploaded = await apiRequest(c, "/api/files", {
          method: "POST",
          body: bytes,
          headers: { "Content-Type": mime, "X-Filename": encodeURIComponent(name) },
          signal: context?.signal,
        });
        const fileID = uploaded?.file?.id;
        if (!fileID) throw new Error("брокер не повернув id файлу");
        return { content: JSON.stringify({ file_id: String(fileID), name, size: bytes.byteLength }) };
      },
    });

    editor.add({
      name: "get_attachment",
      description: "Зберегти вкладення AIChat за file_id у тимчасову теку й повернути шлях, ім'я та розмір.",
      input: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "id файлу з повідомлення" },
          name: { type: "string", description: "бажане ім'я (типово з Content-Disposition)" },
        },
        required: ["file_id"],
        additionalProperties: false,
      },
      options: { namespace: "aichat_files", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const id = String(input.file_id);
        const { bytes, headers } = await apiDownload(c, `/api/files/${encodeURIComponent(id)}`, context?.signal);
        const saved = saveDownload({
          dir: tempDir(),
          id,
          disposition: headers.get("content-disposition"),
          fallback: typeof input.name === "string" ? input.name : undefined,
          bytes,
        });
        return { content: JSON.stringify({ path: saved.path, name: saved.name, size: bytes.byteLength }) };
      },
    });
  });
}

export default {
  id: "aichat-channel",
  async setup(ctx) {
    const cfg = loadSettings(ctx);
    const state = {
      cfg,
      me: "",
      rooms: [],
      wakes: [],
      queue: Promise.resolve(),
      pending: [], // повідомлення, які не вдалось вкласти в сесію — добʼємо повторно
      undelivered: new Set(), // id, чиї ✓✓ не пішли (не було сокета) — дошлемо на welcome
      injected: new Set(), // id уже вкладених, щоб повторна доставка не дублювала хід
      markInjected(id) {
        if (id === undefined || id === null) return;
        state.injected.add(id);
        if (state.injected.size > 300) {
          const oldest = state.injected.values().next().value;
          state.injected.delete(oldest);
        }
      },
      ws: null,
      sessionID: undefined,
      start: "new",
      processSession: `opencode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };

    // Where the owner drops .aichat/stop (disconnect the channel), .aichat/start (connect it again) and
    // .aichat/fresh (start a new model session).
    const runtimeDir = path.join(ctx.location?.directory || process.cwd(), ".aichat");
    const freshFile = path.join(runtimeDir, "fresh");
    const stopFile = path.join(runtimeDir, "stop");
    const startFile = path.join(runtimeDir, "start");
    try {
      mkdirSync(runtimeDir, { recursive: true });
    } catch {}
    state.forceNew = cfg.session === "new" || existsSync(freshFile);
    state.freshMarker = existsSync(freshFile);

    if (!cfg.token) {
      console.warn(`[aichat] немає токена (${cfg.tokenFile}) — плагін не підключається`);
      return;
    }

    // The server tools live on the broker's /mcp now: an older broker would leave the agent with the two local
    // file utilities only, so say it plainly instead of letting the agent guess (AIChat 3862).
    await apiRequest(cfg, "/api/tools")
      .catch(() => console.warn("[aichat] брокер не має /api/tools (старіший за 0.29.0): серверні інструменти AIChat через /mcp недоступні — оновіть брокер"));

    const tools = await registerTools(ctx, cfg);
    // Сесія має існувати до першого повідомлення: тоді її видно у списку, і в ній
    // одразу стоїть профільна модель.
    await ensureSession(ctx, cfg, state)
      .then(() => {
        // The marker is spent only after the new session really exists (and its id is saved).
        if (state.freshMarker) {
          try {
            unlinkSync(freshFile);
          } catch {}
        }
      })
      .catch((error) => console.warn(`[aichat] не вдалось підготувати сесію: ${error.message}`))
      .finally(() => writeStatus(ctx, cfg, state));
    let stop;
    let stopActivity;
    let stopUsage;
    let stopWatcher;
    if (cfg.paused) {
      // пауза: до брокера не підключаємось, повідомлення не приходять і модель не будиться;
      // тули aichat_* лишаються робочими для ручної роботи в сесії.
      console.warn(`[aichat] пауза (paused: true) — канал не підключено, тули працюють`);
    } else {
      const openChannel = () => {
        if (stop) return false;
        stop = startChannel(ctx, cfg, state);
        // Стан роботи (busy/waiting/idle) для веба — за подіями власної сесії.
        stopActivity = followActivity(ctx, cfg, state);
        // Звіт про токени/вартість/контекст для сторінки «Використання».
        stopUsage = followUsage(ctx, cfg, state);
        writeStatus(ctx, cfg, state);
        return true;
      };
      let stopping = false;
      const closeChannel = () => {
        stopActivity?.();
        stopUsage?.();
        stop?.();
        stop = stopActivity = stopUsage = undefined;
        stopping = false;
        writeStatus(ctx, cfg, state);
      };
      openChannel();
      // .aichat/stop: the owner asked to disconnect the channel. The OpenCode server keeps running (and the
      // aichat tools stay), but AIChat sees the agent go offline, like the other adapters' stop.ps1.
      // .aichat/start: the owner asks for it back. The marker brings the channel up again without reloading the
      // shared OpenCode server, so other projects' agents are not disturbed (AIChat 3660).
      stopWatcher = setInterval(() => {
        if (existsSync(stopFile)) {
          try {
            unlinkSync(stopFile);
          } catch {}
          if (!stop || stopping) return;
          stopping = true;
          console.warn("[aichat] .aichat/stop — відключаю канал (сервер OpenCode лишається)");
          // idle first (the contract), then close the socket; activity/usage stop with the channel.
          void postActivity(cfg, { state: "idle" })
            .catch(() => {})
            .finally(closeChannel);
          return;
        }
        // wait out an in-flight disconnect: its marker stays and is retried on the next tick
        if (existsSync(startFile) && !stopping) {
          openChannel();
          try {
            unlinkSync(startFile);
          } catch {}
          console.warn("[aichat] .aichat/start — підключаю канал знову");
        }
      }, 1000);
      stopWatcher.unref?.();
    }

    return async () => {
      clearInterval(stopWatcher);
      stopUsage?.();
      stopActivity?.();
      stop?.();
      writeStatus(ctx, cfg, state);
      await tools?.dispose?.();
    };
  },
};
