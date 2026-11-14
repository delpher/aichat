// AIChat admin web UI. Plain JS, no build step.
// All user-supplied text goes through textContent; innerHTML is never used.
"use strict";

(() => {
  const TOKEN_KEY = "aichat.adminToken";
  const AS_KEY = "aichat.as";
  const PAGE = 100;

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
  };

  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const viewKey = (v) => (v.kind === "room" ? `r:${v.room}` : v.kind === "dm" ? `d:${pairKey(v.a, v.b)}` : v.kind);
  const msgKey = (m) => (m.room ? `r:${m.room}` : `d:${pairKey(m.from, m.to)}`);

  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    return `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })} ${time}`;
  }

  // ---------- state ----------
  const state = {
    token: null,
    remember: true,
    overview: { agents: [], rooms: [], dms: [] },
    view: { kind: "all" },
    messages: [],          // current view, ascending by id
    ids: new Set(),
    hasMore: false,
    loading: false,
    unread: new Map(),     // viewKey -> count
    seenLive: new Set(),   // ids already applied by addLiveMessage
    replyTo: null,         // ChatMessage
    ws: null,
    wsRetry: 0,
    wsTimer: null,
    loadSeq: 0,
  };

  // ---------- REST ----------
  class AuthError extends Error {}

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (res.status === 401 || res.status === 403) throw new AuthError((body && body.error) || "Невірний токен");
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  }

  function handleError(err, where) {
    if (err instanceof AuthError) {
      logout(err.message);
      return;
    }
    note(`${where}: ${err.message}`, true);
  }

  // ---------- login / logout ----------
  function showLogin(message) {
    $("app").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = message || "";
    $("login-token").focus();
  }

  async function login(token, remember) {
    state.token = token;
    state.remember = remember;
    try {
      await loadOverview();
    } catch (err) {
      state.token = null;
      showLogin(err instanceof AuthError ? "Невірний токен." : `Не вдалося з'єднатися: ${err.message}`);
      return;
    }
    if (remember) store.set(TOKEN_KEY, token); else store.del(TOKEN_KEY);
    $("login").hidden = true;
    $("app").hidden = false;
    $("login-token").value = "";
    connectWs();
    applyHash();
  }

  function logout(message) {
    store.del(TOKEN_KEY);
    state.token = null;
    clearTimeout(state.wsTimer);
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    state.messages = []; state.ids.clear(); state.unread.clear(); state.seenLive.clear();
    showLogin(message);
  }

  // ---------- overview / sidebar ----------
  async function loadOverview() {
    const data = await api("/admin/api/overview");
    state.overview = {
      agents: data.agents || [],
      rooms: data.rooms || [],
      dms: data.dms || [],
    };
    renderComposer(); // fills the "as" select, which the sidebar reads
    renderSidebar();
  }

  const humans = () => state.overview.agents.filter((a) => a.kind === "human").map((a) => a.name);
  const currentAs = () => $("as").value || null;

  function navItem(label, opts) {
    const li = el("li");
    const btn = el("button", "nav-item");
    btn.type = "button";
    if (opts.dot !== undefined) btn.append(el("span", opts.dot ? "dot on" : "dot"));
    btn.append(el("span", "nav-name", label));
    if (opts.kind) btn.append(el("span", "kind", opts.kind));
    if (opts.unread) btn.append(el("span", "badge", opts.unread));
    else if (opts.meta !== undefined) btn.append(el("span", "nav-meta", opts.meta));
    if (opts.active) btn.classList.add("active");
    if (opts.title) btn.title = opts.title;
    if (opts.onClick) btn.addEventListener("click", opts.onClick);
    li.append(btn);
    return li;
  }

  function renderSidebar() {
    const cur = viewKey(state.view);
    document.querySelector('[data-view="all"]').classList.toggle("active", cur === "all");
    document.querySelector('[data-view="settings"]').classList.toggle("active", cur === "settings");

    const byLast = (x, y) => String(y.last_ts || "").localeCompare(String(x.last_ts || ""));

    const rooms = $("rooms");
    rooms.replaceChildren();
    const roomList = [...state.overview.rooms].sort((x, y) => x.name.localeCompare(y.name));
    for (const r of roomList) {
      const key = `r:${r.name}`;
      rooms.append(navItem(`#${r.name}`, {
        meta: r.count,
        unread: state.unread.get(key),
        active: key === cur,
        title: `Учасники: ${(r.members || []).join(", ") || "—"}`,
        onClick: () => go({ kind: "room", room: r.name }),
      }));
    }
    if (!roomList.length) rooms.append(el("li", "muted small", "  немає"));

    const dms = $("dms");
    dms.replaceChildren();
    const dmList = [...state.overview.dms].sort(byLast);
    for (const d of dmList) {
      const key = `d:${pairKey(d.a, d.b)}`;
      dms.append(navItem(`${d.a} ↔ ${d.b}`, {
        meta: d.count,
        unread: state.unread.get(key),
        active: key === cur,
        onClick: () => go({ kind: "dm", a: d.a, b: d.b }),
      }));
    }
    if (!dmList.length) dms.append(el("li", "muted small", "  немає"));

    const agents = $("agents");
    agents.replaceChildren();
    const agentList = [...state.overview.agents].sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
    for (const a of agentList) {
      const me = currentAs();
      const canDm = me && me !== a.name;
      agents.append(navItem(a.name, {
        dot: a.online,
        kind: a.kind,
        title: [a.description, a.rooms && a.rooms.length ? `кімнати: ${a.rooms.map((r) => "#" + r).join(", ")}` : "",
          canDm ? `натисніть, щоб відкрити розмову ${me} ↔ ${a.name}` : ""].filter(Boolean).join("\n"),
        onClick: canDm ? () => go({ kind: "dm", a: me, b: a.name }) : undefined,
      }));
    }
    $("agents").classList.toggle("agents", !currentAs());
  }

  // ---------- navigation ----------
  function hashFor(v) {
    if (v.kind === "room") return `#room/${encodeURIComponent(v.room)}`;
    if (v.kind === "dm") return `#dm/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}`;
    if (v.kind === "settings") return "#settings";
    return "#all";
  }

  function parseHash() {
    const parts = location.hash.replace(/^#/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
    if (parts[0] === "settings") return { kind: "settings" };
    if (parts[0] === "room" && parts[1]) return { kind: "room", room: parts[1] };
    if (parts[0] === "dm" && parts[1] && parts[2]) {
      const [a, b] = [parts[1], parts[2]].sort();
      return { kind: "dm", a, b };
    }
    return { kind: "all" };
  }

  function go(v) {
    if (v.kind === "dm") { const [a, b] = [v.a, v.b].sort(); v = { kind: "dm", a, b }; }
    $("sidebar").classList.remove("open");
    const hash = hashFor(v);
    if (location.hash === hash) applyHash();
    else location.hash = hash;
  }

  function applyHash() {
    if (!state.token) return;
    state.view = parseHash();
    state.unread.delete(viewKey(state.view));
    setReply(null);
    renderHeader();
    renderSidebar();
    const isSettings = state.view.kind === "settings";
    $("settings").hidden = !isSettings;
    $("feed").hidden = isSettings;
    $("composer").hidden = isSettings;
    if (isSettings) {
      state.loadSeq++; // drop any in-flight message load
      loadSettings();
    } else {
      renderComposer();
      loadMessages(false);
    }
  }

  function renderHeader() {
    const v = state.view;
    let title = "Усі повідомлення", sub = "Кімнати й особисті повідомлення всіх агентів";
    if (v.kind === "room") {
      title = `#${v.room}`;
      const r = state.overview.rooms.find((x) => x.name === v.room);
      sub = r ? `Учасники: ${(r.members || []).join(", ") || "—"}` : "";
    } else if (v.kind === "dm") {
      title = `${v.a} ↔ ${v.b}`;
      sub = "Особисті повідомлення";
    } else if (v.kind === "settings") {
      title = "Налаштування";
      sub = "Ліміти брокера";
    }
    $("title").textContent = title;
    $("subtitle").textContent = sub;
    document.title = `${title} · AIChat`;
  }

  // ---------- messages ----------
  function viewQuery(v) {
    const q = new URLSearchParams();
    if (v.kind === "room") q.set("room", v.room);
    if (v.kind === "dm") { q.set("a", v.a); q.set("b", v.b); }
    return q;
  }

  function matchesView(m, v) {
    if (v.kind === "all") return true;
    if (v.kind === "room") return m.room === v.room;
    return !m.room && pairKey(m.from, m.to) === pairKey(v.a, v.b);
  }

  async function loadMessages(older) {
    const seq = ++state.loadSeq;
    const v = state.view;
    const q = viewQuery(v);
    q.set("limit", String(PAGE));
    if (older && state.messages.length) q.set("before", String(state.messages[0].id));
    state.loading = true;
    $("older").disabled = true;
    try {
      const data = await api(`/admin/api/messages?${q}`);
      if (seq !== state.loadSeq) return; // view changed meanwhile
      const batch = (data.messages || []).filter((m) => !state.ids.has(m.id) || !older);
      if (older) {
        const feed = $("feed");
        const fromBottom = feed.scrollHeight - feed.scrollTop;
        state.messages = batch.concat(state.messages);
        batch.forEach((m) => state.ids.add(m.id));
        renderMessages();
        feed.scrollTop = feed.scrollHeight - fromBottom;
      } else {
        state.messages = batch;
        state.ids = new Set(batch.map((m) => m.id));
        renderMessages();
        scrollToBottom();
      }
      state.hasMore = (data.messages || []).length >= PAGE;
      $("older").hidden = !state.hasMore;
    } catch (err) {
      if (seq === state.loadSeq) handleError(err, "Завантаження повідомлень");
    } finally {
      if (seq === state.loadSeq) { state.loading = false; $("older").disabled = false; }
    }
  }

  function isHuman(name) {
    const a = state.overview.agents.find((x) => x.name === name);
    return !!a && a.kind === "human";
  }

  function renderMessage(m) {
    const li = el("li", "msg");
    li.id = `m${m.id}`;
    if (isHuman(m.from)) li.classList.add("human");

    const head = el("div", "msg-head");
    head.append(el("span", "msg-from", m.from));

    if (state.view.kind === "all" || (m.room && state.view.kind !== "room")) {
      const where = el("a", "msg-where", m.room ? `#${m.room}` : `→ ${m.to}`);
      where.href = m.room ? hashFor({ kind: "room", room: m.room }) : hashFor({ kind: "dm", a: m.from, b: m.to });
      head.append(where);
    } else if (!m.room) {
      head.append(el("span", null, `→ ${m.to}`));
    }

    const time = el("time", null, fmtTime(m.ts));
    time.dateTime = m.ts;
    time.title = m.ts;
    head.append(time);
    head.append(el("span", "msg-tag", `#${m.id}`));
    const hops = el("span", "msg-tag", `hops ${m.hops}`);
    if (m.hops > 0) hops.classList.add("hot");
    hops.title = "Довжина ланцюжка відповідей";
    head.append(hops);

    if (m.reply_to) {
      const r = el("a", null, `↩ #${m.reply_to}`);
      r.href = "#";
      r.title = "Перейти до повідомлення, на яке це відповідь";
      r.addEventListener("click", (e) => { e.preventDefault(); jumpTo(m.reply_to); });
      head.append(r);
    }
    li.append(head);
    li.append(el("div", "msg-text", m.text));

    if (humans().length) {
      const actions = el("div", "msg-actions");
      const reply = el("a", null, "відповісти");
      reply.href = "#";
      reply.addEventListener("click", (e) => { e.preventDefault(); setReply(m); });
      actions.append(reply);
      li.append(actions);
    }
    return li;
  }

  function renderMessages() {
    $("messages").replaceChildren(...state.messages.map(renderMessage));
    $("empty").hidden = state.messages.length > 0;
  }

  function scrollToBottom() {
    const feed = $("feed");
    feed.scrollTop = feed.scrollHeight;
  }

  function jumpTo(id) {
    const node = $(`m${id}`);
    if (!node) {
      note(`Повідомлення #${id} не завантажене в цьому поданні. Натисніть «Завантажити старіші» або відкрийте «Усі повідомлення».`);
      return;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1500);
  }

  function addLiveMessage(m) {
    // The POST response and the WS echo deliver the same message; count it once.
    if (state.seenLive.has(m.id)) return;
    state.seenLive.add(m.id);
    // overview counters
    if (m.room) {
      let r = state.overview.rooms.find((x) => x.name === m.room);
      if (!r) { r = { name: m.room, members: [], count: 0, last_ts: null }; state.overview.rooms.push(r); }
      r.count += 1; r.last_ts = m.ts;
    } else if (m.to) {
      const [a, b] = [m.from, m.to].sort();
      let d = state.overview.dms.find((x) => x.a === a && x.b === b);
      if (!d) { d = { a, b, count: 0, last_ts: null }; state.overview.dms.push(d); }
      d.count += 1; d.last_ts = m.ts;
    }

    if (matchesView(m, state.view)) {
      if (!state.ids.has(m.id)) {
        const feed = $("feed");
        const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
        state.ids.add(m.id);
        state.messages.push(m);
        $("messages").append(renderMessage(m));
        $("empty").hidden = true;
        if (nearBottom) scrollToBottom();
      }
    } else {
      const key = msgKey(m);
      state.unread.set(key, (state.unread.get(key) || 0) + 1);
    }
    renderSidebar();
  }

  // ---------- WebSocket (observer, read-only) ----------
  function setConn(status, title) {
    const c = $("conn");
    c.className = `conn ${status}`;
    c.title = title;
  }

  function connectWs() {
    clearTimeout(state.wsTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    let welcomed = false;
    setConn("wait", "З'єднуюсь…");

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: state.token }));

    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      switch (frame.type) {
        case "welcome": {
          const wasRetry = state.wsRetry > 0;
          welcomed = true;
          state.wsRetry = 0;
          setConn("on", "Наживо: нові повідомлення з'являються автоматично");
          // After a reconnect, refetch to fill any gap.
          if (wasRetry) loadOverview().then(() => loadMessages(false)).catch((e) => handleError(e, "Оновлення"));
          break;
        }
        case "message":
          if (frame.message) addLiveMessage(frame.message);
          break;
        case "presence": {
          const a = state.overview.agents.find((x) => x.name === frame.agent);
          if (a) { a.online = !!frame.online; renderSidebar(); }
          else loadOverview().catch((e) => handleError(e, "Оновлення агентів"));
          break;
        }
        case "error":
          if (!welcomed) { ws.onclose = null; ws.close(); logout(`Брокер відхилив токен: ${frame.error}`); }
          else note(`Брокер: ${frame.error}`, true);
          break;
      }
    };

    ws.onclose = () => {
      if (state.ws !== ws || !state.token) return;
      state.ws = null;
      state.wsRetry += 1;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(state.wsRetry - 1, 4));
      setConn("", `Немає з'єднання, повтор через ${Math.round(delay / 1000)} с`);
      state.wsTimer = setTimeout(connectWs, delay);
    };
  }

  // ---------- composer ----------
  function note(text, isError) {
    const n = $("composer-note");
    n.textContent = text || "";
    n.classList.toggle("error", !!isError);
  }

  function setReply(m) {
    state.replyTo = m;
    $("reply-bar").hidden = !m;
    if (m) {
      const link = $("reply-link");
      link.textContent = `#${m.id} від ${m.from}`;
      link.onclick = (e) => { e.preventDefault(); jumpTo(m.id); };
      if (state.view.kind === "all") {
        // point the target at the conversation being answered
        const me = currentAs();
        const target = m.room ? `#${m.room}` : `@${m.from === me ? m.to : m.from}`;
        if ([...$("to").options].some((o) => o.value === target)) $("to").value = target;
      }
      $("text").focus();
    }
    renderComposer();
  }

  function renderComposer() {
    const names = humans();
    const asSel = $("as");
    const prev = asSel.value || store.get(AS_KEY);
    asSel.replaceChildren(...names.map((n) => { const o = el("option", null, n); o.value = n; return o; }));
    if (prev && names.includes(prev)) asSel.value = prev;

    const v = state.view;
    const me = currentAs();
    const toWrap = $("to-wrap");
    toWrap.hidden = v.kind !== "all";
    if (v.kind === "all") {
      const toSel = $("to");
      const keep = toSel.value;
      const opts = [];
      for (const r of [...state.overview.rooms].sort((x, y) => x.name.localeCompare(y.name))) opts.push(`#${r.name}`);
      for (const a of [...state.overview.agents].sort((x, y) => x.name.localeCompare(y.name))) if (a.name !== me) opts.push(`@${a.name}`);
      toSel.replaceChildren(...opts.map((t) => { const o = el("option", null, t); o.value = t; return o; }));
      if (keep && opts.includes(keep)) toSel.value = keep;
    }

    let blocked = "";
    if (!names.length) blocked = "Щоб писати з вебу, додайте агента типу human: npm run add-agent -- me human -r lobby";
    else if (v.kind === "dm" && me !== v.a && me !== v.b) blocked = `${me} не учасник цієї розмови. Оберіть ${v.a} або ${v.b} у полі «Від», якщо це human-агенти, або напишіть з «Усі повідомлення».`;
    $("text").disabled = !!blocked;
    $("send").disabled = !!blocked;
    asSel.disabled = !names.length;
    if (blocked) note(blocked);
    else if ($("composer-note").textContent && !$("composer-note").classList.contains("error")) note("");
  }

  function target() {
    const v = state.view;
    if (v.kind === "room") return { room: v.room };
    if (v.kind === "dm") return { to: currentAs() === v.a ? v.b : v.a };
    const t = $("to").value;
    if (!t) return null;
    return t.startsWith("#") ? { room: t.slice(1) } : { to: t.slice(1) };
  }

  async function send() {
    const text = $("text").value;
    if (!text.trim()) return;
    const as = currentAs();
    const t = target();
    if (!as || !t) { note("Оберіть відправника й отримувача.", true); return; }
    const body = { as, ...t, text };
    if (state.replyTo) body.reply_to = state.replyTo.id;
    $("send").disabled = true;
    try {
      const data = await api("/admin/api/messages", { method: "POST", body: JSON.stringify(body) });
      $("text").value = "";
      setReply(null);
      note("");
      // WS normally delivers it too; ids dedupe.
      if (data && data.message) addLiveMessage(data.message);
      scrollToBottom();
    } catch (err) {
      handleError(err, "Не надіслано");
    } finally {
      renderComposer();
    }
  }

  // ---------- settings ----------
  const SETTINGS_FIELDS = ["maxHops", "ratePerMinute", "maxTextLength"];
  const settingsState = { saved: null, limits: {}, seq: 0, editable: true };

  function settingsStatus(text, kind) {
    const s = $("settings-status");
    s.textContent = text || "";
    s.className = `small ${kind || ""}`;
  }

  function fieldInput(name) { return $(`set-${name}`); }

  function setSettingsBusy(busy) {
    const locked = busy || !settingsState.editable;
    for (const name of SETTINGS_FIELDS) fieldInput(name).readOnly = locked;
    $("settings-save").disabled = locked;
    $("settings-reset").disabled = locked;
  }

  function fillSettings(settings) {
    settingsState.saved = { ...settings };
    for (const name of SETTINGS_FIELDS) {
      const input = fieldInput(name);
      input.value = settings[name] ?? "";
      input.classList.remove("changed", "bad");
    }
  }

  async function loadSettings() {
    const seq = ++settingsState.seq;
    settingsStatus("Завантаження…");
    setSettingsBusy(true);
    try {
      const data = await api("/admin/api/settings");
      if (seq !== settingsState.seq) return;
      settingsState.limits = data.limits || {};
      for (const name of SETTINGS_FIELDS) {
        const lim = settingsState.limits[name];
        const input = fieldInput(name);
        const range = document.querySelector(`.range[data-for="${name}"]`);
        if (lim) {
          input.min = String(lim.min);
          input.max = String(lim.max);
          range.textContent = `Допустимо: від ${lim.min} до ${lim.max}.`;
        } else {
          input.removeAttribute("min"); input.removeAttribute("max");
          range.textContent = "";
        }
      }
      settingsState.editable = data.editable !== false;
      fillSettings(data.settings || {});
      settingsStatus(settingsState.editable ? "" : "Цей брокер запущено без файлу конфігурації, тому налаштування доступні лише для читання.");
    } catch (err) {
      if (seq !== settingsState.seq) return;
      if (err instanceof AuthError) { logout(err.message); return; }
      settingsStatus(`Не вдалося завантажити налаштування: ${err.message}`, "error");
    } finally {
      if (seq === settingsState.seq) setSettingsBusy(false);
    }
  }

  // Validates one field; returns { value } or { error }.
  function readField(name) {
    const input = fieldInput(name);
    const raw = input.value.trim();
    const lim = settingsState.limits[name];
    if (!/^-?\d+$/.test(raw)) return { error: `${name}: потрібне ціле число` };
    const value = Number(raw);
    if (lim && (value < lim.min || value > lim.max)) return { error: `${name}: від ${lim.min} до ${lim.max}` };
    return { value };
  }

  function markChanged() {
    if (!settingsState.saved) return;
    for (const name of SETTINGS_FIELDS) {
      const input = fieldInput(name);
      const r = readField(name);
      input.classList.toggle("bad", !!r.error && input.value.trim() !== "");
      input.classList.toggle("changed", String(settingsState.saved[name]) !== input.value.trim());
    }
    settingsStatus("");
  }

  async function saveSettings() {
    if (!settingsState.saved) return;
    const patch = {};
    const errors = [];
    for (const name of SETTINGS_FIELDS) {
      const r = readField(name);
      if (r.error) { errors.push(r.error); fieldInput(name).classList.add("bad"); continue; }
      if (r.value !== settingsState.saved[name]) patch[name] = r.value;
    }
    if (errors.length) { settingsStatus(errors.join("; "), "error"); return; }
    if (!Object.keys(patch).length) { settingsStatus("Змін немає."); return; }

    setSettingsBusy(true);
    settingsStatus("Збереження…");
    try {
      const data = await api("/admin/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
      fillSettings(data.settings || { ...settingsState.saved, ...patch });
      const changed = Object.entries(patch).map(([k, v]) => `${k} = ${v}`).join(", ");
      settingsStatus(`Збережено: ${changed}.`, "ok");
    } catch (err) {
      if (err instanceof AuthError) { logout(err.message); return; }
      settingsStatus(`Не збережено: ${err.message}`, "error");
    } finally {
      setSettingsBusy(false);
    }
  }

  // ---------- wiring ----------
  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("login-token").value.trim();
    if (token) login(token, $("login-remember").checked);
  });
  $("logout").addEventListener("click", () => logout(""));
  document.querySelector('[data-view="all"]').addEventListener("click", () => go({ kind: "all" }));
  document.querySelector('[data-view="settings"]').addEventListener("click", () => go({ kind: "settings" }));
  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });
  $("settings-form").addEventListener("input", markChanged);
  $("settings-reset").addEventListener("click", () => {
    if (settingsState.saved) { fillSettings(settingsState.saved); settingsStatus(""); }
  });
  $("menu").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("older").addEventListener("click", () => { if (!state.loading) loadMessages(true); });
  $("reply-cancel").addEventListener("click", () => setReply(null));
  $("as").addEventListener("change", () => { store.set(AS_KEY, $("as").value); renderComposer(); renderSidebar(); });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  window.addEventListener("hashchange", applyHash);

  const saved = store.get(TOKEN_KEY);
  if (saved) login(saved, true); else showLogin("");
})();
