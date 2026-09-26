/**
 * A one-page explorer, served from the gateway entrypoint.
 *
 * It exists because the interesting property of this Worker is invisible in a
 * JSON response: you cannot see a cache working by reading one result. Firing
 * the same call several times and watching `originId` stop changing, while the
 * GitHub rate-limit budget stops falling, is the whole demonstration.
 */

export function explorerPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cached Gatekeeper</title>
<style>
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a19; --mut:#6b6b66; --line:#e3e3df; --acc:#c2410c; --hit:#15803d; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161615; --fg:#ededeb; --mut:#9a9a94; --line:#2e2e2b; --acc:#fb923c; --hit:#4ade80; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2.5rem 1.5rem; background:var(--bg); color:var(--fg);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size:1.4rem; margin:0 0 .25rem; letter-spacing:-.01em; }
p.lede { color:var(--mut); margin:0 0 2rem; max-width:44rem; }
form { display:flex; flex-wrap:wrap; gap:.6rem; align-items:flex-end; margin-bottom:1.5rem; }
label { display:flex; flex-direction:column; gap:.3rem; font-size:.78rem; color:var(--mut); }
input, select { padding:.5rem .6rem; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--fg); font:inherit; font-size:.9rem; }
button { padding:.55rem 1rem; border:0; border-radius:6px; background:var(--acc); color:#fff;
  font:inherit; font-weight:600; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.wrap { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.85rem; }
th, td { text-align:left; padding:.45rem .7rem; border-bottom:1px solid var(--line); white-space:nowrap; }
th { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; color:var(--mut); font-weight:600; }
td.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; }
.hit { color:var(--hit); font-weight:600; }
.miss { color:var(--acc); font-weight:600; }
.note { margin-top:1.5rem; color:var(--mut); font-size:.82rem; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
</style>
</head>
<body>
<main>
<h1>Cached Gatekeeper</h1>
<p class="lede">Fire the same capability call repeatedly. The gatekeeper authorizes every one of them; Workers Cache answers most of them without the GitHub credential ever being used. Watch <code>origin id</code> stop changing and <code>rate limit left</code> stop falling.</p>

<form id="f">
  <label>credential<input id="key" value="demo-key" size="10"></label>
  <label>owner<input id="owner" value="cloudflare" size="12"></label>
  <label>repo<input id="repo" value="cloudflare-os" size="14"></label>
  <label>call<select id="op">
    <option value="repo">getRepo</option>
    <option value="issues">listIssues</option>
    <option value="pulls">listPullRequests</option>
  </select></label>
  <label>times<input id="n" type="number" value="6" min="1" max="25" size="3"></label>
  <button id="go">Run</button>
</form>

<div class="wrap">
<table>
<thead><tr><th>#</th><th>result</th><th>cf-cache-status</th><th>ms</th><th>origin id</th><th>age</th><th>rate limit left</th><th>cache key</th></tr></thead>
<tbody id="rows"></tbody>
</table>
</div>

<p class="note" id="summary"></p>
</main>
<script>
var rows = document.getElementById("rows");
var summary = document.getElementById("summary");

function pathFor(op, owner, repo) {
  if (op === "repo") return "/v1/repos/" + owner + "/" + repo;
  return "/v1/repos/" + owner + "/" + repo + "/" + op;
}

document.getElementById("f").addEventListener("submit", async function (event) {
  event.preventDefault();
  var button = document.getElementById("go");
  button.disabled = true;
  rows.innerHTML = "";
  summary.textContent = "";

  var key = document.getElementById("key").value;
  var owner = document.getElementById("owner").value;
  var repo = document.getElementById("repo").value;
  var op = document.getElementById("op").value;
  var times = Number(document.getElementById("n").value);
  var url = pathFor(op, owner, repo);

  var ids = {};
  var origins = 0;

  for (var i = 1; i <= times; i++) {
    var started = performance.now();
    var response = await fetch(url, { headers: { authorization: "Bearer " + key } });
    var elapsed = Math.round(performance.now() - started);
    var payload = await response.json();
    var meta = payload.cache;
    var tr = document.createElement("tr");

    if (!response.ok || !meta) {
      tr.innerHTML = '<td>' + i + '</td><td colspan="6" class="miss">' +
        (payload.error || response.status) + '</td>';
      rows.appendChild(tr);
      break;
    }

    var fresh = !ids[meta.originId];
    if (fresh) { ids[meta.originId] = true; origins++; }

    tr.innerHTML =
      '<td>' + i + '</td>' +
      '<td class="' + (fresh ? "miss" : "hit") + '">' + (fresh ? "origin fetch" : "cache hit") + '</td>' +
      '<td class="mono">' + (meta.status || "-") + '</td>' +
      '<td class="mono">' + elapsed + '</td>' +
      '<td class="mono">' + meta.originId.slice(0, 8) + '</td>' +
      '<td class="mono">' + Math.round(meta.ageMs / 1000) + 's</td>' +
      '<td class="mono">' + (meta.upstreamRateLimitRemaining === null ? "-" : meta.upstreamRateLimitRemaining) + '</td>' +
      '<td class="mono">' + meta.key + '</td>';
    rows.appendChild(tr);
  }

  if (origins > 0) {
    var note = times + " calls, " + origins + " reached GitHub. " +
      (times - origins) + " were served by Workers Cache without running the credentialed entrypoint.";
    if (times > 1 && origins === times) {
      note += " Every call reached GitHub \u2014 expected under wrangler dev, " +
        "which does not apply Workers Cache. Deploy the Worker to see it work.";
    }
    summary.textContent = note;
  }
  button.disabled = false;
});
</script>
</body>
</html>`;
}
