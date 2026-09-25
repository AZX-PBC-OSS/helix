/**
 * The hosted app's fixture page (arrange): a real HTML document the REAL edge
 * serves from Blob with the platform's connect helper injected under the
 * manifest's `shim.connect` grant. The page's own script is deliberately thin
 * — it drives the documented platform surfaces (window.helix.connect, the
 * /_api/fetch proxy) and reports everything it sees into a #results block the
 * lane asserts on. Nothing here knows the journey's expected outcomes.
 *
 * The `Connect twice` button is the blocked-open journey's real trigger: BOTH
 * helper calls happen synchronously inside one user gesture, and Chromium's
 * real popup blocker allows exactly one popup per gesture — the second
 * window.open returns null (measured under Xvfb with Playwright's
 * popup-blocking default removed; see the README).
 */
export function appPageHtml(opts: { ref: string; vendorIssuer: string }): string {
  const ref = JSON.stringify(opts.ref);
  const vendor = JSON.stringify(opts.vendorIssuer);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane app</title>
</head>
<body>
<main>
  <h1>Lane app</h1>
  <p data-testid="ref">provider ${opts.ref}</p>
  <button type="button" id="connect" data-testid="connect">Connect</button>
  <button type="button" id="connect-twice" data-testid="connect-twice">Connect twice</button>
  <button type="button" id="call" data-testid="call">Call API</button>
  <button type="button" id="forge" data-testid="forge">Forge success</button>
  <pre id="results" data-testid="results"></pre>
</main>
<script>
(function () {
  "use strict";
  var REF = ${ref};
  var VENDOR = ${vendor};

  function out(line) {
    var pre = document.getElementById("results");
    pre.textContent += line + "\\n";
  }
  window.__laneOut = out;

  document.getElementById("connect").addEventListener("click", function () {
    window.helix.connect(REF).then(function (r) { out("RESULT:" + JSON.stringify(r)); });
  });

  document.getElementById("connect-twice").addEventListener("click", function () {
    var first = window.helix.connect(REF);
    first.then(function (r) { out("FIRST:" + JSON.stringify(r)); });
    var second = window.helix.connect(REF);
    second.then(function (r) { out("SECOND:" + JSON.stringify(r)); });
  });

  document.getElementById("call").addEventListener("click", function () {
    fetch("/_api/fetch/" + VENDOR + "/api/echo", { method: "POST" })
      .then(function (res) {
        return res.text().then(function (body) { out("CALL:" + res.status + ":" + body); });
      })
      .catch(function (err) { out("CALL-ERROR:" + String(err)); });
  });

  document.getElementById("forge").addEventListener("click", function () {
    // A perfectly-shaped success notification from the app's own window —
    // exactly what a sibling/forged sender can produce. The helper's receiver
    // rules must discard it (criterion 28): the sender is not the popup.
    window.postMessage({
      source: "helix-connect", version: 1, provider: REF,
      outcome: "connected", reason: null
    }, window.location.origin);
    out("FORGED");
  });
})();
</script>
</body>
</html>
`;
}
