#!/usr/bin/env node
// audit-report.mjs — turn `pnpm audit` into a report a human will actually read.
//
// Why this exists: `pnpm audit` is a REPORT, not a gate — see the `audit` job in
// .github/workflows/ci.yml for the full reasoning. Advisories are published by
// third parties on their own schedule, with no relation to the commit under
// test. A non-zero exit here would let an overnight CVE against a dependency we
// already run in production block feature work, block rollbacks, and block the
// very deploy that would carry the fix. So this script ALWAYS exits 0 —
// including when the registry is unreachable — and instead spends its effort on
// making the output legible and putting it where someone will see it.
//
// Usage:
//   node scripts/audit-report.mjs     # markdown to stdout
//   pnpm audit:report                 # same, via the root script
//
// In CI, GITHUB_STEP_SUMMARY is set and the markdown is appended there instead,
// leaving a one-line digest plus a ::warning:: annotation on stdout so the
// finding is visible on the run page without the job going red.
//
// `pnpm audit` resolves from pnpm-lock.yaml + the workspace manifests alone — no
// `pnpm install` required, which is what keeps the CI job at ~15s. Hand-rolled,
// no dependencies, matching the repo's dependency-minimal stance.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
const ORDER = ["critical", "high", "moderate", "low", "info"];

/**
 * Run `pnpm audit --json`. Exits non-zero whenever it finds anything, so the
 * status is meaningless here — only whether stdout parsed as JSON matters.
 */
function runAudit() {
  const res = spawnSync("pnpm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { error: `could not run pnpm audit: ${res.error.message}` };
  try {
    const report = JSON.parse(res.stdout);
    // Guard against a false all-clear: run outside the repo (or with the
    // lockfile missing) pnpm happily reports an empty, successful audit. An
    // empty advisory list must mean "audited, found nothing", never "did not
    // audit". Anything else would let this script certify safety it never
    // checked, which is worse than not running at all.
    if (!report?.metadata?.totalDependencies) {
      return { error: "pnpm audit resolved no dependency tree — is pnpm-lock.yaml present?" };
    }
    return { report };
  } catch {
    // Registry unreachable, rate-limited, or pnpm changed its output shape. Not
    // a build problem — say so and move on.
    const detail = (res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" ");
    return { error: `pnpm audit produced no JSON${detail ? ` — ${detail}` : ""}` };
  }
}

/** `apps__portal>@prisma/client>prisma` → `apps/portal`; `.` is the workspace root. */
function ownerOf(path) {
  const first = path.split(">")[0];
  return first === "." ? "(root)" : first.replaceAll("__", "/");
}

/**
 * Highest `>=x.y.z` across an advisory's patched range. `<0.0.0` is npm's way of
 * saying "no patched version exists", which is worth calling out: it is the case
 * where a gate would block you on something you could not have fixed.
 */
function firstPatched(range) {
  if (!range || range === "<0.0.0") return null;
  const versions = [...range.matchAll(/>=\s*(\d+\.\d+\.\d+[^\s|,]*)/g)].map((m) => m[1]);
  if (versions.length === 0) return range;
  return versions.sort(compareVersions).at(-1);
}

function compareVersions(a, b) {
  const parse = (v) => v.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0];
    if (x === y) continue;
    return typeof x === typeof y ? (x < y ? -1 : 1) : typeof x === "number" ? -1 : 1;
  }
  return 0;
}

/** Collapse the advisory list into one row per package — 44 flat rows is unreadable. */
function byPackage(advisories) {
  const packages = new Map();
  for (const advisory of advisories) {
    const findings = advisory.findings ?? [];
    const paths = findings.flatMap((f) => f.paths ?? []);
    const entry = packages.get(advisory.module_name) ?? {
      name: advisory.module_name,
      advisories: [],
      installed: new Set(),
      owners: new Set(),
      patched: [],
      direct: false,
      runtime: false,
      unfixable: false,
    };
    entry.advisories.push(advisory);
    for (const finding of findings) {
      if (finding.version) entry.installed.add(finding.version);
      if (finding.dev === false) entry.runtime = true;
    }
    for (const path of paths) {
      entry.owners.add(ownerOf(path));
      // Two segments (`apps__edge>undici`) means a workspace package depends on
      // it directly — the ones we can actually bump ourselves.
      if (path.split(">").length === 2) entry.direct = true;
    }
    const patched = firstPatched(advisory.patched_versions);
    if (patched) entry.patched.push(patched);
    else entry.unfixable = true;
    packages.set(advisory.module_name, entry);
  }
  for (const entry of packages.values()) {
    entry.worst = entry.advisories.reduce(
      (worst, a) => (RANK[a.severity] > RANK[worst] ? a.severity : worst),
      "info",
    );
    entry.target = entry.patched.sort(compareVersions).at(-1) ?? null;
  }
  return [...packages.values()].sort(
    (a, b) => RANK[b.worst] - RANK[a.worst] || b.advisories.length - a.advisories.length,
  );
}

function renderMarkdown(report) {
  const advisories = Object.values(report.advisories ?? {});
  const counts = report.metadata?.vulnerabilities ?? {};
  const total = advisories.length;
  const lines = [];

  lines.push("## Dependency advisories (`pnpm audit`)", "");
  if (total === 0) {
    lines.push("No known advisories against the current lockfile. :tada:", "");
    return lines.join("\n");
  }

  const tally = ORDER.filter((s) => counts[s] > 0)
    .map((s) => `**${counts[s]}** ${s}`)
    .join(" · ");
  lines.push(
    `${tally} — ${total} advisories across ${report.metadata?.totalDependencies ?? "?"} resolved dependencies.`,
    "",
    "> This job never fails the build. Advisories arrive on a third party's schedule,",
    "> not with this commit; gating on them would block rollbacks and hotfixes for code",
    "> already running in production. Triage is tracked in `TODO.md`, not by a red CI run.",
    "",
  );

  const packages = byPackage(advisories);
  const direct = packages.filter((p) => p.direct);
  const transitive = packages.filter((p) => !p.direct);

  const table = (rows) => [
    "| Package | Worst | # | Installed | Fixed in | Used by |",
    "| --- | --- | --: | --- | --- | --- |",
    ...rows.map((p) => {
      const installed = [...p.installed].sort(compareVersions).join(", ") || "—";
      const fixed = p.unfixable && !p.target ? "**no fix published**" : (p.target ?? "—");
      const owners = [...p.owners].sort().join(", ");
      const runtime = p.runtime ? "" : " _(dev)_";
      return `| \`${p.name}\`${runtime} | ${p.worst} | ${p.advisories.length} | ${installed} | ${fixed} | ${owners} |`;
    }),
    "",
  ];

  if (direct.length > 0) {
    lines.push(
      "### Direct dependencies",
      "",
      "Declared by a workspace package — these we can bump ourselves.",
      "",
      ...table(direct),
    );
  }
  if (transitive.length > 0) {
    lines.push(
      "### Transitive dependencies",
      "",
      "Pulled in by something else; they clear when the parent bumps, or need an override.",
      "",
      ...table(transitive),
    );
  }

  lines.push("<details>", "<summary>Every advisory in full</summary>", "");
  for (const severity of ORDER) {
    const group = advisories
      .filter((a) => a.severity === severity)
      .sort((a, b) => a.module_name.localeCompare(b.module_name));
    if (group.length === 0) continue;
    lines.push(`#### ${severity} (${group.length})`, "");
    for (const advisory of group) {
      const paths = (advisory.findings ?? []).flatMap((f) => f.paths ?? []);
      lines.push(
        `- **\`${advisory.module_name}\`** — ${advisory.title}  `,
        `  [${advisory.github_advisory_id}](${advisory.url}) · vulnerable \`${advisory.vulnerable_versions}\` · patched \`${advisory.patched_versions}\``,
      );
      const shown = paths.slice(0, 3).map((p) => `\`${p}\``);
      if (paths.length > 3) shown.push(`_+${paths.length - 3} more_`);
      if (shown.length > 0) lines.push(`  <br>${shown.join(" · ")}`);
    }
    lines.push("");
  }
  lines.push("</details>", "");
  return lines.join("\n");
}

const { report, error } = runAudit();

if (error) {
  // Degrade to a note. `pnpm audit` is a network call to the registry; a flake
  // must not turn into a red run for a job whose whole point is not to gate.
  const note = `## Dependency advisories (\`pnpm audit\`)\n\n:warning: Audit did not run: ${error}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
  else process.stdout.write(note);
  console.log(`::warning title=pnpm audit::${error}`);
  process.exit(0);
}

const markdown = renderMarkdown(report);
const counts = report.metadata?.vulnerabilities ?? {};
const total = Object.values(report.advisories ?? {}).length;

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  const digest = ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  if (total > 0) {
    console.log(`::warning title=Dependency advisories::${digest} — see the job summary`);
  }
  console.log(total > 0 ? `${total} advisories: ${digest}` : "No known advisories.");
} else {
  process.stdout.write(markdown);
}

// Always. See the header.
process.exit(0);
