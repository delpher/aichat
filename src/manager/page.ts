// The manager's single page: plain HTML and script, no build step. Every value goes in as text, never as HTML.
// Styled with the AIChat web UI design tokens (web/src/styles/tokens.css, base.css, panels.css).
export const PAGE = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Агенти AIChat</title>
<script>
try {
  const t = localStorage.getItem("aichat-manager-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
</script>
<style>
  :root {
    --font: "Inter Variable", "Inter", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
    --mono: "JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace;

    --text-xs: 12px;
    --text-sm: 13px;
    --text-base: 14px;
    --text-md: 16px;
    --text-lg: 20px;
    --weight-regular: 400;
    --weight-medium: 500;
    --weight-strong: 600;
    --leading: 1.5;
    --leading-tight: 1.25;

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;

    --r-sm: 6px;
    --r-md: 10px;
    --r-lg: 14px;
    --r-full: 999px;

    --control-h: 34px;
    --control-h-sm: 28px;
    --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
    --dur-fast: 120ms;
    --dur: 200ms;

    /* light — lavender-tinted neutrals + electric violet accent */
    --bg: #f8f7fc;
    --surface: #ffffff;
    --surface-2: #f2f0fa;
    --side: #f3f1fb;
    --text: #16131f;
    --text-2: #433d57;
    --muted: #625c78;
    --line: #e6e3f2;
    --line-2: #d7d3ea;
    --hover: rgba(40, 24, 110, 0.045);
    --active: #efeaff;

    --accent: #6236ff;
    --accent-hover: #5226ec;
    --on-accent: #ffffff;
    --accent-fg: #6236ff;
    --accent-soft: #ece7ff;
    --accent-soft-fg: #4f22e0;

    --ok: #15803d;
    --bad: #c8312f;
    --warn: #b45309;
    --code-bg: #f4f2fa;

    --av-0: #2563eb;
    --av-1: #7c3aed;
    --av-2: #be185d;
    --av-3: #c2410c;
    --av-4: #a16207;
    --av-5: #15803d;
    --av-6: #0e7490;
    --av-7: #475569;

    --shadow-card: 0 1px 2px rgba(22, 19, 31, 0.04);
    color-scheme: light;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0d0b14;
      --surface: #15121f;
      --surface-2: #1d1929;
      --side: #120f1b;
      --text: #eeebf7;
      --text-2: #bdb6d3;
      --muted: #8f88a8;
      --line: #2a2538;
      --line-2: #362f48;
      --hover: rgba(200, 185, 255, 0.06);
      --active: #251e42;
      --accent: #6a45f5;
      --accent-hover: #5b38e8;
      --on-accent: #ffffff;
      --accent-fg: #b3a1ff;
      --accent-soft: #251d45;
      --accent-soft-fg: #c4b6ff;
      --ok: #4ade80;
      --bad: #f2706c;
      --warn: #e3a33b;
      --code-bg: #120f1b;
      --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.28);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0d0b14;
    --surface: #15121f;
    --surface-2: #1d1929;
    --side: #120f1b;
    --text: #eeebf7;
    --text-2: #bdb6d3;
    --muted: #8f88a8;
    --line: #2a2538;
    --line-2: #362f48;
    --hover: rgba(200, 185, 255, 0.06);
    --active: #251e42;
    --accent: #6a45f5;
    --accent-hover: #5b38e8;
    --on-accent: #ffffff;
    --accent-fg: #b3a1ff;
    --accent-soft: #251d45;
    --accent-soft-fg: #c4b6ff;
    --ok: #4ade80;
    --bad: #f2706c;
    --warn: #e3a33b;
    --code-bg: #120f1b;
    --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.28);
    color-scheme: dark;
  }

  * {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--line-2) transparent;
  }
  html, body {
    margin: 0;
    min-height: 100%;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font: var(--weight-regular) var(--text-base) / var(--leading) var(--font);
    font-feature-settings: "cv11";
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 {
    margin: 0;
    font-weight: var(--weight-strong);
    line-height: var(--leading-tight);
    text-wrap: balance;
  }
  button, input, select {
    font: inherit;
    color: inherit;
  }
  code, pre {
    font-family: var(--mono);
  }
  ::selection {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .muted { color: var(--muted); }
  .small { font-size: var(--text-xs); }
  .num { font-variant-numeric: tabular-nums; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }

  @keyframes rise-in {
    from { opacity: 0; transform: translateY(6px); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes presence-pulse {
    50% {
      box-shadow:
        0 0 0 2px var(--ring, var(--surface)),
        0 0 0 5px color-mix(in srgb, var(--accent) 28%, transparent);
    }
  }
  .spin { animation: spin 0.8s linear infinite; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 1ms !important;
      transition-duration: 1ms !important;
    }
    .spin { animation: spin 0.8s linear infinite !important; }
  }

  /* ---------- top bar ---------- */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .topbar-inner {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-3) var(--space-5);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .brand-mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: var(--r-md);
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 32%, transparent);
  }
  .brand-title {
    min-width: 0;
  }
  .brand-title h1 {
    font-size: var(--text-md);
    letter-spacing: -0.01em;
  }
  .brand-path {
    display: block;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 460px;
  }
  .topbar-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* ---------- page layout ---------- */
  main {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  /* display rules (.inspector is flex) must not override the hidden attribute */
  [hidden] { display: none !important; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-card);
  }

  /* ---------- buttons & inputs ---------- */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--r-md);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast), transform var(--dur-fast);
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--surface-2) 70%, var(--line-2));
  }
  .btn:active:not(:disabled) {
    transform: translateY(1px);
  }
  .btn:disabled {
    opacity: 0.48;
    cursor: default;
  }
  .btn.sm {
    height: var(--control-h-sm);
    padding: 0 10px;
    border-radius: var(--r-sm);
  }
  .btn.primary {
    background: var(--accent);
    color: var(--on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn.soft {
    background: var(--accent-soft);
    color: var(--accent-soft-fg);
  }
  .btn.soft:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 18%, var(--accent-soft));
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--line-2);
    color: var(--text);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--hover);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line-2));
  }
  .btn.quiet {
    background: transparent;
    color: var(--text-2);
  }
  .btn.quiet:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }
  .btn.danger {
    background: var(--bad);
    color: #fff;
  }
  .btn.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bad) 86%, #000);
  }
  .btn.danger-text {
    background: transparent;
    color: var(--bad);
  }
  .btn.danger-text:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--control-h-sm);
    height: var(--control-h-sm);
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line-2));
  }
  .icon-btn.plain {
    border-color: transparent;
  }
  input[type="text"], select {
    height: var(--control-h-sm);
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    background: var(--surface);
    font-size: var(--text-sm);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  input[type="text"]:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
  }
  input[type="text"]::placeholder {
    color: var(--muted);
  }
  input[type="checkbox"] {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--text-2);
    cursor: pointer;
    user-select: none;
  }

  /* ---------- pills & avatars ---------- */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: var(--r-full);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: 18px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .pill.neutral {
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--line);
  }
  .pill.ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--ok);
  }
  .pill.warn {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
  }
  .pill.bad {
    background: color-mix(in srgb, var(--bad) 13%, transparent);
    color: var(--bad);
  }
  .pill.muted-pill {
    background: var(--surface-2);
    color: var(--muted);
  }
  .dot {
    display: inline-block;
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: var(--r-full);
    background: var(--muted);
  }
  .pill.ok .dot, .dot.ok { background: var(--ok); }
  .pill.warn .dot, .dot.warn { background: var(--warn); }
  .pill.bad .dot, .dot.bad { background: var(--bad); }

  .avatar {
    --size: 32px;
    position: relative;
    flex: none;
    width: var(--size);
    height: var(--size);
  }
  .avatar-lg { --size: 42px; }
  .avatar-face {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: 28%;
    background: var(--av, var(--accent));
    color: #fff;
    font-size: calc(var(--size) * 0.37);
    font-weight: var(--weight-strong);
    letter-spacing: -0.02em;
    user-select: none;
  }
  .presence {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border-radius: var(--r-full);
    background: var(--line-2);
    box-shadow: 0 0 0 2px var(--ring, var(--surface));
    transition: background var(--dur);
  }
  .presence.on { background: var(--ok); }
  .presence.busy, .presence.working {
    background: var(--accent);
    animation: presence-pulse 1.2s ease-in-out infinite;
  }
  .presence.waiting { background: var(--warn); }

  /* ---------- agents table ---------- */
  .table-wrap {
    overflow-x: auto;
    border-radius: var(--r-lg);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  thead th {
    padding: 10px 14px;
    text-align: left;
    font-size: 11.5px;
    font-weight: var(--weight-strong);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--side);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  tbody td {
    padding: 12px 14px;
    text-align: left;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
    white-space: nowrap;
    transition: background var(--dur-fast);
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr.pick { cursor: pointer; }
  tbody tr.pick:hover td {
    background: var(--hover);
    --ring: color-mix(in srgb, var(--accent) 4%, var(--surface));
  }
  tbody tr.sel td {
    background: var(--active);
    --ring: var(--active);
  }
  tbody tr.sel td:first-child {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .agent-cell {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-names {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .agent-names strong {
    font-weight: var(--weight-strong);
    color: var(--text);
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }
  .ver-line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .ver-num {
    font-family: var(--mono);
    font-size: 12.5px;
    font-weight: var(--weight-medium);
    font-variant-numeric: tabular-nums;
  }
  .act-text {
    display: block;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .act-busy {
    color: var(--accent-fg);
    font-weight: var(--weight-medium);
  }
  .act-waiting {
    color: var(--warn);
    font-weight: var(--weight-medium);
  }
  .empty-row {
    padding: var(--space-8) var(--space-4) !important;
    text-align: center !important;
    color: var(--muted);
  }

  /* ---------- inspector card ---------- */
  .inspector {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: rise-in var(--dur) var(--ease-out);
  }
  .inspector-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .inspector-who {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .inspector-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .inspector-title h2 {
    font-size: var(--text-lg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inspector-sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .actions-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    align-items: center;
  }
  .action-hint {
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .confirm-inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .msg-banner {
    display: none;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--r-md);
    font-size: var(--text-sm);
    background: var(--surface-2);
    color: var(--text-2);
    animation: rise-in var(--dur-fast) var(--ease-out);
  }
  .msg-banner.show { display: block; }
  .msg-banner.ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--ok);
  }
  .msg-banner.bad {
    background: color-mix(in srgb, var(--bad) 12%, transparent);
    color: var(--bad);
  }

  /* ---------- log panel ---------- */
  .log-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
  .log-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .log-bar-left, .log-bar-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .log-bar strong {
    font-size: var(--text-sm);
    font-weight: var(--weight-strong);
  }
  pre#log-text {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    max-height: 55vh;
    min-height: 110px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--code-bg);
    color: var(--text);
    font: 12px / 1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ---------- removed card ---------- */
  .removed-card {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .removed-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .removed-head h2 { font-size: var(--text-md); }
  ul.removed {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  ul.removed li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  ul.removed li:last-child { border-bottom: 0; }
  ul.removed li span {
    font-family: var(--mono);
    font-size: var(--text-sm);
  }

  @media (max-width: 720px) {
    .topbar-inner { padding: var(--space-3); }
    main { padding: var(--space-4) var(--space-3) var(--space-6); }
    .inspector { padding: var(--space-4); }
    .brand-path { max-width: 240px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand-row">
      <span class="brand-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
          <path d="M9 11.5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5l-4 3.5V20.4a3 3 0 0 1-2-2.9z" fill="currentColor"/>
        </svg>
      </span>
      <div class="brand-title">
        <h1>Агенти AIChat</h1>
        <span class="brand-path" id="root"></span>
      </div>
    </div>
    <div class="topbar-controls">
      <div class="summary" id="summary"></div>
      <span class="muted small num" id="when"></span>
      <button id="refresh" class="btn ghost sm" type="button">
        <svg id="refresh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
        </svg>
        Оновити
      </button>
      <button id="theme-toggle" class="icon-btn" type="button" title="Змінити тему" aria-label="Змінити тему">
        <svg id="theme-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
        </svg>
      </button>
    </div>
  </div>
</header>

<main>
  <section class="card">
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Агент</th><th>Тип</th><th>Адаптер</th><th>У чаті</th><th>Зараз</th><th>Процес</th></tr>
        </thead>
        <tbody id="rows">
          <tr><td colspan="6" class="empty-row">Завантаження…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card inspector" id="logs" hidden>
    <div class="inspector-head">
      <div class="inspector-who">
        <span id="agent-avatar"></span>
        <div class="inspector-title">
          <h2 id="agent-title"></h2>
          <div class="inspector-sub" id="agent-sub"></div>
        </div>
      </div>
      <button id="close-inspector" class="icon-btn plain" type="button" title="Згорнути" aria-label="Згорнути">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="actions-block">
      <div class="actions" id="actions"></div>
      <div class="action-hint" id="action-hint"></div>
    </div>
    <div id="msg" class="msg-banner" role="status" aria-live="polite"></div>
    <div class="log-panel">
      <div class="log-bar">
        <div class="log-bar-left">
          <strong id="logs-title">Лог</strong>
          <select id="log-file"></select>
        </div>
        <div class="log-bar-right">
          <label class="check"><input type="checkbox" id="log-auto" checked> щоразу за 10 с</label>
          <button id="log-refresh" class="btn ghost sm" type="button">Оновити лог</button>
        </div>
      </div>
      <pre id="log-text"></pre>
    </div>
  </section>

  <section class="card removed-card" id="removed-box" hidden>
    <div class="removed-head">
      <h2>Видалені</h2>
      <span class="small muted">Теки лежать в <code>.removed</code>; остаточно стерти їх можна вручну.</span>
    </div>
    <div id="removed-msg" class="msg-banner" role="status" aria-live="polite"></div>
    <ul class="removed" id="removed"></ul>
  </section>
</main>

<script>
const TYPES = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", opencode: "OpenCode" };
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const cmp = (a, b) => { const p = (v) => (v || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0); const [x, y] = [p(a), p(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const ago = (iso) => { if (!iso) return ""; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? s + " с тому" : s < 3600 ? Math.round(s / 60) + " хв тому" : Math.round(s / 3600) + " год тому"; };
let agents = [], selected = null, busy = false, watchTimer = null;

/** Matches web/src/lib/format.ts so every agent keeps the same avatar colour and initials as in AIChat. */
function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
function initials(name) {
  const parts = name.split(/[-_\\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
function avatarEl(a, large) {
  const name = a.name || a.folder;
  const b = a.broker || {};
  const wrap = el("span", null, "avatar" + (large ? " avatar-lg" : ""));
  wrap.style.setProperty("--av", "var(--av-" + (hueFor(name) % 8) + ")");
  wrap.setAttribute("aria-hidden", "true");
  wrap.append(el("span", initials(name), "avatar-face"));
  const state = b.online && b.activity && b.activity.state && b.activity.state !== "idle" ? " " + b.activity.state : "";
  wrap.append(el("span", null, "presence" + (b.online ? " on" : "") + state));
  return wrap;
}

function pill(text, tone, withDot) {
  const s = el("span", text, "pill " + (tone || "neutral"));
  if (withDot) s.prepend(el("span", null, "dot"));
  return s;
}

function isOutdated(a) {
  const b = a.broker || {};
  return Boolean(a.version && b.version && cmp(a.version, b.version) < 0);
}

function adapterCell(a) {
  const td = el("td");
  const box = el("div", null, "stack");
  const b = a.broker || {};
  const line = el("div", null, "ver-line");
  line.append(el("span", a.version || "невідомо", "ver-num"));
  if (isOutdated(a)) line.append(pill("брокер " + b.version + ": оновити", "warn"));
  else if (a.version && b.version) line.append(pill("актуальна", "ok"));
  box.append(line);
  const live = b.adapter && b.adapter.version;
  if (live && live !== a.version) box.append(pill("запущена " + live + ": перезапустіть", "warn"));
  td.append(box);
  return td;
}

/** Where an agent with no process of the manager's lives: what its adapter tells the broker, else what its type suggests. */
function where(a) {
  const surface = a.broker && a.broker.online && a.broker.adapter && a.broker.adapter.surface;
  if (surface === "server") return "на сервері";
  if (surface === "terminal" || a.type === "claude" || a.type === "opencode") return "у терміналі";
  return "—";
}

function renderSummary() {
  const box = $("summary");
  box.replaceChildren();
  if (!agents.length) return;
  const online = agents.filter((a) => a.broker && a.broker.online).length;
  box.append(pill(online + " з " + agents.length + " онлайн", online > 0 ? "ok" : "muted-pill", true));
  const outdated = agents.filter(isOutdated).length;
  if (outdated > 0) box.append(pill("оновити: " + outdated, "warn"));
}

function render() {
  renderSummary();
  const rows = $("rows");
  rows.replaceChildren();
  if (!agents.length) {
    const tr = el("tr");
    const td = el("td", "У цій теці агентів не знайдено.", "empty-row");
    td.colSpan = 6;
    tr.append(td);
    rows.append(tr);
    return;
  }
  for (const a of agents) {
    const tr = el("tr", null, "pick" + (selected === a.folder ? " sel" : ""));
    const who = el("td");
    const cell = el("div", null, "agent-cell");
    cell.append(avatarEl(a, false));
    const names = el("div", null, "agent-names");
    names.append(el("strong", a.name || a.folder));
    if (a.name && a.name !== a.folder) names.append(el("span", a.folder, "small muted"));
    cell.append(names);
    who.append(cell);

    const typeTd = el("td");
    typeTd.append(pill(TYPES[a.type] || a.type, "neutral"));

    tr.append(who, typeTd, adapterCell(a));

    const b = a.broker || {};
    const chat = el("td");
    if (b.error) chat.append(pill("помилка: " + b.error, "bad"));
    else if (b.online === undefined) chat.append(el("span", "—", "muted"));
    else chat.append(pill(b.online ? "онлайн" : "офлайн", b.online ? "ok" : "muted-pill", true));
    tr.append(chat);

    const now = el("td");
    const act = b.activity;
    const nowBox = el("div", null, "stack");
    if (act && act.state) {
      const label = act.state + (act.topic ? ": " + act.topic : "");
      const cls = act.state === "busy" || act.state === "working" ? "act-text act-busy" : act.state === "waiting" ? "act-text act-waiting" : "act-text";
      const sp = el("span", label, cls);
      sp.title = label;
      nowBox.append(sp);
      if (act.since) nowBox.append(el("span", ago(act.since), "small muted num"));
    } else if (a.status && a.status.phase) {
      nowBox.append(el("span", a.status.phase, "muted"));
    } else {
      nowBox.append(el("span", "—", "muted"));
    }
    now.append(nowBox);
    tr.append(now);

    const proc = el("td");
    const procBox = el("div", null, "stack");
    if (a.status && a.status.pid) {
      procBox.append(el("span", (a.status.alive ? "працює" : "не працює") + " · pid " + a.status.pid, "num " + (a.status.alive ? "ok" : "muted")));
    } else {
      procBox.append(el("span", where(a), "muted"));
    }
    const ad = b.online && b.adapter;
    if (ad && ad.start) procBox.append(el("span", ad.start === "resumed" ? "продовжена сесія" : "нова сесія", "small muted"));
    proc.append(procBox);
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

function say(text, cls, id) {
  const m = $(id || "msg");
  m.textContent = text || "";
  m.className = "msg-banner" + (text ? " show" : "") + (cls ? " " + cls : "");
}

async function act(label, path, body) {
  for (const b of $("actions").querySelectorAll("button")) b.disabled = true;
  say(label + "…", "");
  busy = true;
  try { say(await post(path, body), "ok"); } catch (e) { say(e.message, "bad"); }
  busy = false;
  await load();
  if (selected && !agents.some((a) => a.folder === selected)) {
    selected = null;
    $("logs").hidden = true;
  } else if (selected) {
    const a = agents.find((x) => x.folder === selected);
    updateInspectorHeader(a);
    actionsFor(a);
    syncLogFiles(a, false);
  }
  watchSoon();
}

function updateInspectorHeader(a) {
  $("agent-avatar").replaceChildren(avatarEl(a, true));
  $("agent-title").textContent = a.name || a.folder;
  const sub = $("agent-sub");
  sub.replaceChildren();
  const b = a.broker || {};
  const parts = [TYPES[a.type] || a.type];
  if (a.name && a.name !== a.folder) parts.push(a.folder);
  if (a.status && a.status.pid) parts.push((a.status.alive ? "pid " : "зупинено · pid ") + a.status.pid);
  else parts.push(where(a));
  if (b.online && b.adapter && b.adapter.start) parts.push(b.adapter.start === "resumed" ? "продовжена сесія" : "нова сесія");
  sub.append(el("span", parts.join(" · "), "num"));
}

function actionsFor(a) {
  const box = $("actions");
  box.replaceChildren();
  const b = a.broker || {};
  const base = "/api/agents/" + encodeURIComponent(a.folder) + "/";
  const button = (text, fn, cls) => {
    const x = el("button", text, "btn sm " + (cls || "ghost"));
    x.type = "button";
    x.addEventListener("click", fn);
    box.append(x);
    return x;
  };
  const runs = (a.status && a.status.alive) || b.online;
  const bg = a.type === "agy" || a.type === "codex";
  const outdated = isOutdated(a);

  if (!runs) button("Запустити", () => act("Запускаю", base + "start"), "primary");
  if (bg && a.attachPort && a.status && a.status.alive) button("Відкрити сесію", () => act("Відкриваю сесію", base + "session"), "primary");
  if (bg && a.status && a.status.alive) button("Зупинити", () => act("Зупиняю", base + "stop"), "ghost");
  if (b.version) {
    button(
      a.version === b.version ? "Перевстановити адаптер " + b.version : "Оновити адаптер до " + b.version,
      () => act("Оновлюю", base + "update"),
      outdated ? "soft" : "ghost",
    );
  }
  if (!runs) {
    const wrap = el("span", null, "confirm-inline");
    const confirmBox = el("input");
    confirmBox.type = "text";
    confirmBox.placeholder = "назва теки для підтвердження";
    confirmBox.hidden = true;
    const cancel = el("button", "Скасувати", "btn sm quiet");
    cancel.type = "button";
    cancel.hidden = true;
    const del = el("button", "Видалити", "btn sm danger-text");
    del.type = "button";
    const resetConfirm = () => {
      confirmBox.hidden = true;
      confirmBox.value = "";
      cancel.hidden = true;
      del.textContent = "Видалити";
      del.className = "btn sm danger-text";
    };
    cancel.addEventListener("click", resetConfirm);
    confirmBox.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") del.click();
      else if (ev.key === "Escape") resetConfirm();
    });
    del.addEventListener("click", () => {
      if (confirmBox.hidden) {
        confirmBox.hidden = false;
        cancel.hidden = false;
        del.textContent = "Підтвердити видалення";
        del.className = "btn sm danger";
        confirmBox.focus();
        return;
      }
      act("Видаляю", base + "remove", { confirm: confirmBox.value.trim() });
    });
    wrap.append(del, confirmBox, cancel);
    box.append(wrap);
  }

  let hint = "";
  if (a.type === "claude" || a.type === "opencode") {
    hint = !runs
      ? "Відкриється вкладка Windows Terminal."
      : where(a) === "на сервері"
        ? "Працює на своєму сервері: закриття терміналу його не зупиняє."
        : "Працює в терміналі: зупиняється там.";
  } else if (!runs) {
    hint = "Запуститься у фоні, без вікна; вивід піде в лог background.log.";
  } else if (!a.attachPort) {
    hint = "Щоб відкривати сесію, додайте attachPort у aichat.config.json і перезапустіть агента.";
  } else {
    hint = "Сесія відкривається вкладкою терміналу; її закриття агента не зупиняє.";
  }
  $("action-hint").textContent = hint;
}

/** Redraws the selected agent's header and buttons after a refresh, unless an action or deletion confirmation is active. */
function refreshSelected() {
  if (!selected) return;
  const a = agents.find((x) => x.folder === selected);
  if (!a) {
    selected = null;
    $("logs").hidden = true;
    return;
  }
  updateInspectorHeader(a);
  syncLogFiles(a, false);
  if (busy) return;
  const confirming = [...$("actions").querySelectorAll("input")].some((i) => !i.hidden);
  if (!confirming) actionsFor(a);
}

/** A terminal agent comes online in the broker a few seconds after its tab opens: look more often for a while. */
function watchSoon() {
  if (watchTimer) clearInterval(watchTimer);
  let left = 15;
  watchTimer = setInterval(() => {
    load();
    if (--left <= 0) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }, 3000);
}

async function loadRemoved() {
  try {
    const d = await (await fetch("/api/removed")).json();
    const ul = $("removed");
    ul.replaceChildren();
    $("removed-box").hidden = !d.removed.length;
    for (const name of d.removed) {
      const li = el("li");
      li.append(el("span", name));
      const x = el("button", "Повернути", "btn ghost sm");
      x.type = "button";
      x.addEventListener("click", async () => {
        x.disabled = true;
        try {
          say(await post("/api/removed/" + encodeURIComponent(name) + "/restore"), "ok", "removed-msg");
        } catch (e) {
          say(e.message, "bad", "removed-msg");
        }
        load();
      });
      li.append(x);
      ul.append(li);
    }
  } catch {}
}

async function load() {
  const icon = $("refresh-icon");
  icon.classList.add("spin");
  try {
    const r = await fetch("/api/agents");
    if (!r.ok) throw new Error(r.status + " " + (await r.text()));
    const d = await r.json();
    agents = d.agents;
    $("root").textContent = d.root;
    $("when").textContent = "оновлено " + new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    render();
    refreshSelected();
    loadRemoved();
  } catch (e) {
    $("when").textContent = "не вдалося: " + e.message;
  } finally {
    icon.classList.remove("spin");
  }
}

function syncLogFiles(a, forceReload) {
  const sel = $("log-file");
  const prev = forceReload ? "" : sel.value;
  const same = sel.options.length === a.logs.length && [...sel.options].every((o, i) => o.value === a.logs[i]);
  if (!same || forceReload) {
    sel.replaceChildren();
    for (const f of a.logs) sel.append(el("option", f));
    if (prev && a.logs.includes(prev)) sel.value = prev;
  }
  if (!a.logs.length) {
    $("log-text").textContent =
      where(a) === "на сервері"
        ? "Цей агент працює на своєму сервері: локальних файлів логів немає."
        : a.type === "claude" || a.type === "opencode"
          ? "Цей агент працює в терміналі: його вивід там."
          : "Логів немає.";
    sel.hidden = true;
    return;
  }
  sel.hidden = false;
  if (forceReload || !same) showLog();
}

async function select(folder) {
  selected = folder;
  render();
  const a = agents.find((x) => x.folder === folder);
  if (!a) return;
  $("logs").hidden = false;
  $("logs-title").textContent = "Лог";
  say("");
  updateInspectorHeader(a);
  actionsFor(a);
  syncLogFiles(a, true);
}

async function showLog() {
  const file = $("log-file").value;
  if (!selected || !file || $("log-file").hidden) return;
  const r = await fetch("/api/agents/" + encodeURIComponent(selected) + "/logs/" + encodeURIComponent(file) + "?lines=300");
  const d = await r.json();
  const pre = $("log-text");
  // follow the end only when the reader is already there, so scrolling up to read is not undone
  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = d.text || d.error || "(порожньо)";
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

/* ---------- theme toggle ---------- */
function isDarkNow() {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function syncThemeIcon() {
  const dark = isDarkNow();
  const svg = $("theme-icon");
  const ns = "http://www.w3.org/2000/svg";
  svg.replaceChildren();
  if (dark) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "4");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41");
    svg.append(c, p);
    $("theme-toggle").title = "Увімкнути світлу тему";
  } else {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z");
    svg.append(p);
    $("theme-toggle").title = "Увімкнути темну тему";
  }
}
$("theme-toggle").addEventListener("click", () => {
  const next = isDarkNow() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("aichat-manager-theme", next); } catch {}
  syncThemeIcon();
});
syncThemeIcon();

$("close-inspector").addEventListener("click", () => {
  selected = null;
  $("logs").hidden = true;
  render();
});
$("refresh").addEventListener("click", load);
$("log-refresh").addEventListener("click", showLog);
$("log-file").addEventListener("change", showLog);
load();
setInterval(load, 15000);
// the open log follows by itself every 10 s (alexey, AIChat 3157)
setInterval(() => { if ($("log-auto").checked && !document.hidden) showLog(); }, 10000);
</script>
</body>
</html>
`;
