/**
 * The live view page.
 *
 * One self-contained file with no build step, no framework and no external
 * request of any kind, which is the point: a page that fetches a font or a
 * script from somewhere would undo the promise the rest of the tool makes.
 * It subscribes to /events over Server-Sent Events and appends lines.
 */

export const VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>earshot</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0f14;
    --panel: #121821;
    --edge: #1f2937;
    --ink: #e6edf3;
    --muted: #7d8899;
    --live: #34d399;
    --accent: #f59e0b;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 22px;
    background: var(--panel);
    border-bottom: 1px solid var(--edge);
  }
  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--live);
    box-shadow: 0 0 12px var(--live);
    animation: pulse 2s ease-in-out infinite;
  }
  .dot.off { background: var(--muted); box-shadow: none; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
  h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: .12em;
    text-transform: uppercase;
    margin: 0;
  }
  .source { font-size: 13px; color: var(--muted); }
  .spacer { margin-left: auto; }
  .count { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--muted); }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 22px 22px 10px;
    scroll-behavior: smooth;
  }
  .line { margin: 0 0 20px; max-width: 62ch; }
  .line .time {
    display: block;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 3px;
  }
  .line .text { font-size: 22px; line-height: 1.45; }
  .line:last-child .time { color: var(--accent); }
  .empty { color: var(--muted); font-size: 17px; font-style: italic; }
  footer {
    min-height: 42px;
    padding: 11px 22px;
    background: var(--panel);
    border-top: 1px solid var(--edge);
    color: var(--muted);
    font-size: 15px;
    display: flex;
    gap: 16px;
    align-items: center;
  }
  footer .local { margin-left: auto; font-size: 12px; letter-spacing: .06em; }
</style>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <h1>earshot</h1>
    <span class="source" id="source">connecting</span>
    <span class="spacer"></span>
    <span class="count" id="count">0 lines</span>
  </header>
  <main id="log"><div class="empty" id="empty">Listening. Nothing said yet.</div></main>
  <footer>
    <span id="status"></span>
    <span class="local">ALL LOCAL &middot; 127.0.0.1</span>
  </footer>
<script>
(function () {
  var logEl = document.getElementById('log');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var statusEl = document.getElementById('status');
  var sourceEl = document.getElementById('source');
  var dotEl = document.getElementById('dot');
  var lines = 0;

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
  }

  function addLine(line) {
    if (emptyEl && emptyEl.parentNode) emptyEl.remove();
    var stick = atBottom();
    var wrap = document.createElement('div');
    wrap.className = 'line';
    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = line.time;
    var text = document.createElement('span');
    text.className = 'text';
    text.textContent = line.text;
    wrap.appendChild(time);
    wrap.appendChild(text);
    logEl.appendChild(wrap);
    lines++;
    countEl.textContent = lines + (lines === 1 ? ' line' : ' lines');
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  var events = new EventSource('/events');
  events.addEventListener('line', function (ev) { addLine(JSON.parse(ev.data)); });
  events.addEventListener('status', function (ev) {
    var s = JSON.parse(ev.data);
    statusEl.textContent = s.message || '';
    if (s.source) sourceEl.textContent = s.source;
    dotEl.className = s.live ? 'dot' : 'dot off';
  });
  events.onerror = function () {
    dotEl.className = 'dot off';
    statusEl.textContent = 'earshot stopped';
    sourceEl.textContent = 'disconnected';
  };
})();
</script>
</body>
</html>
`;
