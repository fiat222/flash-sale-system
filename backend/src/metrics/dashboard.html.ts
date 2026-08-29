// Self-contained live dashboard for GET /api/v1/_dashboard. Vanilla JS, no
// build step, no external assets — polls GET /api/v1/_metrics once a second.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flash Sale — Metrics</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d;
           display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: #7d8590; font-size: 12px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #3fb950; margin-right: 6px; vertical-align: middle; }
  .dot.stale { background: #d29922; }
  .dot.down { background: #f85149; }
  main { padding: 24px; display: grid; gap: 16px;
         grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); max-width: 1200px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
             color: #7d8590; margin: 0 0 12px; font-weight: 600; }
  .big { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .sub { color: #7d8590; font-size: 12px; margin-top: 2px; }
  .bar { height: 8px; border-radius: 4px; background: #21262d; overflow: hidden; margin-top: 10px; }
  .bar > span { display: block; height: 100%; background: #3fb950; }
  .row { display: flex; justify-content: space-between; padding: 5px 0;
         border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  .row:last-child { border-bottom: 0; }
  .row .k { color: #7d8590; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
  .pill { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pill.ok { color: #3fb950; } .pill.warn { color: #d29922; } .pill.bad { color: #f85149; }
  code { background: #21262d; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Flash Sale — Metrics</h1>
  <span class="meta"><span id="dot" class="dot"></span><span id="status">connecting…</span></span>
  <span class="meta">refresh 1s · <code>/api/v1/_metrics</code></span>
  <span class="meta" id="ver"></span>
</header>
<main>
  <div class="card">
    <h2>Origin cache hit ratio</h2>
    <div class="big" id="hitpct">–</div>
    <div class="sub" id="hitraw">hit 0 / miss 0 (Redis page cache, post-edge)</div>
    <div class="bar"><span id="hitbar" style="width:0%"></span></div>
  </div>

  <div class="card">
    <h2>Order outcomes</h2>
    <div class="grid2">
      <div><div class="pill ok" id="o_acc">0</div><div class="sub">accepted 202</div></div>
      <div><div class="pill warn" id="o_sold">0</div><div class="sub">sold out 409</div></div>
      <div><div class="pill warn" id="o_dup">0</div><div class="sub">duplicate 409</div></div>
      <div><div class="pill" id="o_tot">0</div><div class="sub">total claims</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Queue (BullMQ)</h2>
    <div class="row"><span class="k">waiting</span><span id="q_wait">0</span></div>
    <div class="row"><span class="k">active</span><span id="q_act">0</span></div>
    <div class="row"><span class="k">delayed</span><span id="q_del">0</span></div>
    <div class="row"><span class="k">completed (window)</span><span id="q_comp">0</span></div>
    <div class="row"><span class="k">failed (window)</span><span id="q_fail">0</span></div>
  </div>

  <div class="card">
    <h2>Lifetime (worker counters)</h2>
    <div class="row"><span class="k">orders_completed</span><span id="l_comp">0</span></div>
    <div class="row"><span class="k">orders_failed</span><span id="l_fail">0</span></div>
  </div>

  <div class="card" id="stockcard">
    <h2>Remaining stock (live, Redis)</h2>
    <div id="stock"></div>
  </div>
</main>

<script>
  var elDot = document.getElementById('dot');
  var elStatus = document.getElementById('status');
  function n(id, v) { document.getElementById(id).textContent = v; }

  async function tick() {
    try {
      var r = await fetch('/api/v1/_metrics', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var m = d.metrics || {}, q = d.queue || {}, s = d.stock || {};

      var hit = m.cache_hit || 0, miss = m.cache_miss || 0, tot = hit + miss;
      var pct = tot ? (hit / tot * 100) : 0;
      n('hitpct', pct.toFixed(2) + '%');
      n('hitraw', 'hit ' + hit + ' / miss ' + miss + ' (Redis page cache, post-edge)');
      document.getElementById('hitbar').style.width = pct.toFixed(1) + '%';

      var acc = m.orders_accepted || 0, sold = m.orders_soldout || 0, dup = m.orders_duplicate || 0;
      n('o_acc', acc); n('o_sold', sold); n('o_dup', dup); n('o_tot', acc + sold + dup);

      n('q_wait', q.waiting || 0); n('q_act', q.active || 0); n('q_del', q.delayed || 0);
      n('q_comp', q.completed || 0); n('q_fail', q.failed || 0);
      n('l_comp', m.orders_completed || 0); n('l_fail', m.orders_failed || 0);

      var ids = Object.keys(s).sort();
      document.getElementById('stock').innerHTML = ids.length
        ? ids.map(function (k) {
            return '<div class="row"><span class="k">' + k + '</span><span>' + s[k] + '</span></div>';
          }).join('')
        : '<div class="sub">no cache:stock:* keys</div>';

      document.getElementById('ver').textContent = 'cache:ver ' + (d.version || '0');
      elDot.className = 'dot';
      elStatus.textContent = 'live · ' + new Date().toLocaleTimeString();
    } catch (e) {
      elDot.className = 'dot down';
      elStatus.textContent = 'error: ' + e.message;
    }
  }
  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>`;
