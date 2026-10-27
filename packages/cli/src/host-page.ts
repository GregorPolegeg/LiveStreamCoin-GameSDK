/**
 * The dev host page (GET /): one iframe per player, side by side, each playing the role of
 * the VIBES host for its game: it answers the SDK's {vibes:1,type:'ready'} with a Context.
 */
export function hostPage(cfg: { name: string; modes: string[]; min: number; max: number }): string {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(cfg.name)} · vibes-games dev</title>
<style>
  :root { color-scheme: dark; --bg: #0e0f13; --panel: #171920; --line: #2a2d38; --text: #e8e9ee; --dim: #8b8fa3; --accent: #8b5cf6; --bad: #ef4444; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header b { font-size: 15px; }
  .dim { color: var(--dim); }
  button, select { font: inherit; color: var(--text); background: #232633; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  button:hover { filter: brightness(1.15); }
  #error { margin: 12px 16px 0; padding: 10px 12px; border: 1px solid var(--bad); border-radius: 8px; background: #2a1215; }
  #error pre { margin: 6px 0 0; white-space: pre-wrap; font: 12px/1.4 ui-monospace, Menlo, monospace; }
  main { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; }
  .player { display: flex; flex-direction: column; gap: 6px; }
  .bar { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .bar .who { font-weight: 600; }
  .bar .controls { display: flex; gap: 6px; align-items: center; }
  .bar .net { font-size: 12px; }
  iframe { width: 360px; height: 640px; max-width: calc(100vw - 32px); border: 1px solid var(--line); border-radius: 12px; background: #000; }
</style>
</head>
<body>
<header>
  <b id="title"></b><span class="dim">vibes-games dev</span>
  <button id="new" class="primary">New game</button>
  <label>Mode <select id="mode"></select></label>
  <label>Players <select id="players"></select></label>
  <span id="info" class="dim"></span>
</header>
<div id="error" hidden><b>Build failed</b> <span class="dim">(fix the file and save; the last good build keeps running)</span><pre></pre></div>
<main id="grid"></main>
<script>
(() => {
  const CFG = ${json};
  const $ = (id) => document.getElementById(id);
  let current = null;
  let panels = [];
  let version = 0;

  $('title').textContent = CFG.name;
  for (const m of CFG.modes) $('mode').append(new Option(m, m));
  for (let n = CFG.min; n <= CFG.max; n++) $('players').append(new Option(String(n), String(n)));

  // The Context each iframe gets, exactly what the VIBES host gives a game.
  const contextFor = (p) => ({
    sessionId: current.sessionId, dmId: 'dev-dm', mode: current.mode, flags: {},
    me: { userId: p.userId, displayName: p.displayName }, role: 'player', platform: 'dev', locale: 'en', theme: 'dark',
    play: { url: 'ws://' + location.host + '/s/' + current.sessionId, token: p.token },
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const panel = panels.find((p) => p.iframe.contentWindow === e.source);
    if (!panel) return;
    let m;
    try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!m || m.vibes !== 1) return;
    if (m.type === 'ready') {
      e.source.postMessage(JSON.stringify({ vibes: 1, type: 'context', context: contextFor(panel.player) }), location.origin);
      panel.net.textContent = 'connected to host';
    } else if (m.type === 'close') {
      panel.net.textContent = 'game closed';
    }
  });

  const gameUrl = (p) => '/game/index.html?as=' + encodeURIComponent(p.userId) + '&v=' + (++version);

  function render() {
    const grid = $('grid');
    grid.textContent = '';
    panels = current.players.map((player) => {
      const box = document.createElement('section'); box.className = 'player';
      const bar = document.createElement('div'); bar.className = 'bar';
      const who = document.createElement('span'); who.className = 'who'; who.textContent = player.displayName + ' (' + player.userId + ')';
      const controls = document.createElement('span'); controls.className = 'controls';
      const net = document.createElement('span'); net.className = 'net dim';
      const secs = document.createElement('select');
      for (const s of [0, 3, 10, 30, 60]) secs.append(new Option(s ? 'offline ' + s + ' s' : 'blip', String(s)));
      secs.value = '3';
      const drop = document.createElement('button'); drop.textContent = 'Drop connection';
      drop.onclick = async () => {
        const r = await fetch('/__dev/drop?ses=' + encodeURIComponent(current.sessionId) + '&user=' + encodeURIComponent(player.userId) + '&sec=' + secs.value, { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        net.textContent = r.ok ? 'dropped ' + (j.closed || 0) + ' socket(s)' : 'drop failed';
      };
      const reload = document.createElement('button'); reload.textContent = 'Reload';
      reload.onclick = () => { iframe.src = gameUrl(player); };
      controls.append(net, secs, drop, reload);
      bar.append(who, controls);
      const iframe = document.createElement('iframe');
      iframe.title = player.displayName;
      iframe.src = gameUrl(player);
      box.append(bar, iframe);
      grid.append(box);
      return { player, iframe, net };
    });
    $('mode').value = current.mode;
    $('players').value = String(current.players.length);
    $('info').textContent = 'session ' + current.sessionId;
  }

  function reloadFrames() { for (const p of panels) p.iframe.src = gameUrl(p.player); }

  function showBuild(b) {
    $('error').hidden = !!b.ok;
    $('error').querySelector('pre').textContent = b.ok ? '' : b.error;
  }

  $('new').onclick = () => fetch('/__dev/new?mode=' + $('mode').value + '&players=' + $('players').value, { method: 'POST' })
    .then((r) => r.json()).then((j) => { if (j.error) showBuild({ ok: false, error: j.error }); });
  $('mode').onchange = $('new').onclick;
  $('players').onchange = $('new').onclick;

  const events = new EventSource('/__dev/events');
  events.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'session') { current = m.session; render(); }
    else if (m.type === 'reload') { if (current) reloadFrames(); }
    else if (m.type === 'build') showBuild(m);
  };

  fetch('/__dev/state').then((r) => r.json()).then((s) => {
    showBuild(s.build);
    if (s.session && (!current || current.sessionId !== s.session.sessionId)) { current = s.session; render(); }
  });
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
