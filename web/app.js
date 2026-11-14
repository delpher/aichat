// AIChat web UI. Plain JS, no build step.
// Two modes, picked at login by which token was entered:
//   admin — adminToken: sees every room and DM, writes as any human agent, manages people and settings.
//   user  — a person's own agent token: sees only their rooms and DMs, writes only as themselves.
// All user-supplied text goes through textContent; innerHTML is never used.
"use strict";

(() => {
  const TOKEN_KEY = "aichat.token";
  const OLD_TOKEN_KEY = "aichat.adminToken"; // pre-multi-user key, read once for migration
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
  const byName = (x, y) => x.name.localeCompare(y.name);
  // Admin-only panels: view kind -> section id
  const PANELS = { settings: "settings", people: "people", rooms: "manage-rooms" };
  const ADMIN_VIEWS = Object.keys(PANELS);
  const ROOM_RE = /^[A-Za-z0-9_\-]{1,64}$/;

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
    mode: null,            // "admin" | "user"
    me: null,              // user mode: { name, kind }
    adminMe: null,         // admin mode: { name, root }
    overview: { agents: [], rooms: [], dms: [], all_rooms: [] },
    view: { kind: "all" },
    messages: [],          // current view, ascending by id
    ids: new Set(),
    loading: false,
    unread: new Map(),     // viewKey -> count
    seenLive: new Set(),   // ids already applied by addLiveMessage
    replyTo: null,         // ChatMessage
    flash: null,           // note to show once the next view is applied
    ws: null,
    wsRetry: 0,
    wsTimer: null,
    loadSeq: 0,
  };
  const isAdmin = () => state.mode === "admin";

  // ---------- REST ----------
  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  class AuthError extends HttpError {}

  async function request(path, options = {}, token = state.token) {
    const res = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    const msg = (body && body.error) || `HTTP ${res.status}`;
    if (res.status === 401) throw new AuthError(401, msg);
    if (!res.ok) throw new HttpError(res.status, msg);
    return body;
  }
  const api = (path, options) => request(path, options);

  function handleError(err, where) {
    if (err instanceof AuthError) {
      logout("Сесія завершилась: токен більше не дійсний. Увійдіть знову.");
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

  // Admin token first; if the broker rejects it as admin, try it as a personal token.
  async function detectMode(token) {
    try {
      const data = await request("/admin/api/overview", {}, token);
      return { mode: "admin", data };
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 403)) throw err;
    }
    const data = await request("/api/overview", {}, token); // AuthError here = invalid token
    return { mode: "user", data };
  }

  async function login(token, remember) {
    let found;
    try {
      found = await detectMode(token);
    } catch (err) {
      showLogin(err instanceof AuthError ? "Невірний токен." : `Не вдалося з'єднатися: ${err.message}`);
      return;
    }
    state.token = token;
    state.mode = found.mode;
    state.me = found.mode === "user" ? found.data.me : null;
    // admin mode: the root adminToken ({root: true}) or a person marked admin ({name})
    state.adminMe = found.mode === "admin" ? (found.data.me || { name: "owner", root: true }) : null;
    document.body.classList.toggle("mode-admin", isAdmin());
    document.body.classList.toggle("mode-user", !isAdmin());
    $("whoami").textContent = !isAdmin() ? `Ви: ${state.me.name}`
      : state.adminMe.root ? "Адмін (головний токен)" : `Адмін: ${state.adminMe.name}`;
    setOverview(found.data);

    store.del(OLD_TOKEN_KEY);
    if (remember) store.set(TOKEN_KEY, token); else store.del(TOKEN_KEY);
    $("login").hidden = true;
    $("app").hidden = false;
    $("login-token").value = "";
    connectWs();
    applyHash();
  }

  function logout(message) {
    store.del(TOKEN_KEY);
    store.del(OLD_TOKEN_KEY);
    state.token = null;
    state.mode = null;
    state.me = null;
    state.adminMe = null;
    clearTimeout(state.wsTimer);
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    state.messages = []; state.ids.clear(); state.unread.clear(); state.seenLive.clear();
    hideSetup();
    showLogin(message);
  }

  // ---------- overview / sidebar ----------
  function setOverview(data) {
    state.overview = {
      agents: data.agents || [],
      rooms: data.rooms || [],
      dms: data.dms || [],
      all_rooms: data.all_rooms || [],
    };
    renderComposer(); // fills the "as" select, which the sidebar reads
    renderSidebar();
    renderHeader();
  }

  async function loadOverview() {
    setOverview(await api(isAdmin() ? "/admin/api/overview" : "/api/overview"));
  }

  const humans = () => state.overview.agents.filter((a) => a.kind === "human").map((a) => a.name);
  // The identity messages are sent as: chosen human in admin mode, yourself in user mode.
  const currentAs = () => (isAdmin() ? $("as").value || null : state.me && state.me.name);
  const myRooms = () => state.overview.rooms.map((r) => r.name);

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
    else btn.classList.add("static");
    li.append(btn);
    return li;
  }

  function emptyItem(text) { return el("li", "muted small nav-empty", text); }

  function renderSidebar() {
    const cur = viewKey(state.view);
    for (const name of ADMIN_VIEWS.concat("all")) {
      document.querySelector(`[data-view="${name}"]`).classList.toggle("active", cur === name);
    }

    const rooms = $("rooms");
    rooms.replaceChildren();
    for (const r of [...state.overview.rooms].sort(byName)) {
      const key = `r:${r.name}`;
      rooms.append(navItem(`#${r.name}`, {
        meta: r.count,
        unread: state.unread.get(key),
        active: key === cur,
        title: `Учасники: ${(r.members || []).join(", ") || "—"}`,
        onClick: () => go({ kind: "room", room: r.name }),
      }));
    }
    if (!state.overview.rooms.length) rooms.append(emptyItem(isAdmin() ? "немає" : "ви ще не в жодній кімнаті"));

    if (!isAdmin()) {
      const mine = new Set(myRooms());
      const others = state.overview.all_rooms.filter((n) => !mine.has(n)).sort();
      const list = $("other-rooms");
      list.replaceChildren();
      for (const name of others) {
        list.append(navItem(`#${name}`, {
          meta: "приєднатися",
          title: `Приєднатися до #${name}`,
          onClick: () => joinRoom(name),
        }));
      }
      if (!others.length) list.append(emptyItem("немає"));
    }

    const dms = $("dms");
    dms.replaceChildren();
    const dmList = [...state.overview.dms].sort((x, y) => String(y.last_ts || "").localeCompare(String(x.last_ts || "")));
    const me = currentAs();
    for (const d of dmList) {
      const key = `d:${pairKey(d.a, d.b)}`;
      const label = !isAdmin() ? (d.a === me ? d.b : d.a) : `${d.a} ↔ ${d.b}`;
      dms.append(navItem(label, {
        meta: d.count,
        unread: state.unread.get(key),
        active: key === cur,
        onClick: () => go({ kind: "dm", a: d.a, b: d.b }),
      }));
    }
    if (!dmList.length) dms.append(emptyItem("немає"));

    const agents = $("agents");
    agents.replaceChildren();
    const agentList = [...state.overview.agents].sort((x, y) => (y.online - x.online) || byName(x, y));
    for (const a of agentList) {
      const canDm = me && me !== a.name;
      const label = a.name === me && !isAdmin() ? `${a.name} (ви)` : a.name;
      agents.append(navItem(label, {
        dot: a.online,
        kind: a.kind,
        title: [a.description, a.rooms && a.rooms.length ? `кімнати: ${a.rooms.map((r) => "#" + r).join(", ")}` : "",
          canDm ? `натисніть, щоб відкрити розмову ${me} ↔ ${a.name}` : ""].filter(Boolean).join("\n"),
        onClick: canDm ? () => go({ kind: "dm", a: me, b: a.name }) : undefined,
      }));
    }
  }

  // ---------- rooms (user mode) ----------
  async function joinRoom(name) {
    if (!ROOM_RE.test(name)) { note("Назва кімнати: латиниця, цифри, - і _ (до 64 символів).", true); return; }
    try {
      await api(`/api/rooms/${encodeURIComponent(name)}/join`, { method: "POST" });
      await loadOverview();
      go({ kind: "room", room: name });
    } catch (err) {
      handleError(err, "Не вдалося приєднатися");
    }
  }

  async function leaveRoom(name) {
    try {
      await api(`/api/rooms/${encodeURIComponent(name)}/leave`, { method: "POST" });
      await loadOverview();
      go({ kind: "home" });
    } catch (err) {
      handleError(err, "Не вдалося вийти з кімнати");
    }
  }

  // ---------- navigation ----------
  function hashFor(v) {
    if (v.kind === "room") return `#room/${encodeURIComponent(v.room)}`;
    if (v.kind === "dm") return `#dm/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}`;
    if (ADMIN_VIEWS.includes(v.kind)) return `#${v.kind}`;
    return "#all";
  }

  function parseHash() {
    const parts = location.hash.replace(/^#/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
    if (ADMIN_VIEWS.includes(parts[0])) return { kind: parts[0] };
    if (parts[0] === "room" && parts[1]) return { kind: "room", room: parts[1] };
    if (parts[0] === "dm" && parts[1] && parts[2]) {
      const [a, b] = [parts[1], parts[2]].sort();
      return { kind: "dm", a, b };
    }
    return { kind: "all" };
  }

  // A view this mode is allowed to show; user mode has no "all", settings or people.
  function resolveView(v) {
    if (isAdmin()) return v.kind === "home" ? { kind: "all" } : v;
    const me = state.me.name;
    if (v.kind === "room" && myRooms().includes(v.room)) return v;
    if (v.kind === "dm" && (v.a === me || v.b === me)) return v;
    const first = [...state.overview.rooms].sort(byName)[0];
    if (first) return { kind: "room", room: first.name };
    const dm = state.overview.dms[0];
    if (dm) return { kind: "dm", a: dm.a, b: dm.b };
    return { kind: "none" };
  }

  function go(v) {
    if (v.kind === "dm") { const [a, b] = [v.a, v.b].sort(); v = { kind: "dm", a, b }; }
    $("sidebar").classList.remove("open");
    v = resolveView(v);
    const hash = v.kind === "none" ? "" : hashFor(v);
    if (location.hash === hash || (!hash && !location.hash)) applyHash();
    else location.hash = hash;
  }

  function applyHash() {
    if (!state.token) return;
    const wanted = parseHash();
    const v = resolveView(location.hash ? wanted : { kind: "home" });
    if (v.kind !== "none" && hashFor(v) !== location.hash) {
      history.replaceState(null, "", hashFor(v));
    }
    state.view = v;
    state.unread.delete(viewKey(v));
    setReply(null);
    renderHeader();
    renderSidebar();

    const panel = ADMIN_VIEWS.includes(v.kind);
    for (const [kind, id] of Object.entries(PANELS)) $(id).hidden = v.kind !== kind;
    $("feed").hidden = panel;
    $("composer").hidden = panel || v.kind === "none";
    if (v.kind !== "people") hideSetup();

    if (panel || v.kind === "none") {
      state.loadSeq++; // drop any in-flight message load
      state.messages = []; state.ids.clear();
      if (v.kind === "none") {
        renderMessages();
        // the composer (and its note line) is hidden here, so put any pending notice into the empty-state text
        $("empty").textContent = `${state.flash ? state.flash + " " : ""}Ви ще не в жодній кімнаті. Приєднайтеся до кімнати зліва або напишіть комусь зі списку «Агенти й люди».`;
        state.flash = null;
        $("older").hidden = true;
      }
      if (v.kind === "settings") loadSettings();
      if (v.kind === "people") loadPeople();
      if (v.kind === "rooms") loadRoomsAdmin();
    } else {
      $("empty").textContent = "Повідомлень поки немає.";
      renderComposer();
      loadMessages(false);
    }
    if (state.flash) { note(state.flash); state.flash = null; }
  }

  function renderHeader() {
    const v = state.view;
    let title = "Усі повідомлення", sub = "Кімнати й особисті повідомлення всіх агентів";
    if (v.kind === "room") {
      title = `#${v.room}`;
      const r = state.overview.rooms.find((x) => x.name === v.room);
      sub = r ? `Учасники: ${(r.members || []).join(", ") || "—"}` : "";
    } else if (v.kind === "dm") {
      const me = !isAdmin() && state.me.name;
      title = me ? (v.a === me ? v.b : v.a) : `${v.a} ↔ ${v.b}`;
      sub = me ? "Особисті повідомлення" : "Особисті повідомлення між двома учасниками";
    } else if (v.kind === "settings") {
      title = "Налаштування"; sub = "Ліміти брокера";
    } else if (v.kind === "people") {
      title = "Агенти й люди"; sub = "Хто може підключатися до брокера";
    } else if (v.kind === "rooms") {
      title = "Кімнати"; sub = "Створення кімнат і учасники";
    } else if (v.kind === "none") {
      title = "AIChat"; sub = "";
    }
    $("title").textContent = title;
    $("subtitle").textContent = sub;
    $("leave-room").hidden = isAdmin() || v.kind !== "room";
    document.title = title === "AIChat" ? title : `${title} · AIChat`;
  }

  // ---------- messages ----------
  function historyPath(v, before) {
    const q = new URLSearchParams();
    q.set("limit", String(PAGE));
    if (before) q.set("before", String(before));
    if (isAdmin()) {
      if (v.kind === "room") q.set("room", v.room);
      if (v.kind === "dm") { q.set("a", v.a); q.set("b", v.b); }
      return `/admin/api/messages?${q}`;
    }
    if (v.kind === "room") q.set("room", v.room);
    if (v.kind === "dm") q.set("with", v.a === state.me.name ? v.b : v.a);
    return `/api/history?${q}`;
  }

  function matchesView(m, v) {
    if (v.kind === "all") return true;
    if (v.kind === "room") return m.room === v.room;
    if (v.kind === "dm") return !m.room && pairKey(m.from, m.to) === pairKey(v.a, v.b);
    return false;
  }

  async function loadMessages(older) {
    const seq = ++state.loadSeq;
    const v = state.view;
    const before = older && state.messages.length ? state.messages[0].id : null;
    state.loading = true;
    $("older").disabled = true;
    try {
      const data = await api(historyPath(v, before));
      if (seq !== state.loadSeq) return; // view changed meanwhile
      const got = data.messages || [];
      if (older) {
        const batch = got.filter((m) => !state.ids.has(m.id));
        const feed = $("feed");
        const fromBottom = feed.scrollHeight - feed.scrollTop;
        state.messages = batch.concat(state.messages);
        batch.forEach((m) => state.ids.add(m.id));
        renderMessages();
        feed.scrollTop = feed.scrollHeight - fromBottom;
      } else {
        state.messages = got;
        state.ids = new Set(got.map((m) => m.id));
        renderMessages();
        scrollToBottom();
      }
      $("older").hidden = got.length < PAGE;
    } catch (err) {
      if (seq !== state.loadSeq) return;
      if (err instanceof HttpError && err.status === 403 && !isAdmin()) {
        // e.g. removed from the room elsewhere: refresh and pick another view
        loadOverview().then(() => go({ kind: "home" })).catch((e) => handleError(e, "Оновлення"));
        return;
      }
      handleError(err, "Завантаження повідомлень");
    } finally {
      if (seq === state.loadSeq) { state.loading = false; $("older").disabled = false; }
    }
  }

  function kindOf(name) {
    const a = state.overview.agents.find((x) => x.name === name);
    return a ? a.kind : null;
  }

  function canReply() {
    return isAdmin() ? humans().length > 0 : true;
  }

  function renderMessage(m) {
    const li = el("li", "msg");
    li.id = `m${m.id}`;
    const mine = isAdmin() ? kindOf(m.from) === "human" : m.from === state.me.name;
    if (mine) li.classList.add("mine");

    const head = el("div", "msg-head");
    head.append(el("span", "msg-from", m.from));

    if (state.view.kind === "all") {
      const where = el("a", "msg-where", m.room ? `#${m.room}` : `→ ${m.to}`);
      where.href = m.room ? hashFor({ kind: "room", room: m.room }) : hashFor({ kind: "dm", a: m.from, b: m.to });
      head.append(where);
    } else if (!m.room && isAdmin()) {
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

    if (canReply()) {
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
      note(`Повідомлення #${id} не завантажене в цьому поданні. Спробуйте «Завантажити старіші».`);
      return;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1500);
  }

  function addLiveMessage(m) {
    // The POST response and the WS echo can deliver the same message; count it once.
    if (state.seenLive.has(m.id)) return;
    state.seenLive.add(m.id);

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
        if (nearBottom || m.from === currentAs()) scrollToBottom();
      }
    } else if (!(state.me && m.from === state.me.name)) {
      const key = msgKey(m);
      state.unread.set(key, (state.unread.get(key) || 0) + 1);
    }
    renderSidebar();
  }

  // ---------- WebSocket ----------
  // Admin: observer socket (every message). User: the person's own socket (only their messages).
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

    // A person who is an admin must ask for the observer stream; without it they'd get only their own messages.
    const observer = isAdmin() && state.adminMe && !state.adminMe.root;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: state.token, ...(observer ? { observer: true } : {}) }));

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
          if (wasRetry) loadOverview().then(applyHash).catch((e) => handleError(e, "Оновлення"));
          break;
        }
        case "message":
          if (frame.message) addLiveMessage(frame.message);
          break;
        case "presence": {
          const a = state.overview.agents.find((x) => x.name === frame.agent);
          if (a) { a.online = !!frame.online; renderSidebar(); }
          else loadOverview().catch((e) => handleError(e, "Оновлення агентів"));
          if (state.view.kind === "people") renderPeople();
          if (state.view.kind === "rooms") renderRoomsAdmin();
          break;
        }
        case "rooms": // user: the admin changed my room membership
        case "rooms_changed": // admin observer: rooms or members changed somewhere
          onRoomsChanged();
          break;
        case "error":
          if (!welcomed) { ws.onclose = null; ws.close(); logout(`Брокер відхилив токен: ${frame.error}`); }
          else note(`Брокер: ${frame.error}`, true);
          break;
      }
    };

    ws.onclose = (ev) => {
      if (state.ws !== ws || !state.token) return;
      state.ws = null;
      if (ev.code === 4003) {
        // Access changed by an admin. If the same token still works (e.g. admin rights were removed,
        // so it is now a personal token), log in again in whatever mode it has now.
        const token = state.token;
        const remember = !!store.get(TOKEN_KEY);
        const wasAdmin = isAdmin();
        detectMode(token)
          .then(() => {
            logout("");
            return login(token, remember).then(() => {
              if (wasAdmin && !isAdmin()) {
                state.flash = "Права адміністратора з вас зняли, тепер ви в режимі учасника.";
                applyHash();
              }
            });
          })
          .catch(() => logout("Доступ змінено: токен перевидано або вас видалено з чату. Попросіть у адміністратора новий токен."));
        return;
      }
      state.wsRetry += 1;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(state.wsRetry - 1, 4));
      setConn("", `Немає з'єднання, повтор через ${Math.round(delay / 1000)} с`);
      state.wsTimer = setTimeout(connectWs, delay);
    };
  }

  async function onRoomsChanged() {
    try {
      await loadOverview();
    } catch (err) {
      handleError(err, "Оновлення кімнат");
      return;
    }
    const v = state.view;
    if (!isAdmin() && v.kind === "room" && !myRooms().includes(v.room)) {
      state.flash = `Вас прибрали з кімнати #${v.room}.`; // shown after the view switches
      go({ kind: "home" });
      return;
    }
    if (v.kind === "rooms") loadRoomsAdmin(true);
    if (v.kind === "people") loadPeopleQuiet();
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
    const v = state.view;
    const admin = isAdmin();
    $("as-wrap").hidden = !admin;

    let names = [];
    if (admin) {
      names = humans();
      const asSel = $("as");
      // default sender: the last choice, else the admin themself if they are a person
      const prev = asSel.value || store.get(AS_KEY) || (state.adminMe && !state.adminMe.root ? state.adminMe.name : null);
      asSel.replaceChildren(...names.map((n) => { const o = el("option", null, n); o.value = n; return o; }));
      if (prev && names.includes(prev)) asSel.value = prev;
      asSel.disabled = !names.length;
    }
    const me = currentAs();

    $("to-wrap").hidden = v.kind !== "all";
    if (v.kind === "all") {
      const toSel = $("to");
      const keep = toSel.value;
      const opts = [];
      for (const r of [...state.overview.rooms].sort(byName)) opts.push(`#${r.name}`);
      for (const a of [...state.overview.agents].sort(byName)) if (a.name !== me) opts.push(`@${a.name}`);
      toSel.replaceChildren(...opts.map((t) => { const o = el("option", null, t); o.value = t; return o; }));
      if (keep && opts.includes(keep)) toSel.value = keep;
    }

    let blocked = "";
    if (admin && !names.length) blocked = "Щоб писати з вебу, додайте людину в розділі «Люди».";
    else if (admin && v.kind === "dm" && me !== v.a && me !== v.b) blocked = `${me} не учасник цієї розмови. Оберіть ${v.a} або ${v.b} у полі «Від», якщо це люди, або напишіть з «Усі повідомлення».`;
    $("text").disabled = !!blocked;
    $("send").disabled = !!blocked;
    if (blocked) note(blocked);
    else if ($("composer-note").textContent && !$("composer-note").classList.contains("error")) note("");
  }

  function target() {
    const v = state.view;
    if (v.kind === "room") return { room: v.room };
    if (v.kind === "dm") return { to: currentAs() === v.a ? v.b : v.a };
    if (v.kind !== "all") return null;
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
    const body = isAdmin() ? { as, ...t, text } : { ...t, text };
    if (state.replyTo) body.reply_to = state.replyTo.id;
    $("send").disabled = true;
    try {
      const data = await api(isAdmin() ? "/admin/api/messages" : "/api/messages", { method: "POST", body: JSON.stringify(body) });
      $("text").value = "";
      setReply(null);
      note("");
      // The admin observer also gets it over WS (ids dedupe); a person's own sends come only from here.
      if (data && data.message) addLiveMessage(data.message);
      scrollToBottom();
    } catch (err) {
      handleError(err, "Не надіслано");
    } finally {
      renderComposer();
    }
  }

  // ---------- settings (admin) ----------
  const SETTINGS_FIELDS = ["maxHops", "ratePerMinute", "maxTextLength"]; // integers with limits
  const TEXT_FIELDS = ["publicUrl", "projectDir"];                        // strings, "" = not set
  const ALL_FIELDS = SETTINGS_FIELDS.concat(TEXT_FIELDS);
  const settingsState = { saved: null, limits: {}, seq: 0, editable: true };
  const savedValue = (name) => String(settingsState.saved[name] ?? "");

  function setStatus(id, text, kind) {
    const s = $(id);
    s.textContent = text || "";
    s.className = `small status ${kind || ""}`;
  }
  const settingsStatus = (text, kind) => setStatus("settings-status", text, kind);

  function fieldInput(name) { return $(`set-${name}`); }

  function setSettingsBusy(busy) {
    const locked = busy || !settingsState.editable;
    for (const name of ALL_FIELDS) fieldInput(name).readOnly = locked;
    $("settings-save").disabled = locked;
    $("settings-reset").disabled = locked;
  }

  function fillSettings(settings) {
    settingsState.saved = { ...settings };
    for (const name of ALL_FIELDS) {
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
      if (err instanceof AuthError) { handleError(err); return; }
      settingsStatus(`Не вдалося завантажити налаштування: ${err.message}`, "error");
    } finally {
      if (seq === settingsState.seq) setSettingsBusy(false);
    }
  }

  // Validates one field; returns { value } or { error }.
  function readField(name) {
    const raw = fieldInput(name).value.trim();
    if (TEXT_FIELDS.includes(name)) {
      if (name === "publicUrl" && raw && !/^https?:\/\/[^\s/]+/.test(raw)) return { error: "publicUrl: адреса має починатися з http:// або https://" };
      return { value: raw };
    }
    const lim = settingsState.limits[name];
    if (!/^-?\d+$/.test(raw)) return { error: `${name}: потрібне ціле число` };
    const value = Number(raw);
    if (lim && (value < lim.min || value > lim.max)) return { error: `${name}: від ${lim.min} до ${lim.max}` };
    return { value };
  }

  function markChanged() {
    if (!settingsState.saved) return;
    for (const name of ALL_FIELDS) {
      const input = fieldInput(name);
      const r = readField(name);
      input.classList.toggle("bad", !!r.error && input.value.trim() !== "");
      input.classList.toggle("changed", savedValue(name) !== input.value.trim());
    }
    settingsStatus("");
  }

  async function saveSettings() {
    if (!settingsState.saved) return;
    const patch = {};
    const errors = [];
    for (const name of ALL_FIELDS) {
      const r = readField(name);
      if (r.error) { errors.push(r.error); fieldInput(name).classList.add("bad"); continue; }
      if (String(r.value) !== savedValue(name)) patch[name] = r.value;
    }
    if (errors.length) { settingsStatus(errors.join("; "), "error"); return; }
    if (!Object.keys(patch).length) { settingsStatus("Змін немає."); return; }

    setSettingsBusy(true);
    settingsStatus("Збереження…");
    try {
      const data = await api("/admin/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
      fillSettings(data.settings || { ...settingsState.saved, ...patch });
      const changed = Object.entries(patch)
        .map(([k, v]) => (typeof v === "string" ? `${k} = ${v ? `«${v}»` : "(не задано)"}` : `${k} = ${v}`))
        .join(", ");
      settingsStatus(`Збережено: ${changed}.`, "ok");
    } catch (err) {
      if (err instanceof AuthError) { handleError(err); return; }
      settingsStatus(`Не збережено: ${err.message}`, "error");
    } finally {
      setSettingsBusy(false);
    }
  }

  // ---------- agents & people (admin) ----------
  const DIR_KEY = "aichat.projectDir";
  const people = { list: [], editable: true, confirm: null, busy: false, seq: 0 };
  const peopleStatus = (text, kind) => setStatus("people-status", text, kind);
  const KIND_LABEL = { human: "людина", claude: "Claude Code", openai: "OpenAI" };

  async function loadPeople() {
    const seq = ++people.seq;
    people.confirm = null;
    peopleStatus("Завантаження…");
    try {
      const [agents, settings] = await Promise.all([api("/admin/api/agents"), api("/admin/api/settings")]);
      if (seq !== people.seq) return;
      people.list = agents.agents || [];
      people.editable = settings.editable !== false;
      peopleStatus(people.editable ? "" : "Цей брокер запущено без файлу конфігурації, тому список змінювати не можна.");
      renderPeople();
    } catch (err) {
      if (seq !== people.seq) return;
      if (err instanceof AuthError) { handleError(err); return; }
      peopleStatus(`Не вдалося завантажити список: ${err.message}`, "error");
    }
  }

  async function loadPeopleQuiet() {
    try {
      const data = await api("/admin/api/agents");
      people.list = data.agents || [];
    } catch { /* keep the old list */ }
    renderPeople();
  }

  function smallButton(text, cls, onClick, disabled) {
    const b = el("button", cls, text);
    b.type = "button";
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderPeople() {
    // keep online status in sync with presence frames
    const online = new Map(state.overview.agents.map((a) => [a.name, a.online]));
    const rows = $("people-rows");
    rows.replaceChildren();
    const list = [...people.list].sort((x, y) => ((x.kind === "human") === (y.kind === "human") ? byName(x, y) : x.kind === "human" ? -1 : 1));
    const locked = !people.editable || people.busy;
    for (const a of list) {
      const tr = el("tr");
      const nameCell = el("td");
      nameCell.append(el("strong", null, a.name));
      if (a.admin) nameCell.append(el("span", "admin-badge", "АДМІН"));
      if (state.adminMe && !state.adminMe.root && state.adminMe.name === a.name) nameCell.append(el("span", "kind", " (ви)"));
      if (a.description) nameCell.append(el("span", "desc", a.description));
      if (a.webhook) nameCell.append(el("span", "desc", "webhook"));
      tr.append(nameCell);
      tr.append(el("td", "muted", KIND_LABEL[a.kind] || a.kind));
      tr.append(el("td", null, (a.rooms || []).map((r) => "#" + r).join(", ") || "—"));
      const isOn = online.has(a.name) ? online.get(a.name) : a.online;
      const st = el("td");
      st.append(el("span", isOn ? "dot on" : "dot"), document.createTextNode(isOn ? " онлайн" : " офлайн"));
      tr.append(st);

      const actions = el("td", "row-actions");
      if (people.confirm && people.confirm.name === a.name) {
        const action = people.confirm.action;
        const isMe = state.adminMe && state.adminMe.name === a.name && !state.adminMe.root;
        const what = {
          delete: `Видалити ${a.name}? Історія лишиться, але підключитися буде неможливо.${isMe ? " Це ваш обліковий запис: вас одразу вилогінить." : ""}`,
          rotate: `Перевидати токен ${a.name}? Старий перестане працювати, відкриті з'єднання закриються${a.kind === "human" ? "" : ", агента треба буде перезапустити з новим токеном"}.`,
          grant: `Зробити ${a.name} адміном? Зі своїм токеном ${a.name} бачитиме всю переписку, зможе писати від імені будь-якої людини, керувати агентами, кімнатами й налаштуваннями.`,
          revoke: isMe
            ? "Зняти права адміна із себе? Ви одразу перейдете в режим учасника."
            : `Зняти права адміна з ${a.name}? Відкриті адмін-сесії ${a.name} закриються.`,
        }[action];
        const run = { delete: removePerson, rotate: rotateToken, grant: (n) => setAdmin(n, true), revoke: (n) => setAdmin(n, false) }[action];
        actions.append(el("span", "small", what + " "));
        actions.append(
          smallButton("Так", action === "delete" || action === "grant" ? "danger" : "", () => run(a.name), people.busy),
          smallButton("Ні", "secondary", () => { people.confirm = null; renderPeople(); }),
        );
      } else {
        const ask = (action) => () => { people.confirm = { name: a.name, action }; renderPeople(); };
        if (a.kind === "human") {
          actions.append(a.admin
            ? smallButton("Зняти адміна", "secondary", ask("revoke"), locked)
            : smallButton("Зробити адміном", "secondary", ask("grant"), locked));
        }
        actions.append(
          smallButton("Інструкція", "secondary", () => showSavedSetup(a.name)),
          smallButton("Новий токен", "secondary", () => { people.confirm = { name: a.name, action: "rotate" }; renderPeople(); }, locked),
          smallButton("Видалити", "danger", () => { people.confirm = { name: a.name, action: "delete" }; renderPeople(); }, locked),
        );
      }
      tr.append(actions);
      rows.append(tr);
    }
    for (const id of ["people-name", "people-kind", "people-custom", "people-webhook", "people-desc", "people-rooms", "people-add"]) {
      $(id).disabled = locked;
    }
  }

  function syncKindFields() {
    const kind = $("people-kind").value;
    $("people-custom-wrap").hidden = kind !== "other";
    $("people-webhook-wrap").hidden = kind === "human" || kind === "claude";
  }

  // ---- setup instructions ----
  let currentSetup = null; // { title, setup, fresh }

  function showSetup(title, setup, fresh) {
    currentSetup = { title, setup, fresh };
    $("setup-title").textContent = title;
    $("setup-warning").hidden = !fresh;
    const needsDir = (setup.steps || []).some((s) => (s.code || "").includes("<AICHAT_DIR>") || (s.text || "").includes("<AICHAT_DIR>"));
    $("setup-dir-wrap").hidden = !needsDir;
    if (needsDir && !$("setup-dir").value) $("setup-dir").value = store.get(DIR_KEY) || "";
    renderSetupSteps();
    $("setup-box").hidden = false;
    $("people").scrollTop = 0;
  }

  // Replace <AICHAT_DIR> with the folder typed in the browser. JSON needs forward slashes.
  function withDir(text) {
    const dir = $("setup-dir").value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return dir ? text.split("<AICHAT_DIR>").join(dir) : text;
  }

  function renderSetupSteps() {
    const list = $("setup-steps");
    list.replaceChildren();
    if (!currentSetup) return;
    for (const step of currentSetup.setup.steps || []) {
      const li = el("li");
      if (step.title) li.append(el("h3", null, step.title));
      if (step.text) li.append(el("p", "small", withDir(step.text)));
      const dl = step.download || (step.url ? { url: step.url } : null);
      if (dl && dl.url) {
        const filename = dl.filename || dl.url.split("/").pop();
        const a = el("a", "button", `⬇ Завантажити ${filename}`);
        a.href = dl.url;
        a.download = filename;
        a.title = dl.url;
        li.append(a);
      }
      if (step.code) {
        const code = withDir(step.code);
        if (step.lang) li.append(el("div", "code-lang", step.lang));
        const wrap = el("div", "code-wrap");
        const pre = el("pre");
        pre.append(el("code", null, code));
        const copy = smallButton("Копіювати", "copy", () => copyText(code, copy));
        wrap.append(pre, copy);
        li.append(wrap);
      }
      list.append(li);
    }
  }

  function hideSetup() {
    currentSetup = null;
    $("setup-box").hidden = true;
    $("setup-steps").replaceChildren();
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* user can copy manually */ }
      ta.remove();
    }
    const old = button.textContent;
    button.textContent = "Скопійовано ✓";
    setTimeout(() => { button.textContent = old; }, 1500);
  }

  async function showSavedSetup(name) {
    try {
      const data = await api(`/admin/api/agents/${encodeURIComponent(name)}/setup`);
      showSetup(`Як підключити ${name}`, data.setup || { steps: [] }, false);
      peopleStatus("Токен тут замінено на <TOKEN>. Якщо токен загубився, натисніть «Новий токен».");
    } catch (err) {
      if (err instanceof AuthError) { handleError(err); return; }
      peopleStatus(`Не вдалося отримати інструкцію: ${err.message}`, "error");
    }
  }

  async function peopleAction(fn, okText) {
    people.busy = true;
    renderPeople();
    try {
      await fn();
      peopleStatus(okText, "ok");
    } catch (err) {
      if (err instanceof AuthError) { handleError(err); return; }
      peopleStatus(`Помилка: ${err.message}`, "error");
    } finally {
      people.busy = false;
      people.confirm = null;
      await loadPeopleQuiet();
      loadOverview().catch(() => { /* sidebar refresh is best effort */ });
    }
  }

  function parseRooms(text) {
    return text.split(/[\s,]+/).map((r) => r.replace(/^#/, "")).filter(Boolean);
  }

  function addPerson() {
    const name = $("people-name").value.trim();
    const sel = $("people-kind").value;
    const kind = sel === "other" ? $("people-custom").value.trim() : sel;
    const description = $("people-desc").value.trim();
    const webhook = $("people-webhook-wrap").hidden ? "" : $("people-webhook").value.trim();
    const rooms = parseRooms($("people-rooms").value);
    if (!ROOM_RE.test(name)) { peopleStatus("Ім'я: латиниця, цифри, - і _ (до 64 символів).", "error"); return; }
    if (!ROOM_RE.test(kind)) { peopleStatus("Назва типу: латиниця, цифри, - і _.", "error"); return; }
    if (webhook && !/^https?:\/\/\S+$/.test(webhook)) { peopleStatus("Webhook має бути адресою http:// або https://", "error"); return; }
    const badRoom = rooms.find((r) => !ROOM_RE.test(r));
    if (badRoom) { peopleStatus(`Погана назва кімнати: ${badRoom}`, "error"); return; }
    const body = { name, kind, rooms };
    if (description) body.description = description;
    if (webhook) body.webhook = webhook;
    return peopleAction(async () => {
      const data = await api("/admin/api/agents", { method: "POST", body: JSON.stringify(body) });
      $("people-form").reset();
      syncKindFields();
      const who = data.agent ? data.agent.name : name;
      showSetup(kind === "human" ? `Вхід для ${who}` : `Як запустити ${who}`, data.setup || { steps: [] }, true);
    }, `Додано: ${name}.`);
  }

  function rotateToken(name) {
    return peopleAction(async () => {
      const data = await api(`/admin/api/agents/${encodeURIComponent(name)}/token`, { method: "POST" });
      showSetup(`Новий токен для ${name}`, data.setup || { steps: [{ title: "Токен", code: data.token }] }, true);
    }, `Токен ${name} перевидано.`);
  }

  function setAdmin(name, admin) {
    const self = state.adminMe && !state.adminMe.root && state.adminMe.name === name;
    if (self && !admin) {
      // Losing admin rights: the same token still works as a personal one, so log in again in user mode.
      people.busy = true;
      renderPeople();
      api(`/admin/api/agents/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ admin: false }) })
        .then(() => { const t = state.token; const keep = !!store.get(TOKEN_KEY); logout(""); return login(t, keep); })
        .catch((err) => { people.busy = false; handleError(err, "Не вдалося"); renderPeople(); });
      return;
    }
    return peopleAction(
      () => api(`/admin/api/agents/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ admin }) }),
      admin ? `${name} тепер адмін.` : `${name} більше не адмін.`,
    );
  }

  function removePerson(name) {
    return peopleAction(async () => {
      await api(`/admin/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
      hideSetup();
    }, `Видалено: ${name}.`);
  }

  // ---------- rooms (admin) ----------
  const roomsAdmin = { list: [], agents: [], confirm: null, busy: false, seq: 0 };
  const roomsStatus = (text, kind) => setStatus("rooms-status", text, kind);

  async function loadRoomsAdmin(quiet) {
    const seq = ++roomsAdmin.seq;
    if (!quiet) { roomsAdmin.confirm = null; roomsStatus("Завантаження…"); }
    try {
      const [rooms, agents] = await Promise.all([api("/admin/api/rooms"), api("/admin/api/agents")]);
      if (seq !== roomsAdmin.seq) return;
      roomsAdmin.list = rooms.rooms || [];
      roomsAdmin.agents = agents.agents || [];
      if (!quiet) roomsStatus("");
      renderRoomsAdmin();
    } catch (err) {
      if (seq !== roomsAdmin.seq) return;
      if (err instanceof AuthError) { handleError(err); return; }
      roomsStatus(`Не вдалося завантажити кімнати: ${err.message}`, "error");
    }
  }

  function agentKind(name) {
    const a = roomsAdmin.agents.find((x) => x.name === name);
    return a ? KIND_LABEL[a.kind] || a.kind : "";
  }

  function renderMemberPicker() {
    const box = $("room-members-pick");
    const checked = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value));
    box.replaceChildren();
    for (const a of [...roomsAdmin.agents].sort(byName)) {
      const label = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = a.name;
      cb.checked = checked.has(a.name);
      label.append(cb, document.createTextNode(a.name), el("span", "kind", KIND_LABEL[a.kind] || a.kind));
      box.append(label);
    }
    if (!roomsAdmin.agents.length) box.append(el("span", "muted small", "немає агентів"));
  }

  function renderRoomsAdmin() {
    renderMemberPicker();
    const cards = $("room-cards");
    cards.replaceChildren();
    const busy = roomsAdmin.busy;
    for (const r of [...roomsAdmin.list].sort(byName)) {
      const card = el("div", "room-card");
      const head = el("div", "room-card-head");
      const link = el("a", null, `#${r.name}`);
      link.href = hashFor({ kind: "room", room: r.name });
      head.append(link, el("span", "muted small", `${r.count || 0} повідомл.${r.last_ts ? ` · останнє ${fmtTime(r.last_ts)}` : ""}`));
      card.append(head);

      const chips = el("div", "chips");
      for (const m of [...(r.members || [])].sort()) {
        const chip = el("span", "chip");
        chip.append(document.createTextNode(m));
        const k = agentKind(m);
        if (k) chip.append(el("span", "kind", k));
        const x = smallButton("×", "", () => removeMember(r.name, m), busy);
        x.title = `Прибрати ${m} з #${r.name}`;
        x.setAttribute("aria-label", x.title);
        chip.append(x);
        chips.append(chip);
      }
      if (!(r.members || []).length) chips.append(el("span", "muted small", "учасників немає"));
      card.append(chips);

      const notIn = roomsAdmin.agents.map((a) => a.name).filter((n) => !(r.members || []).includes(n)).sort();
      if (notIn.length) {
        const add = el("div", "room-add");
        const sel = el("select");
        sel.setAttribute("aria-label", `Додати до #${r.name}`);
        for (const n of notIn) {
          const o = el("option", null, `${n} (${agentKind(n)})`);
          o.value = n;
          sel.append(o);
        }
        add.append(sel, smallButton("Додати", "", () => addMember(r.name, sel.value), busy));
        card.append(add);
      }

      if (roomsAdmin.confirm === r.name) {
        const box = el("div", "confirm-box");
        box.append(el("span", null, `Що зробити з #${r.name}?`));
        const acts = el("div", "actions");
        acts.append(
          smallButton("Прибрати всіх учасників (історія лишиться)", "secondary", () => deleteRoom(r.name, false), busy),
          smallButton("Видалити разом з повідомленнями", "danger", () => deleteRoom(r.name, true), busy),
          smallButton("Скасувати", "link", () => { roomsAdmin.confirm = null; renderRoomsAdmin(); }),
        );
        box.append(acts);
        card.append(box);
      } else {
        const acts = el("div", "actions");
        acts.append(smallButton("Видалити кімнату…", "danger", () => { roomsAdmin.confirm = r.name; renderRoomsAdmin(); }, busy));
        card.append(acts);
      }
      cards.append(card);
    }
    if (!roomsAdmin.list.length) cards.append(el("p", "muted", "Кімнат поки немає."));
    $("room-name").disabled = busy;
    $("room-add").disabled = busy;
  }

  async function roomsAction(fn, okText) {
    roomsAdmin.busy = true;
    renderRoomsAdmin();
    try {
      await fn();
      roomsStatus(okText, "ok");
    } catch (err) {
      if (err instanceof AuthError) { handleError(err); return; }
      roomsStatus(`Помилка: ${err.message}`, "error");
    } finally {
      roomsAdmin.busy = false;
      roomsAdmin.confirm = null;
      await loadRoomsAdmin(true);
      loadOverview().catch(() => { /* sidebar refresh is best effort */ });
    }
  }

  function createRoom() {
    const name = $("room-name").value.trim().replace(/^#/, "");
    if (!ROOM_RE.test(name)) { roomsStatus("Назва: латиниця, цифри, - і _ (до 64 символів).", "error"); return; }
    const members = [...$("room-members-pick").querySelectorAll("input:checked")].map((i) => i.value);
    return roomsAction(async () => {
      await api("/admin/api/rooms", { method: "POST", body: JSON.stringify(members.length ? { name, members } : { name }) });
      $("room-name").value = "";
      for (const cb of $("room-members-pick").querySelectorAll("input:checked")) cb.checked = false;
    }, `Кімнату #${name} створено${members.length ? ` з учасниками: ${members.join(", ")}` : ""}.`);
  }

  const memberPath = (room, name) => `/admin/api/rooms/${encodeURIComponent(room)}/members${name ? `/${encodeURIComponent(name)}` : ""}`;

  function addMember(room, name) {
    if (!name) return;
    return roomsAction(
      () => api(memberPath(room), { method: "POST", body: JSON.stringify({ name }) }),
      `${name} додано до #${room}.`,
    );
  }

  function removeMember(room, name) {
    return roomsAction(
      () => api(memberPath(room, name), { method: "DELETE" }),
      `${name} прибрано з #${room}.`,
    );
  }

  function deleteRoom(room, withMessages) {
    return roomsAction(
      () => api(`/admin/api/rooms/${encodeURIComponent(room)}${withMessages ? "?messages=1" : ""}`, { method: "DELETE" }),
      withMessages ? `Кімнату #${room} видалено разом з повідомленнями.` : `З #${room} прибрано всіх учасників, історія лишилась.`,
    );
  }

  // ---------- wiring ----------
  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("login-token").value.trim();
    if (token) login(token, $("login-remember").checked);
  });
  $("logout").addEventListener("click", () => logout(""));
  for (const name of ADMIN_VIEWS.concat("all")) {
    document.querySelector(`[data-view="${name}"]`).addEventListener("click", () => go({ kind: name }));
  }
  $("menu").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("older").addEventListener("click", () => { if (!state.loading) loadMessages(true); });
  $("reply-cancel").addEventListener("click", () => setReply(null));
  $("as").addEventListener("change", () => { store.set(AS_KEY, $("as").value); renderComposer(); renderSidebar(); });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("join-name").value.trim().replace(/^#/, "");
    if (name) { $("join-name").value = ""; joinRoom(name); }
  });
  $("leave-room").addEventListener("click", () => { if (state.view.kind === "room") leaveRoom(state.view.room); });
  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });
  $("settings-form").addEventListener("input", markChanged);
  $("settings-reset").addEventListener("click", () => {
    if (settingsState.saved) { fillSettings(settingsState.saved); settingsStatus(""); }
  });
  $("people-form").addEventListener("submit", (e) => { e.preventDefault(); addPerson(); });
  $("people-kind").addEventListener("change", syncKindFields);
  $("setup-close").addEventListener("click", hideSetup);
  $("setup-dir").addEventListener("input", () => { store.set(DIR_KEY, $("setup-dir").value.trim()); renderSetupSteps(); });
  $("room-form").addEventListener("submit", (e) => { e.preventDefault(); createRoom(); });
  window.addEventListener("hashchange", applyHash);

  const saved = store.get(TOKEN_KEY) || store.get(OLD_TOKEN_KEY);
  if (saved) login(saved, true); else showLogin("");
})();
