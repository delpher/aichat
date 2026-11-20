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
//   * додає тули aichat_send / aichat_read / aichat_agents / aichat_join /
//     aichat_status / aichat_note. Відправка й читання — звичайним HTTP API
//     брокера: WS потрібен лише для push.
//
// Налаштування (перше знайдене переважає): options плагіна → aichat.config.json у
// теці профілю → типові значення. Токен — з ~/.secrets/aichat-token або AICHAT_TOKEN
// (у файлі й у конфізі він не лежить).
//
// Підключення: файл у <профіль>/.opencode/plugins/ — OpenCode вантажить звідти сам.

import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const DEFAULTS = {
  url: "ws://aichat.home/ws",
  tokenFile: "~/.secrets/aichat-token",
  wake: "always", // always | mention | never
  paused: false, // true — не підключатися до брокера (пауза), тули працюють
  sessionTitle: "AIChat",
  rooms: [],
  maxWakesPerMinute: 12,
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
  cfg.rooms = Array.isArray(cfg.rooms) ? cfg.rooms.map((r) => String(r).replace(/^#/, "")).filter(Boolean) : [];
  // ws://host/ws → http://host
  cfg.httpBase = cfg.url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws\/?$/, "");
  return cfg;
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

const MIME_BY_EXT = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

const guessMime = (name) => MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";

// RFC 5987: attachment; filename*=UTF-8''%D1%84... — беремо те, що після ''
function nameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const value = star?.[1] ?? plain?.[1];
  if (!value) return fallback;
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim() || fallback;
  }
}

// безпечне ім'я для запису на диск
function safeFileName(name, fallback) {
  const base = path.basename(String(name || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base : fallback;
}

function formatIncoming(msg, me) {
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
  lines.push("");
  lines.push(
    `Відповісти: aichat_send з reply_to=${msg.id}. Не відповідай, якщо відповіді не потрібно.`,
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
  return String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
  for (const { id, explicit } of candidates) {
    if (!id) continue;
    try {
      const info = await ctx.session.get({ sessionID: id });
      if (!explicit && !matchesWhere(info)) continue; // інша тека — не наша сесія
      state.sessionID = info.id;
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

async function deliver(ctx, cfg, state, msg) {
  if (!msg || typeof msg !== "object" || !msg.id) return;
  if (msg.from && msg.from === state.me) return; // свої ж повідомлення не ін'єктуємо
  if (state.injected?.has(msg.id)) {
    // повторна доставка того самого id (буває, якщо ack загубився) — не дублюємо хід
    ackDelivery(state, msg.id);
    return;
  }
  const text = formatIncoming(msg, state.me || "тобі");
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
  const promptOnce = () => ctx.session.prompt({ sessionID, text, delivery: "queue", metadata });
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

// Брокер приймає провайдера як коротке ім'я малими літерами (^[a-z0-9][a-z0-9._-]{0,39}$).
function providerId(raw) {
  const id = String(raw ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return id || "unknown";
}

// Звіт про використання для веба AIChat (сторінка «Використання» / профіль агента).
// Беремо лише свою сесію, кумулятивні токени — з session.usage.updated, контекст —
// з останнього кроку. Вікон лімітів поки не шлемо (OpenCode Go/Console недоступні тут).
function followUsage(ctx, cfg, state) {
  const controller = new AbortController();
  const types = ["session.usage.updated", "session.step.started", "session.step.ended", "session.idle"];
  const limits = new Map(); // "provider/id" -> context limit
  let usage = null; // { cost, tokens } кумулятивно
  let modelRef = null; // { providerID, id, variant }
  let lastStepTokens = null;
  let lastSentAt = 0;
  let lastSig = "";

  const contextLimitFor = async (ref) => {
    if (!ref?.providerID || !ref?.id || !ctx.model?.list) return null;
    const key = `${ref.providerID}/${ref.id}`;
    if (limits.has(key)) return limits.get(key);
    let value = null;
    try {
      const models = await ctx.model.list();
      const hit = models.find((m) => m.providerID === ref.providerID && m.id === ref.id);
      value = hit?.limit?.context ?? null;
    } catch {
      value = null;
    }
    limits.set(key, value);
    return value;
  };

  const report = async () => {
    // поки сесія нічого не витратила, звітувати нема про що (інакше в вебі будуть нулі й "unknown")
    if (!state.sessionID || (!usage && !lastStepTokens)) return;
    const now = Date.now();
    const body = { provider: providerId(modelRef?.providerID || state.lastModel?.providerID), windows: [] };
    if (usage) {
      const tokens = usage.tokens ?? {};
      const tokensIn = Number(tokens.input ?? 0);
      const tokensOut = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
      body.session = { tokensIn: Number.isFinite(tokensIn) ? tokensIn : 0, tokensOut: Number.isFinite(tokensOut) ? tokensOut : 0 };
      if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost > 0) {
        body.session.cost = usage.cost;
        body.session.currency = "USD";
      }
    }
    if (lastStepTokens) {
      const limit = await contextLimitFor(modelRef || state.lastModel);
      if (limit && limit > 0) {
        const prompt =
          Number(lastStepTokens.input ?? 0) +
          Number(lastStepTokens.cache?.read ?? 0) +
          Number(lastStepTokens.cache?.write ?? 0);
        const usedPct = Math.min(100, Math.max(0, (prompt / limit) * 100));
        body.context = { usedPct: Math.round(usedPct * 10) / 10 };
      }
    }
    const sig = JSON.stringify(body);
    // не частіше ніж раз на 15 с; без змін — раз на 5 хв
    if (now - lastSentAt < 15000) return;
    if (sig === lastSig && now - lastSentAt < 300000) return;
    lastSig = sig;
    lastSentAt = now;
    try {
      await apiRequest(cfg, "/api/usage", { method: "POST", body });
    } catch (error) {
      console.warn(`[aichat] не вдалось надіслати usage: ${error?.message ?? error}`);
    }
  };

  const handle = async (event) => {
    const data = event?.data ?? {};
    if (!state.sessionID || data.sessionID !== state.sessionID) return;
    switch (event.type) {
      case "session.usage.updated":
        usage = { cost: data.cost, tokens: data.tokens };
        break;
      case "session.step.started":
        if (data.model) {
          modelRef = data.model;
          void contextLimitFor(modelRef);
        }
        break;
      case "session.step.ended":
        lastStepTokens = data.tokens ?? lastStepTokens;
        break;
      case "session.idle":
        await report();
        break;
    }
  };

  const timer = setInterval(() => void report(), 60000);
  timer.unref?.();

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal, types })) {
          await handle(event);
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
          client: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
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
        enqueue(() => deliver(ctx, cfg, state, frame.message));
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

function registerTools(ctx, cfg, state) {
  const requireToken = () => {
    if (!cfg.token) throw new Error("немає токена AIChat: поклади його у " + cfg.tokenFile);
    return cfg;
  };
  // у паузі вхідні не приходять — нагадуємо про це у відповідях на відправку
  const pauseNote = cfg.paused ? " (пауза: вхідні не приходять)" : "";

  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "aichat",
      description: "AIChat: кімнати, особисті повідомлення, учасники, статус, нотатник",
    });

    editor.add({
      name: "send",
      description:
        "Надіслати повідомлення в AIChat — у кімнату (room) або особисто (to). Для відповіді передавай reply_to з id вхідного повідомлення.",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "Текст повідомлення" },
          room: { type: "string", description: "Кімната, напр. lobby" },
          to: { type: "string", description: "Ім'я учасника для особистого повідомлення" },
          reply_to: { type: "number", description: "id повідомлення, на яке відповідаєш" },
          attachments: {
            type: "array",
            items: { type: "string" },
            description: "id файлів, уже завантажених у AIChat (див. aichat_file_send)",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const hasTo = Boolean(input.to);
        const hasRoom = Boolean(input.room);
        if (hasTo === hasRoom) throw new Error("вкажи рівно одне з полів: to або room");
        const body = { text: String(input.text) };
        if (hasTo) body.to = String(input.to);
        if (hasRoom) body.room = String(input.room).replace(/^#/, "");
        if (input.reply_to) body.reply_to = Number(input.reply_to);
        if (Array.isArray(input.attachments) && input.attachments.length) body.attachments = input.attachments.map(String);
        const res = await apiRequest(c, "/api/messages", { method: "POST", body, signal: context?.signal });
        const id = res?.message?.id ?? res?.id;
        if (hasRoom) state.rooms = [...new Set([...state.rooms, String(input.room).replace(/^#/, "")])];
        return { content: (id ? `надіслано, id ${id}` : "надіслано") + pauseNote };
      },
    });

    editor.add({
      name: "read",
      description: "Прочитати історію AIChat: кімнати (room) або особистої розмови (with).",
      input: {
        type: "object",
        properties: {
          room: { type: "string", description: "Кімната" },
          with: { type: "string", description: "Ім'я учасника для особистої розмови" },
          limit: { type: "number", description: "Скільки останніх повідомлень (1..500, типово 20)" },
          before: { type: "number", description: "Гортати назад: id, перед яким читати" },
        },
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        if (Boolean(input.room) === Boolean(input.with)) throw new Error("вкажи рівно одне з полів: room або with");
        const params = new URLSearchParams();
        if (input.room) params.set("room", String(input.room).replace(/^#/, ""));
        if (input.with) params.set("with", String(input.with));
        params.set("limit", String(Math.min(Math.max(Number(input.limit) || 20, 1), 500)));
        if (input.before) params.set("before", String(Number(input.before)));
        const res = await apiRequest(c, `/api/history?${params}`, { signal: context?.signal });
        const messages = Array.isArray(res?.messages) ? res.messages : [];
        if (!messages.length) return { content: "порожньо" };
        const out = messages.map((m) => {
          const where = m.room ? `#${m.room}` : "особисте";
          const reply = m.reply_to ? ` (↩${m.reply_to})` : "";
          const files =
            Array.isArray(m.attachments) && m.attachments.length
              ? ` [вкладення: ${m.attachments
                  .map((a) => `${a.name ?? "файл"} (id ${a.id}, ${a.mime ?? "?"}, ${a.size ?? "?"})`)
                  .join(", ")}]`
              : "";
          return `[${m.id}] ${m.ts ?? ""} ${where} ${m.from}${reply}: ${m.text}${files}`;
        });
        return { content: out.join("\n") };
      },
    });

    editor.add({
      name: "agents",
      description: "Хто є в AIChat: онлайн/офлайн, кімнати, чим зайняті.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "aichat", codemode: true },
      execute: async (_input, context) => {
        const c = requireToken();
        const res = await apiRequest(c, "/api/agents", { signal: context?.signal });
        const agents = Array.isArray(res?.agents) ? res.agents : [];
        const out = agents.map((a) => {
          const bits = [`${a.name} (${a.kind})`, a.online ? "онлайн" : "офлайн"];
          if (a.activity?.state && a.activity.state !== "idle") bits.push(`зараз: ${a.activity.state}`);
          if (Array.isArray(a.rooms) && a.rooms.length) bits.push(`кімнати: ${a.rooms.join(", ")}`);
          return bits.join(" · ");
        });
        return { content: out.join("\n") || "нікого" };
      },
    });

    editor.add({
      name: "join",
      description: "Вступити в кімнату AIChat або вийти з неї (leave).",
      input: {
        type: "object",
        properties: {
          room: { type: "string" },
          leave: { type: "boolean", description: "true — вийти з кімнати" },
        },
        required: ["room"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const room = String(input.room).replace(/^#/, "");
        const action = input.leave ? "leave" : "join";
        await apiRequest(c, `/api/rooms/${encodeURIComponent(room)}/${action}`, {
          method: "POST",
          signal: context?.signal,
        });
        state.rooms = input.leave ? state.rooms.filter((r) => r !== room) : [...new Set([...state.rooms, room])];
        return { content: `${input.leave ? "вийшов з" : "вступив у"} #${room}` };
      },
    });

    editor.add({
      name: "status",
      description: "Поставити статус: над чим працюєш і в якій кімнаті. Порожній topic знімає статус.",
      input: {
        type: "object",
        properties: {
          topic: { type: "string", description: "1-4 слова; порожньо — зняти статус" },
          room: { type: "string" },
        },
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const body = { topic: String(input.topic ?? "").trim() };
        if (input.room) body.room = String(input.room).replace(/^#/, "");
        await apiRequest(c, "/api/status", { method: "POST", body, signal: context?.signal });
        return { content: body.topic ? `статус: ${body.topic}` : "статус знято" };
      },
    });

    editor.add({
      name: "brief",
      description: "Бриф кімнати AIChat: про що кімната і як у ній поводитись. Читай перед роботою в кімнаті.",
      input: {
        type: "object",
        properties: { room: { type: "string", description: "Кімната, напр. lobby" } },
        required: ["room"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const room = String(input.room).replace(/^#/, "");
        const res = await apiRequest(c, `/api/rooms/${encodeURIComponent(room)}/brief`, { signal: context?.signal });
        const brief = res?.brief ?? (typeof res === "string" ? res : null);
        if (!brief) return { content: `у #${room} брифу немає` };
        const text =
          typeof brief === "string"
            ? brief
            : String(brief.text ?? brief.body ?? brief.description ?? JSON.stringify(brief));
        return { content: `#${room}: ${text}` };
      },
    });

    editor.add({
      name: "intro",
      description: "Вступ AIChat: що це за чат, хто є хто, як поводитись.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "aichat", codemode: true },
      execute: async (_input, context) => {
        const c = requireToken();
        const res = await apiRequest(c, "/api/intro", { signal: context?.signal });
        const text = typeof res === "string" ? res : res?.intro?.text ?? "";
        return { content: text || "вступу немає" };
      },
    });

    editor.add({
      name: "thanks",
      description: "Подякувати за повідомлення AIChat (id з історії або вхідного повідомлення).",
      input: {
        type: "object",
        properties: { id: { type: "number", description: "id повідомлення" } },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        try {
          const res = await apiRequest(c, `/api/messages/${Number(input.id)}/thanks`, {
            method: "POST",
            signal: context?.signal,
          });
          const names = Array.isArray(res?.thanked_by) ? res.thanked_by : [];
          return { content: names.length ? `подяка записана (${names.join(", ")})` : "подяка записана" };
        } catch (error) {
          if (/\b409\b/.test(String(error?.message))) return { content: `за ${input.id} вже подяковано` };
          throw error;
        }
      },
    });

    editor.add({
      name: "file_get",
      description: "Завантажити вкладення AIChat за id: зберігає файл на диск і повертає шлях.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "id файлу з повідомлення" },
          dir: { type: "string", description: "тека для збереження (типово тимчасова)" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const id = String(input.id);
        const { bytes, headers } = await apiDownload(c, `/api/files/${encodeURIComponent(id)}`, context?.signal);
        const dir = input.dir ? String(input.dir) : path.join(tmpdir(), "aichat-files");
        mkdirSync(dir, { recursive: true });
        const fallback = `file-${id}`;
        const name = safeFileName(nameFromDisposition(headers.get("content-disposition"), fallback), fallback);
        const file = path.join(dir, name);
        writeFileSync(file, bytes);
        return { content: `${file} (${bytes.byteLength} байт)` };
      },
    });

    editor.add({
      name: "file_send",
      description:
        "Надіслати локальний файл у AIChat: завантажує його в брокер і публікує повідомленням (room або to).",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "шлях до файлу на диску" },
          room: { type: "string" },
          to: { type: "string" },
          text: { type: "string", description: "підпис до файлу (типово ім'я файлу)" },
          reply_to: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const hasTo = Boolean(input.to);
        const hasRoom = Boolean(input.room);
        if (hasTo === hasRoom) throw new Error("вкажи рівно одне з полів: to або room");
        const requested = path.resolve(String(input.path));
        // розкриваємо symlink: лінк у теці профілю, що веде на ~/.secrets, інакше пройшов би
        let file;
        try {
          file = realpathSync(requested);
        } catch {
          throw new Error(`файл не знайдено: ${requested}`);
        }
        // чат не має витягувати з диска секрети: дозволяємо лише теку профілю й
        // <tmp>/aichat-files (куди пише file_get), а ~/.secrets, .env і схоже на ключі — зась
        const toReal = (p) => {
          try {
            return realpathSync(p);
          } catch {
            return path.resolve(p);
          }
        };
        const tempDir = path.join(tmpdir(), "aichat-files");
        mkdirSync(tempDir, { recursive: true });
        const allowedDirs = [toReal(ctx.location?.directory || process.cwd()), toReal(tempDir)];
        const inAllowed = (dir) => {
          const rel = path.relative(dir, file);
          return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        };
        const base = path.basename(file).toLowerCase();
        const looksSecret = /(^|[._-])(token|secret|secrets|key|keys|creds|credentials|password|passwd)([._-]|$)/.test(base) ||
          base === ".env" || base.startsWith(".env.");
        const inSecrets = /[\\/]\.secrets([\\/]|$)/i.test(file);
        if (looksSecret || inSecrets) throw new Error(`не надсилаю схоже на секрет: ${path.basename(file)}`);
        if (!allowedDirs.some(inAllowed)) {
          throw new Error(`можна надсилати лише файли з теки профілю або ${tempDir}: ${file}`);
        }
        const size = statSync(file).size;
        const bytes = readFileSync(file);
        const name = path.basename(file);
        const uploaded = await apiRequest(c, "/api/files", {
          method: "POST",
          body: bytes,
          headers: { "Content-Type": guessMime(name), "X-Filename": encodeURIComponent(name) },
          signal: context?.signal,
        });
        const fileID = uploaded?.file?.id;
        if (!fileID) throw new Error("брокер не повернув id файлу");
        const body = { text: String(input.text ?? name), attachments: [String(fileID)] };
        if (hasTo) body.to = String(input.to);
        if (hasRoom) body.room = String(input.room).replace(/^#/, "");
        if (input.reply_to) body.reply_to = Number(input.reply_to);
        const res = await apiRequest(c, "/api/messages", { method: "POST", body, signal: context?.signal });
        const id = res?.message?.id ?? res?.id;
        if (hasRoom) state.rooms = [...new Set([...state.rooms, String(input.room).replace(/^#/, "")])];
        return { content: `надіслано ${name} (${size} байт), файл ${fileID}, повідомлення ${id ?? "?"}` + pauseNote };
      },
    });

    editor.add({
      name: "note",
      description:
        "Нотатник AIChat — пам'ять між сесіями: list, get, add, update, delete. Для update/delete/get потрібен id.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "add", "update", "delete"] },
          id: { type: "number", description: "id нотатки (get/update/delete)" },
          title: { type: "string" },
          description: { type: "string" },
          text: { type: "string" },
          topic: { type: "string" },
          q: { type: "string", description: "пошук для list" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { namespace: "aichat", codemode: true },
      execute: async (input, context) => {
        const c = requireToken();
        const render = (n) => {
          const head = `[${n.id}] ${n.topic ? `(${n.topic}) ` : ""}${n.title}: ${n.description ?? ""}`;
          return n.text ? `${head}\n${n.text}` : head;
        };
        if (input.action === "list") {
          const params = new URLSearchParams();
          if (input.q) params.set("q", String(input.q));
          if (input.topic) params.set("topic", String(input.topic));
          const qs = params.toString();
          const res = await apiRequest(c, `/api/notes${qs ? `?${qs}` : ""}`, { signal: context?.signal });
          const notes = Array.isArray(res?.notes) ? res.notes : [];
          if (!notes.length) return { content: "нотатник порожній" };
          return {
            content: notes
              .map((n) => `[${n.id}] ${n.topic ? `(${n.topic}) ` : ""}${n.title}: ${n.description ?? ""}`)
              .join("\n"),
          };
        }
        const id = input.action === "add" ? 0 : Number(input.id);
        if (input.action === "add") {
          const body = {};
          for (const key of ["title", "description", "text", "topic"]) {
            if (input[key] !== undefined) body[key] = String(input[key]);
          }
          if (!body.title) throw new Error("для add потрібен title");
          body.description = body.description ?? "";
          const res = await apiRequest(c, "/api/notes", { method: "POST", body, signal: context?.signal });
          const newId = res?.note?.id ?? res?.id;
          return { content: newId ? `записано, id ${newId}` : "записано" };
        }
        if (!id) throw new Error(`для ${input.action} потрібен id`);
        if (input.action === "get") {
          const res = await apiRequest(c, `/api/notes/${id}`, { signal: context?.signal });
          return { content: res?.note ? render(res.note) : "нотатки немає" };
        }
        if (input.action === "delete") {
          await apiRequest(c, `/api/notes/${id}`, { method: "DELETE", signal: context?.signal });
          return { content: `нотатку ${id} видалено` };
        }
        const body = {};
        for (const key of ["title", "description", "text", "topic"]) {
          if (input[key] !== undefined) body[key] = String(input[key]);
        }
        if (input.action === "update") {
          if (!Object.keys(body).length) throw new Error("для update передай хоча б одне поле");
          const res = await apiRequest(c, `/api/notes/${id}`, { method: "PUT", body, signal: context?.signal });
          return { content: `нотатку ${id} оновлено${res?.note ? `: ${render(res.note)}` : ""}` };
        }
        throw new Error(`невідома дія: ${input.action}`);
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
      processSession: `opencode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };

    if (!cfg.token) {
      console.warn(`[aichat] немає токена (${cfg.tokenFile}) — плагін не підключається`);
      return;
    }

    const tools = await registerTools(ctx, cfg, state);
    // Сесія має існувати до першого повідомлення: тоді її видно у списку, і в ній
    // одразу стоїть профільна модель.
    await ensureSession(ctx, cfg, state).catch((error) =>
      console.warn(`[aichat] не вдалось підготувати сесію: ${error.message}`),
    );
    let stop;
    let stopActivity;
    let stopUsage;
    if (cfg.paused) {
      // пауза: до брокера не підключаємось, повідомлення не приходять і модель не будиться;
      // тули aichat_* лишаються робочими для ручної роботи в сесії.
      console.warn(`[aichat] пауза (paused: true) — канал не підключено, тули працюють`);
    } else {
      stop = startChannel(ctx, cfg, state);
      // Стан роботи (busy/waiting/idle) для веба — за подіями власної сесії.
      stopActivity = followActivity(ctx, cfg, state);
      // Звіт про токени/вартість/контекст для сторінки «Використання».
      stopUsage = followUsage(ctx, cfg, state);
    }

    return async () => {
      stopUsage?.();
      stopActivity?.();
      stop?.();
      await tools?.dispose?.();
    };
  },
};
