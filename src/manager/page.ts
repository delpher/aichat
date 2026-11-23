// The manager's single page: plain HTML and script, no build step. Every value goes in as text, never as HTML.
export const PAGE = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Агенти AIChat</title>
<style>
  :root { --bg: #f7f7f8; --surface: #fff; --text: #1d1d1f; --muted: #6b6b73; --line: #e3e3e8; --ok: #1a7f37; --warn: #9a6700; --bad: #c62828; --accent: #3b5bdb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141416; --surface: #1d1d21; --text: #ececf0; --muted: #9a9aa5; --line: #2e2e35; --ok: #4ac26b; --warn: #d4a72c; --bad: #ff6b6b; --accent: #7c9cff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  button { font: inherit; padding: 4px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .table { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
  th { font-weight: 600; font-size: 12px; color: var(--muted); }
  tr:last-child td { border-bottom: 0; }
  tr.pick { cursor: pointer; }
  tr.pick:hover td, tr.sel td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--muted); }
  .ok { color: var(--ok); } .ok .dot, .dot.ok { background: var(--ok); }
  .warn { color: var(--warn); } .bad { color: var(--bad); }
  .small { font-size: 12px; }
  section.logs { margin-top: 20px; }
  .logs .bar { margin-bottom: 8px; }
  select { font: inherit; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .actions input { font: inherit; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .5; cursor: default; }
  #msg { min-height: 1.4em; margin-bottom: 8px; }
  ul.removed { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  ul.removed li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  ul.removed li:last-child { border-bottom: 0; }
  pre { margin: 0; padding: 12px; max-height: 60vh; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); font: 12px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>Агенти AIChat</h1>
  <div class="bar"><span class="muted" id="root"></span><button id="refresh" type="button">Оновити</button><span class="muted small" id="when"></span></div>
  <div class="table"><table>
    <thead><tr><th>Агент</th><th>Тип</th><th>Адаптер</th><th>У чаті</th><th>Зараз</th><th>Процес</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="muted">Завантаження…</td></tr></tbody>
  </table></div>
  <section class="logs" id="logs" hidden>
    <h2 id="agent-title" style="font-size:16px;margin:0 0 8px"></h2>
    <div class="actions" id="actions"></div>
    <div id="msg" class="small"></div>
    <div class="bar"><strong id="logs-title"></strong><select id="log-file"></select><button id="log-refresh" type="button">Оновити лог</button><label class="small muted"><input type="checkbox" id="log-auto" checked> щоразу за 10 с</label></div>
    <pre id="log-text"></pre>
  </section>
  <section class="logs" id="removed-box" hidden>
    <h2 style="font-size:16px;margin:0 0 8px">Видалені</h2>
    <p class="small muted" style="margin:0 0 8px">Теки лежать в <code>.removed</code>; остаточно стерти їх можна вручну.</p>
    <ul class="removed" id="removed"></ul>
  </section>
</main>
<script>
const TYPES = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", opencode: "OpenCode" };
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const cmp = (a, b) => { const p = (v) => (v || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0); const [x, y] = [p(a), p(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const ago = (iso) => { if (!iso) return ""; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? s + " с тому" : s < 3600 ? Math.round(s / 60) + " хв тому" : Math.round(s / 3600) + " год тому"; };
let agents = [], selected = null, busy = false;

function adapterCell(a) {
  const td = el("td");
  const b = a.broker || {};
  td.append(el("span", a.version || "невідомо"));
  if (a.version && b.version && cmp(a.version, b.version) < 0) td.append(el("div", "брокер " + b.version + ": варто оновити", "small warn"));
  else if (a.version && b.version) td.append(el("div", "актуальна", "small ok"));
  const live = b.adapter && b.adapter.version;
  if (live && live !== a.version) td.append(el("div", "запущена " + live + ": перезапустіть", "small warn"));
  return td;
}

function render() {
  const rows = $("rows");
  rows.replaceChildren();
  if (!agents.length) { const tr = el("tr"); const td = el("td", "У цій теці агентів не знайдено.", "muted"); td.colSpan = 6; tr.append(td); rows.append(tr); return; }
  for (const a of agents) {
    const tr = el("tr", null, "pick" + (selected === a.folder ? " sel" : ""));
    const who = el("td"); who.append(el("strong", a.name || a.folder)); if (a.name && a.name !== a.folder) who.append(el("div", a.folder, "small muted"));
    tr.append(who, el("td", TYPES[a.type] || a.type), adapterCell(a));
    const b = a.broker || {};
    const chat = el("td");
    if (b.error) chat.append(el("span", "помилка: " + b.error, "bad small"));
    else if (b.online === undefined) chat.append(el("span", "—", "muted"));
    else { const s = el("span", b.online ? "онлайн" : "офлайн", b.online ? "ok" : "muted"); s.prepend(el("span", null, "dot")); chat.append(s); }
    tr.append(chat);
    const now = el("td");
    const act = b.activity;
    if (act && act.state) { now.append(el("span", act.state + (act.topic ? ": " + act.topic : ""))); if (act.since) now.append(el("div", ago(act.since), "small muted")); }
    else if (a.status && a.status.phase) now.append(el("span", a.status.phase, "muted"));
    else now.append(el("span", "—", "muted"));
    tr.append(now);
    const proc = el("td");
    if (a.status && a.status.pid) proc.append(el("span", (a.status.alive ? "працює" : "не працює") + " · pid " + a.status.pid, a.status.alive ? "ok" : "muted"));
    else proc.append(el("span", a.type === "claude" || a.type === "opencode" ? "у терміналі" : "—", "muted"));
    tr.append(proc);
    tr.addEventListener("click", () => select(a.folder));
    rows.append(tr);
  }
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-aichat-manager": "1" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status + " " + r.statusText);
  return d.message || "Готово.";
}

function say(text, cls) { const m = $("msg"); m.textContent = text; m.className = "small " + (cls || ""); }

async function act(label, path, body) {
  for (const b of $("actions").querySelectorAll("button")) b.disabled = true;
  say(label + "…", "muted");
  busy = true;
  try { say(await post(path, body), "ok"); } catch (e) { say(e.message, "bad"); }
  busy = false;
  await load();
  if (selected && !agents.some((a) => a.folder === selected)) { selected = null; $("logs").hidden = true; } else if (selected) actionsFor(agents.find((a) => a.folder === selected));
  watchSoon();
}

function actionsFor(a) {
  const box = $("actions"); box.replaceChildren();
  const b = a.broker || {};
  const base = "/api/agents/" + encodeURIComponent(a.folder) + "/";
  const button = (text, fn, cls) => { const x = el("button", text, cls); x.type = "button"; x.addEventListener("click", fn); box.append(x); return x; };
  const runs = (a.status && a.status.alive) || b.online;
  if (!runs) button("Запустити", () => act("Запускаю", base + "start"));
  const bg = a.type === "agy" || a.type === "codex";
  if (bg && a.attachPort && a.status && a.status.alive) button("Відкрити сесію", () => act("Відкриваю сесію", base + "session"));
  if (bg && a.status && a.status.alive) button("Зупинити", () => act("Зупиняю", base + "stop"));
  if (b.version) button(a.version === b.version ? "Перевстановити адаптер " + b.version : "Оновити адаптер до " + b.version, () => act("Оновлюю", base + "update"));
  if (!runs) {
    const confirmBox = el("input"); confirmBox.placeholder = "назва теки для підтвердження"; confirmBox.hidden = true;
    const del = button("Видалити", () => {
      if (confirmBox.hidden) { confirmBox.hidden = false; confirmBox.focus(); del.textContent = "Підтвердити видалення"; return; }
      act("Видаляю", base + "remove", { confirm: confirmBox.value.trim() });
    }, "danger");
    box.append(confirmBox);
  }
  if (a.type === "claude" || a.type === "opencode") box.append(el("span", runs ? "Працює в терміналі: зупиняється там." : "Відкриється вкладка Windows Terminal.", "small muted"));
  else if (!runs) box.append(el("span", "Запуститься у фоні, без вікна; вивід піде в лог background.log.", "small muted"));
  else if (!a.attachPort) box.append(el("span", "Щоб відкривати сесію, додайте attachPort у aichat.config.json і перезапустіть агента.", "small muted"));
  else box.append(el("span", "Сесія відкривається вкладкою терміналу; її закриття агента не зупиняє.", "small muted"));
}

/** Redraws the buttons of the selected agent after a refresh, unless an action is under way or a deletion is being confirmed. */
function refreshActions() {
  if (!selected || busy) return;
  const confirming = [...$("actions").querySelectorAll("input")].some((i) => !i.hidden);
  const a = agents.find((x) => x.folder === selected);
  if (a && !confirming) actionsFor(a);
}

/** A terminal agent comes online in the broker a few seconds after its tab opens: look more often for a while. */
function watchSoon() {
  let left = 15;
  const t = setInterval(() => { load(); if (--left <= 0) clearInterval(t); }, 3000);
}

async function loadRemoved() {
  try {
    const d = await (await fetch("/api/removed")).json();
    const ul = $("removed"); ul.replaceChildren();
    $("removed-box").hidden = !d.removed.length;
    for (const name of d.removed) {
      const li = el("li"); li.append(el("span", name));
      const x = el("button", "Повернути"); x.type = "button";
      x.addEventListener("click", async () => { x.disabled = true; try { await post("/api/removed/" + encodeURIComponent(name) + "/restore"); } catch (e) { alert(e.message); } load(); });
      li.append(x); ul.append(li);
    }
  } catch {}
}

async function load() {
  try {
    const r = await fetch("/api/agents");
    if (!r.ok) throw new Error(r.status + " " + (await r.text()));
    const d = await r.json();
    agents = d.agents; $("root").textContent = "Тека: " + d.root; $("when").textContent = "оновлено " + new Date().toLocaleTimeString();
    render(); refreshActions(); loadRemoved();
  } catch (e) { $("when").textContent = "не вдалося: " + e.message; }
}

async function select(folder) {
  selected = folder; render();
  const a = agents.find((x) => x.folder === folder);
  $("logs").hidden = false; $("agent-title").textContent = a.name || a.folder; $("logs-title").textContent = "Лог"; say("");
  actionsFor(a);
  const sel = $("log-file"); sel.replaceChildren();
  for (const f of a.logs) sel.append(el("option", f));
  if (!a.logs.length) { $("log-text").textContent = a.type === "claude" || a.type === "opencode" ? "Цей агент працює в терміналі: його вивід там." : "Логів немає."; sel.hidden = true; return; }
  sel.hidden = false; showLog();
}

async function showLog() {
  const file = $("log-file").value; if (!selected || !file || $("log-file").hidden) return;
  const r = await fetch("/api/agents/" + encodeURIComponent(selected) + "/logs/" + encodeURIComponent(file) + "?lines=300");
  const d = await r.json();
  const pre = $("log-text");
  // follow the end only when the reader is already there, so scrolling up to read is not undone
  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = d.text || d.error || "(порожньо)";
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

$("refresh").addEventListener("click", load);
$("log-refresh").addEventListener("click", showLog);
$("log-file").addEventListener("change", showLog);
load(); setInterval(load, 15000);
// the open log follows by itself every 10 s (alexey, AIChat 3157)
setInterval(() => { if ($("log-auto").checked && !document.hidden) showLog(); }, 10000);
</script>
</body>
</html>
`;
