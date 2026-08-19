#!/usr/bin/env node
/**
 * Helix platform smoke test — boots all three planes plus the dev IdP and the
 * portal SPA, then drives them the way a user (or an app) actually would.
 *
 *   node .claude/skills/run-helix/smoke.mjs [options]
 *
 * Exit code 0 = everything the environment supports passed. Anything skipped
 * is reported as SKIP, never folded into the pass count.
 *
 * See ./SKILL.md for prerequisites and the flag reference.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as httpsModule from "node:https";
import * as httpModule from "node:http";
import { launchBrowser, findChrome } from "./cdp.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const CA = join(ROOT, ".devcontainer/certs/caroot/rootCA.pem");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The edge serves https with a mkcert cert. Trust that CA process-wide rather
// than disabling verification, so a genuine TLS regression still fails.
if (existsSync(CA) && !process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_EXTRA_CA_CERTS = CA;
  const r = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

// ── options ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const KEEP = has("--keep");
const NO_BROWSER = has("--no-browser");
const OUT = mkdtempSync(join(tmpdir(), "helix-smoke-"));

const GROUPS = ["idp", "portal", "edge", "egress", "spa", "browser", "cli"];
const wanted = (g) => !only || only === g;

// ── result tracking ───────────────────────────────────────────────────────
const results = [];
let currentGroup = "boot";
function group(g) {
  currentGroup = g;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, ok: true, detail });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  } catch (err) {
    results.push({ group: currentGroup, name, ok: false, detail: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
}
function skip(name, why) {
  results.push({ group: currentGroup, name, skipped: true, detail: why });
  console.log(`  \x1b[33m•\x1b[0m ${name}  \x1b[2mSKIP — ${why}\x1b[0m`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${expected}, got ${actual}`);
}

// ── service lifecycle ─────────────────────────────────────────────────────
// The edge's mkcert cert covers `*.local.helix.azxlabs.io` and the bare base
// domain — NOT `localhost`. Probing it on localhost fails TLS verification even
// though the socket is listening, so always address it by the base domain.
const BASE_DOMAIN = process.env.EDGE_BASE_DOMAIN || "local.helix.azxlabs.io";

const SERVICES = [
  {
    name: "dev-idp",
    script: "dev:idp",
    port: 3002,
    health: "http://localhost:3002/.well-known/openid-configuration",
  },
  { name: "portal", script: "dev:portal", port: 3001, health: "http://localhost:3001/health" },
  { name: "egress", script: "dev:egress", port: 8081, health: "http://localhost:8081/health" },
  { name: "edge", script: "dev:edge", port: 8080, health: `https://${BASE_DOMAIN}:8080/health` },
];
const procs = [];

function freePorts() {
  spawnSync(
    "node",
    [join(ROOT, "scripts/free-port.mjs"), "8080", "8081", "8082", "3001", "3002", "5173"],
    {
      cwd: ROOT,
      stdio: "ignore",
    },
  );
}

function startService(svc) {
  const log = join(OUT, `${svc.name}.log`);
  const fd = openSync(log, "a");
  // detached so we can SIGTERM the whole process group: `pnpm dev:x` spawns
  // tsx as a child and does not forward signals to it.
  const p = spawn("pnpm", [svc.script], { cwd: ROOT, stdio: ["ignore", fd, fd], detached: true });
  procs.push({ ...svc, proc: p, log });
  return p;
}

async function waitHealthy(svc, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no response";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(svc.health);
      if (r.ok) return true;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(500);
  }
  const tail = existsSync(join(OUT, `${svc.name}.log`))
    ? readFileSync(join(OUT, `${svc.name}.log`), "utf8")
        .split("\n")
        .slice(-12)
        .join("\n")
    : "";
  throw new Error(`${svc.name} never became healthy (${lastErr})\n--- log tail ---\n${tail}`);
}

function stopAll() {
  for (const { proc } of procs) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  freePorts();
}

// ── http helpers ──────────────────────────────────────────────────────────
const TOKEN = process.env.PORTAL_DEV_TOKEN;
const auth = { Authorization: `Bearer ${TOKEN}` };
const PORTAL = "http://localhost:3001";
const EDGE = (host, path = "/") => `https://${host}.${BASE_DOMAIN}:8080${path}`;

/**
 * Raw HTTPS request with EXACT header control.
 *
 * Node's global fetch() unconditionally sets `Sec-Fetch-Mode: cors` and
 * silently discards any value you pass for it. The edge's isNavigation()
 * treats that header as authoritative (apps/edge/src/auth/gate.ts), so a
 * top-level navigation is impossible to simulate with fetch() — you always
 * get the 401 subresource branch. node:https sends exactly what you give it.
 */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? httpsModule : httpModule;
    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function jget(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, headers: r.headers, body };
}

// ── the checks ────────────────────────────────────────────────────────────
const throwaway = `smoke-${randomUUID().slice(0, 8)}`;
let createdAppId = null;

async function checkPortal() {
  group("portal");
  console.log("\n\x1b[1mportal\x1b[0m — fastify + Prisma control plane");

  await check("public bootstrap config", async () => {
    const { status, body } = await jget(`${PORTAL}/api/v1/config`);
    eq(status, 200, "status");
    assert(typeof body.appPublicBase === "string", "appPublicBase missing");
    return body.appPublicBase;
  });

  await check("unauthenticated read is rejected", async () => {
    const { status } = await jget(`${PORTAL}/api/v1/apps`);
    eq(status, 401, "status");
  });

  await check("authenticated app list (Prisma read)", async () => {
    const { status, body } = await jget(`${PORTAL}/api/v1/apps`, { headers: auth });
    eq(status, 200, "status");
    assert(Array.isArray(body), "expected an array");
    assert(
      body.every((a) => typeof a.url === "string"),
      "every app must carry a control-plane-computed url",
    );
    return `${body.length} apps`;
  });

  await check("create app (Prisma write)", async () => {
    const { status, body } = await jget(`${PORTAL}/api/v1/apps`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: throwaway,
        displayName: "Smoke Test",
        visibility: { mode: "internal" },
      }),
    });
    eq(status, 201, "status");
    createdAppId = body.id;
    return body.slug;
  });

  await check("read back the created app", async () => {
    const { status, body } = await jget(`${PORTAL}/api/v1/apps/${throwaway}`, { headers: auth });
    eq(status, 200, "status");
    eq(body.slug, throwaway, "slug");
  });

  await check("zod boundary rejects a malformed body", async () => {
    const { status, body } = await jget(`${PORTAL}/api/v1/apps`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "BAD SLUG!!", visibility: { mode: "nonsense" } }),
    });
    eq(status, 400, "status");
    eq(body.error?.code, "validation_failed", "error code");
  });
}

async function checkEdge() {
  group("edge");
  console.log("\n\x1b[1medge\x1b[0m — data/policy plane (https, host routing, session gate)");

  const { body: apps } = await jget(`${PORTAL}/api/v1/apps`, { headers: auth });
  const live = Array.isArray(apps) ? apps.filter((a) => a.currentVersionId) : [];
  const pub = live.find((a) => a.visibility.mode === "public");
  const internal = live.find((a) => a.visibility.mode === "internal");

  await check("health reports registry-projection freshness", async () => {
    const { status, body } = await jget(`https://${BASE_DOMAIN}:8080/health`);
    eq(status, 200, "status");
    const proj = body.checks?.find((c) => c.name === "registry-projection");
    assert(proj, "registry-projection check missing");
    return `${body.status} / projection ${proj.status}`;
  });

  if (!pub) {
    skip("public app is served from Blob", "no live public app in the registry");
    skip("CSP is injected", "no live public app in the registry");
  } else {
    await check("public app is served from Blob", async () => {
      const { status, headers } = await jget(EDGE(pub.slug));
      eq(status, 200, "status");
      assert(headers.get("content-type")?.includes("text/html"), "expected html");
      return pub.slug;
    });
    await check("CSP is injected", async () => {
      const { headers } = await jget(EDGE(pub.slug));
      const csp = headers.get("content-security-policy");
      assert(csp, "no CSP header");
      assert(csp.includes("frame-ancestors 'none'"), "frame-ancestors not locked down");
    });
  }

  if (!internal) {
    skip("session gate: 401 for API-style request", "no live internal app");
    skip("session gate: 302 to auth host for a navigation", "no live internal app");
  } else {
    await check("session gate: 401 for API-style request", async () => {
      const { status } = await jget(EDGE(internal.slug));
      eq(status, 401, "status");
    });
    await check("session gate: 302 to auth host for a navigation", async () => {
      // rawGet, not fetch — see the rawGet docblock for why.
      const r = await rawGet(EDGE(internal.slug), {
        Accept: "text/html,application/xhtml+xml",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      });
      eq(r.status, 302, "status");
      const loc = r.headers.location ?? "";
      assert(loc.startsWith(`https://auth.${BASE_DOMAIN}`), `unexpected redirect target: ${loc}`);
      return new URL(loc).pathname;
    });
  }

  await check("unknown host is 404", async () => {
    const { status } = await jget(EDGE(`no-such-app-${randomUUID().slice(0, 6)}`));
    eq(status, 404, "status");
  });
}

async function checkEgress() {
  group("egress");
  console.log("\n\x1b[1megress\x1b[0m — mechanism plane (attested instruction verification)");

  await check("health is liveness-only", async () => {
    const { status, body } = await jget("http://localhost:8081/health");
    eq(status, 200, "status");
    eq(body.status, "ok", "status field");
    assert(body.checks === undefined, "egress should report liveness only");
  });

  await check("missing instruction headers → 400", async () => {
    const { status, body } = await jget("http://localhost:8081/proxy", { method: "POST" });
    eq(status, 400, "status");
    eq(body.code, "bad_target", "code");
  });

  await check("forged instruction is refused before dialing the target", async () => {
    const { status, body } = await jget("http://localhost:8081/proxy", {
      method: "POST",
      headers: {
        "x-helix-instruction": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.forged",
        // A link-local target: if verification ever regressed, SSRF controls
        // are the only thing left standing. It must never get that far.
        "x-helix-target": "http://169.254.169.254/latest/meta-data/",
        "x-helix-method": "GET",
      },
    });
    eq(status, 401, "status");
    eq(body.code, "forbidden", "code");
  });
}

async function checkIdp() {
  group("idp");
  console.log("\n\x1b[1mdev-idp\x1b[0m — oidc-provider authorization_code + PKCE");

  const IDP = "http://localhost:3002";
  const jar = new Map();
  const putCookies = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  /** Follow redirects by hand so cookies accumulate and we can stop at the callback. */
  async function hop(url, max = 10) {
    let cur = url;
    for (let i = 0; i < max; i++) {
      const r = await fetch(cur, {
        redirect: "manual",
        headers: { Accept: "text/html", ...(jar.size ? { Cookie: cookieHeader() } : {}) },
      });
      putCookies(r);
      const loc = r.headers.get("location");
      if (!loc) return { final: cur, res: r, text: await r.text() };
      cur = new URL(loc, cur).toString();
      if (cur.startsWith(`https://auth.${BASE_DOMAIN}`)) return { final: cur, res: r, text: "" };
    }
    throw new Error("too many redirects");
  }

  let discovery;
  await check("discovery document", async () => {
    const { status, body } = await jget(`${IDP}/.well-known/openid-configuration`);
    eq(status, 200, "status");
    discovery = body;
    assert(body.code_challenge_methods_supported?.includes("S256"), "S256 PKCE not advertised");
    return body.issuer;
  });

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `https://auth.${BASE_DOMAIN}:8080/callback`;
  let code = null;

  await check("authorize → interaction → code", async () => {
    const url =
      `${IDP}/auth?client_id=helix-edge&response_type=code` +
      `&scope=${encodeURIComponent("openid profile email groups")}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=smoke&nonce=${randomUUID()}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const first = await hop(url);
    assert(/pick a user/i.test(first.text), "interaction page did not render the user picker");
    const m = first.text.match(/\?user=([^"]+)"/);
    assert(m, "no fixture user link on the interaction page");
    const done = await hop(`${first.final}?user=${m[1]}`);
    const got = new URL(done.final).searchParams.get("code");
    assert(got, `no authorization code in ${done.final}`);
    code = got;
    return decodeURIComponent(m[1]);
  });

  await check("token exchange yields an ID token with inline groups", async () => {
    assert(code, "no code from the previous step");
    const secret = process.env.IDP_EDGE_CLIENT_SECRET || "edge-dev-secret";
    const r = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`helix-edge:${secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    eq(r.status, 200, "status");
    const tok = await r.json();
    assert(tok.id_token, "no id_token");
    const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
    // The edge never calls userinfo — it reads groups straight off the ID
    // token (Entra-style, conformIdTokenClaims:false). Guard that shape.
    assert(Array.isArray(claims.groups), "groups claim missing from the ID token");
    assert(claims.email, "email claim missing from the ID token");
    return `${claims.email} [${claims.groups.join(", ")}]`;
  });
}

async function checkSpa() {
  group("spa");
  console.log("\n\x1b[1mportal SPA\x1b[0m — vite build, served by the portal");

  await check("vite production build", async () => {
    const r = spawnSync("pnpm", ["--filter", "@azx-pbc/portal-web", "build"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert(r.status === 0, `build failed:\n${(r.stderr || r.stdout || "").slice(-1200)}`);
    const m = (r.stdout || "").match(/(\d+) modules transformed/);
    return m ? `${m[1]} modules` : "built";
  });

  let assets = [];
  await check("portal serves the built index.html", async () => {
    const r = await fetch(`${PORTAL}/`);
    eq(r.status, 200, "status");
    const html = await r.text();
    assert(/<div id="root">/.test(html), "no #root mount point");
    assets = [...html.matchAll(/\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g)].map((m) => m[0]);
    assert(assets.length >= 2, "expected at least a js and a css asset");
    return `${assets.length} hashed assets`;
  });

  await check("hashed assets resolve with correct content types", async () => {
    for (const a of assets) {
      const r = await fetch(PORTAL + a);
      eq(r.status, 200, `status for ${a}`);
      const ct = r.headers.get("content-type") ?? "";
      const want = a.endsWith(".js") ? "javascript" : "css";
      assert(ct.includes(want), `${a} served as ${ct}`);
    }
    return assets.length + " ok";
  });

  await check("SPA deep link falls through to index (client routing)", async () => {
    const r = await fetch(`${PORTAL}/apps/does-not-matter`);
    eq(r.status, 200, "status");
    assert((await r.text()).includes('id="root"'), "deep link did not serve the SPA shell");
  });
}

async function checkBrowser() {
  group("browser");
  console.log("\n\x1b[1mbrowser\x1b[0m — real Chromium over CDP");

  if (NO_BROWSER) return skip("SPA renders in a real browser", "--no-browser");
  if (!findChrome()) {
    return skip("SPA renders in a real browser", "no cached Chromium (set HELIX_SMOKE_CHROME)");
  }

  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    return skip("SPA renders in a real browser", e.message);
  }

  try {
    await check("signed-out shell renders without page errors", async () => {
      browser.reset();
      await browser.navigate(`${PORTAL}/`);
      const kids = await browser.evaluate("document.querySelector('#root')?.children.length ?? -1");
      assert(kids > 0, "#root never mounted (React did not render)");
      assert(browser.errors.length === 0, `page errors: ${browser.errors.slice(0, 3).join(" | ")}`);
      const shot = await browser.screenshot(join(OUT, "signed-out.png"));
      return shot;
    });

    // Seed the per-tab bearer token the SPA reads (apps/portal-web/src/auth/tokenStore.ts)
    // so the authenticated screens render without an interactive IdP login.
    await browser.evaluate(
      `sessionStorage.setItem('azx.portal.token', ${JSON.stringify(JSON.stringify({ token: TOKEN }))})`,
    );

    for (const [name, path] of [
      ["dashboard", "/"],
      ["apps-list", "/apps"],
    ]) {
      await check(`authenticated ${name} renders`, async () => {
        browser.reset();
        await browser.navigate(PORTAL + path);
        const kids = await browser.evaluate(
          "document.querySelector('#root')?.children.length ?? -1",
        );
        assert(kids > 0, "#root never mounted");
        const text = await browser.evaluate("document.body.innerText.replace(/\\s+/g,' ')");
        assert(/My Apps/i.test(text), `chrome did not render the app shell: ${text.slice(0, 120)}`);
        assert(
          browser.errors.length === 0,
          `page errors: ${browser.errors.slice(0, 3).join(" | ")}`,
        );
        assert(
          browser.failedRequests.length === 0,
          `failed requests: ${browser.failedRequests.slice(0, 3).join(" | ")}`,
        );
        await browser.screenshot(join(OUT, `${name}.png`));
        return join(OUT, `${name}.png`);
      });
    }
  } finally {
    browser.close();
  }
}

async function checkCli() {
  group("cli");
  console.log("\n\x1b[1mhelix CLI\x1b[0m — esbuild bundle driven against the live portal");

  await check("esbuild bundle", async () => {
    const r = spawnSync("pnpm", ["--filter", "@azx-pbc/helix-cli", "build"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert(r.status === 0, `build failed:\n${(r.stderr || r.stdout || "").slice(-800)}`);
    const m = (r.stdout || "").match(/dist\/helix\.js\s+([\d.]+\s*\w+)/);
    return m ? m[1] : "built";
  });

  await check("CLI reads versions from the live portal", async () => {
    const { body: apps } = await jget(`${PORTAL}/api/v1/apps`, { headers: auth });
    const target = apps.find((a) => a.currentVersionId);
    assert(target, "no live app to query");
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "packages/cli/dist/helix.js"), "versions", "--slug", target.slug],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, HELIX_PORTAL_URL: PORTAL, HELIX_TOKEN: TOKEN },
      },
    );
    assert(r.status === 0, `cli exited ${r.status}: ${(r.stderr || r.stdout || "").slice(-400)}`);
    assert(/\blive\b/.test(r.stdout), `no live version in output:\n${r.stdout}`);
    return `${target.slug}: ${r.stdout.trim().split("\n").length - 1} versions`;
  });
}

// ── cleanup of the throwaway registry row ─────────────────────────────────
function cleanupThrowaway() {
  if (!createdAppId) return;
  const url = process.env.DATABASE_URL;
  if (!url) return console.log(`\n\x1b[33m! left behind app ${throwaway} (no DATABASE_URL)\x1b[0m`);
  const r = spawnSync(
    "psql",
    [url, "-qtc", `DELETE FROM apps WHERE id='${createdAppId}' AND slug='${throwaway}';`],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) console.log(`\n\x1b[33m! could not remove ${throwaway}: ${r.stderr}\x1b[0m`);
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN) {
    console.error("PORTAL_DEV_TOKEN is not set — run inside the devcontainer.");
    process.exit(2);
  }
  if (only && !GROUPS.includes(only)) {
    console.error(`--only must be one of: ${GROUPS.join(", ")}`);
    process.exit(2);
  }

  console.log(`\x1b[1mHelix smoke test\x1b[0m   artifacts → ${OUT}\n`);
  console.log("booting services…");
  freePorts();
  for (const svc of SERVICES) startService(svc);
  for (const svc of SERVICES) {
    await check(`${svc.name} healthy on :${svc.port}`, () => waitHealthy(svc));
  }

  if (results.some((r) => !r.ok && !r.skipped)) {
    console.error("\n\x1b[31mservices did not come up — aborting\x1b[0m");
  } else {
    try {
      if (wanted("idp")) await checkIdp();
      if (wanted("portal")) await checkPortal();
      if (wanted("edge")) await checkEdge();
      if (wanted("egress")) await checkEgress();
      if (wanted("spa")) await checkSpa();
      if (wanted("browser")) await checkBrowser();
      if (wanted("cli")) await checkCli();
    } finally {
      cleanupThrowaway();
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`\x1b[1m${passed} passed\x1b[0m, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length) {
    console.log("\n\x1b[31mfailures:\x1b[0m");
    for (const f of failed) console.log(`  ${f.group}/${f.name}\n    ${f.detail}`);
    console.log(`\nservice logs: ${OUT}/*.log`);
  }

  if (KEEP) {
    console.log(`\n\x1b[2mservices left running (--keep). Stop with:\x1b[0m`);
    console.log(`  node scripts/free-port.mjs 8080 8081 8082 3001 3002 5173`);
  } else {
    stopAll();
  }
  process.exit(failed.length ? 1 : 0);
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

main().catch((e) => {
  console.error("\n\x1b[31mfatal:\x1b[0m", e);
  cleanupThrowaway();
  stopAll();
  process.exit(1);
});
