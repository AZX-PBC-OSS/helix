#!/usr/bin/env node
// free-port.mjs — release a TCP port before a dev server binds it.
//
// Why this exists: the dev servers run under a `pnpm -> sh -> tsx watch -> node`
// chain. When a VS Code background task is stopped, restarted, or the window is
// reloaded, SIGTERM does not propagate down that chain, so the `node server.ts`
// leaf that owns the port is orphaned (reparented to init) and keeps listening.
// The next run then fails with EADDRINUSE. Run as a preflight, this kills the
// stale listener so the bind always succeeds.
//
// Usage: node scripts/free-port.mjs <port> [<port> ...]
// It NEVER fails the dev start: any error (no `ss`, nothing listening, races)
// exits 0. Hand-rolled, no deps — matches the repo's dependency-minimal stance.

import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PIDs listening on `port`, parsed from `ss` (best-effort). */
function listenersOn(port) {
  let out;
  try {
    out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" });
  } catch {
    return []; // ss missing or failed — nothing we can do, let the bind proceed
  }
  const pids = new Set();
  for (const line of out.split("\n")) {
    // columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    // Local address ends in :<port> for 0.0.0.0:P, *:P and [::]:P alike.
    if (local.slice(local.lastIndexOf(":") + 1) !== String(port)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  return [...pids];
}

async function free(port) {
  let pids = listenersOn(port);
  if (pids.length === 0) return;
  console.error(`[free-port] :${port} held by pid(s) ${pids.join(", ")} — terminating`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Give it a moment to release, then escalate to SIGKILL if still bound.
  for (let i = 0; i < 15 && listenersOn(port).length > 0; i++) await sleep(100);
  pids = listenersOn(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (listenersOn(port).length > 0) {
    console.error(`[free-port] :${port} still held after SIGKILL — continuing anyway`);
  }
}

const ports = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
for (const p of ports) await free(p);
