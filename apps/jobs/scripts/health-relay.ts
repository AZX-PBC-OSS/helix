import { pathToFileURL } from "node:url";

import {
  HealthStatusSchema,
  JobServerIdSchema,
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_SERVICE_NAME,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
  type HealthState,
  type HealthStatus,
} from "@azx-pbc/shared";
import { z } from "zod";

/**
 * The body-aware health relay — the script infra/azure/modules/alerts-jobs.bicep
 * schedules as a Container Apps Job ("health relay") in the apps environment.
 *
 * Every Helix `/health` answers HTTP 200 in every state; the degradation lives
 * in the JSON body. On Azure the jobs app — and by default the portal — have
 * internal-only ingress, so Azure availability tests, which run from the
 * public internet, cannot read those bodies. This relay runs inside the apps
 * environment instead: it fetches each configured target's `/health`, filters
 * the body down to the target kind's expected `jobs_*` checks, and writes one
 * bounded JSON line per event to stdout. Container stdout lands in Log
 * Analytics (`ContainerAppConsoleLogs_CL`, the whole line in `Log_s`), which
 * is what the log-alert rules read.
 *
 * The target list arrives on `JOBS_HEALTH_RELAY_TARGETS` (set by the Bicep
 * module). Every emitted line identifies its target by the bounded id only —
 * never the URL, host, port, or any error text. The logs are retained, URLs
 * are never logged whole (docs/design/logging.md), and an error string could
 * carry either.
 *
 * Usage inside the job (the target list is supplied by the template):
 *   JOBS_HEALTH_RELAY_TARGETS=[{"kind":"jobs","target":"...","url":"..."}]
 *   node --import tsx scripts/health-relay.ts
 */

export const RELAY_TARGETS_ENV = "JOBS_HEALTH_RELAY_TARGETS";
export const RELAY_OBSERVED_EVENT = "jobs.health.observed";
export const RELAY_CHECK_EVENT = "jobs.health.check";
export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_BODY_LIMIT_BYTES = 64 * 1024;
export const RELAY_DETAIL_LIMIT = 400;

/** What each target kind must answer as (`service`), and the checks it must report. */
export const RELAY_TARGET_KINDS = {
  jobs: {
    service: JOBS_SERVICE_NAME,
    checks: [
      JOBS_DATABASE_CHECK,
      JOBS_WORKER_CHECK,
      JOBS_SWEEPER_CHECK,
      JOBS_CAPACITY_CHECK,
      JOBS_LIFECYCLE_RECOVERY_CHECK,
      JOBS_CLEANUP_CHECK,
      JOBS_INTAKE_CHECK,
    ],
  },
  portal: {
    service: "helix-portal",
    checks: [JOBS_LIFECYCLE_DELIVERY_CHECK],
  },
} as const;

export const RELAY_OUTCOMES = ["observed", "no_answer", "off_protocol"] as const;
export type RelayOutcome = (typeof RELAY_OUTCOMES)[number];

export type RelayKind = keyof typeof RELAY_TARGET_KINDS;

export const RelayTargetSchema = z.strictObject({
  kind: z.enum(["jobs", "portal"]),
  target: JobServerIdSchema,
  url: z.url({ protocol: /^https?$/ }),
});
export type RelayTarget = z.infer<typeof RelayTargetSchema>;

export const RelayTargetsSchema = z
  .array(RelayTargetSchema)
  .min(1)
  .max(16)
  .refine((targets) => {
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.kind}\u0000${target.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });

/** One emitted check line — a single expected check's graded state. */
export type RelayCheckLine = {
  event: typeof RELAY_CHECK_EVENT;
  kind: RelayKind;
  target: string;
  /** The check name, from the shared `jobs_*` vocabulary. */
  check: string;
  status: HealthState;
  /** Operator-facing one-liner, truncated to {@link RELAY_DETAIL_LIMIT} characters. */
  detail?: string;
  /** Numeric facts an alert rule can key on, copied as the body reported them. */
  metrics?: Record<string, number>;
};

/** The one emitted summary line for a target — every observe ends with exactly one. */
export type RelayObservedLine = {
  event: typeof RELAY_OBSERVED_EVENT;
  kind: RelayKind;
  target: string;
  outcome: RelayOutcome;
  /** The body's roll-up, only when the body was actually read and accepted. */
  status?: HealthState;
  /** The kind's expected checks absent from the body, in expected-list order. */
  missing: string[];
};

export type RelayLine = RelayCheckLine | RelayObservedLine;

/** Bounded-wait and body-cap configuration, shared by {@link observeTarget} and {@link runRelay}. */
export interface RelayOptions {
  /** The fetch's total bound, in ms. Defaults to {@link RELAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The most response body the relay will read, in bytes. Defaults to {@link RELAY_BODY_LIMIT_BYTES}. */
  bodyLimitBytes?: number;
}

/**
 * A fixed config-error message: it names the variable and its setter, and
 * nothing else. Both `JSON.parse`'s SyntaxError and zod's issue text can
 * quote fragments of the offending input, so the raw env value must never
 * reach a message that ends up in retained logs.
 */
const CONFIG_ERROR = `${RELAY_TARGETS_ENV} is missing or invalid — it is set by infra/azure/modules/alerts-jobs.bicep`;

/**
 * Parse the target list out of the environment. Throws on a missing, empty,
 * unparseable, or schema-invalid value — always with the fixed config-error
 * message, never with the value itself.
 */
export function loadRelayTargets(env: NodeJS.ProcessEnv): RelayTarget[] {
  const raw = env[RELAY_TARGETS_ENV];
  if (raw === undefined || raw === "") throw new Error(CONFIG_ERROR);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(CONFIG_ERROR);
  }
  const parsed = RelayTargetsSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error(CONFIG_ERROR);
  return parsed.data;
}

/**
 * Drop a response body without reading it. The cancel is best-effort: a body
 * that is already errored or closed rejects the cancel, which must not turn
 * into a relay failure or an unhandled rejection.
 */
function closeQuietly(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => {});
}

/**
 * Read a 200 body up to `limitBytes`. Three outcomes: the full text, a body
 * that exceeded the cap, or a read that failed — the last includes the
 * request timeout aborting the stream mid-read.
 */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: "limit" | "unreadable" }> {
  if (!body) return { ok: false, reason: "unreadable" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "limit" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, text: text + decoder.decode() };
}

function observedLine(
  target: RelayTarget,
  outcome: RelayOutcome,
  status?: HealthState,
  missing: string[] = [],
): RelayObservedLine {
  return {
    event: RELAY_OBSERVED_EVENT,
    kind: target.kind,
    target: target.target,
    outcome,
    ...(status === undefined ? {} : { status }),
    missing,
  };
}

/** The check lines for an accepted body: expected names only, first report wins, in body order. */
function checkLines(target: RelayTarget, body: HealthStatus): RelayCheckLine[] {
  const expected = RELAY_TARGET_KINDS[target.kind].checks;
  const expectedSet = new Set<string>(expected);
  const seen = new Set<string>();
  const lines: RelayCheckLine[] = [];
  for (const check of body.checks ?? []) {
    if (!expectedSet.has(check.name) || seen.has(check.name)) continue;
    seen.add(check.name);
    lines.push({
      event: RELAY_CHECK_EVENT,
      kind: target.kind,
      target: target.target,
      check: check.name,
      status: check.status,
      ...(check.detail === undefined ? {} : { detail: check.detail.slice(0, RELAY_DETAIL_LIMIT) }),
      ...(check.metrics === undefined ? {} : { metrics: check.metrics }),
    });
  }
  return lines;
}

/** The kind's expected checks absent from the body, in expected-list order. */
function missingChecks(target: RelayTarget, body: HealthStatus): string[] {
  const expected = RELAY_TARGET_KINDS[target.kind].checks;
  const reported = new Set((body.checks ?? []).map((check) => check.name));
  return expected.filter((name) => !reported.has(name));
}

/**
 * Fetch one target's `/health` and return its lines: the accepted body's check
 * lines, then exactly one observed line summarising the outcome.
 *
 * Redirects are never followed (`redirect: "manual"`, and any non-200 is
 * off-protocol): a `/health` that answers with a 3xx is misrouted, and
 * following it would grade a body from somewhere the deployment did not name.
 */
export async function observeTarget(
  target: RelayTarget,
  options: RelayOptions = {},
): Promise<RelayLine[]> {
  const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
  const bodyLimitBytes = options.bodyLimitBytes ?? RELAY_BODY_LIMIT_BYTES;
  const kind = RELAY_TARGET_KINDS[target.kind];

  let res: Response;
  try {
    res = await fetch(target.url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Network error, DNS failure, refused connection, or the timeout abort —
    // none of it may be named beyond "no_answer", or the host would be.
    return [observedLine(target, "no_answer")];
  }
  if (res.status !== 200) {
    closeQuietly(res.body);
    return [observedLine(target, "off_protocol")];
  }

  const read = await readBody(res.body, bodyLimitBytes);
  if (!read.ok) {
    return [observedLine(target, read.reason === "limit" ? "off_protocol" : "no_answer")];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read.text);
  } catch {
    return [observedLine(target, "off_protocol")];
  }
  const parsed = HealthStatusSchema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.service !== kind.service) {
    return [observedLine(target, "off_protocol")];
  }
  const body = parsed.data;

  return [
    ...checkLines(target, body),
    observedLine(target, "observed", body.status, missingChecks(target, body)),
  ];
}

/**
 * Run one relay pass: load the targets, observe them all concurrently, and
 * hand each target's lines to `write` — check lines first, then the observed
 * line — in the targets' own order.
 *
 * A target that cannot be observed is a reported outcome, not a relay
 * failure: the missing-evidence rule reads it from the observed line. The
 * relay exits 1 only for a configuration error, which writes no lines at all;
 * the same rule then reports every target as `no_observation`.
 */
export async function runRelay(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  options: RelayOptions = {},
): Promise<number> {
  let targets: RelayTarget[];
  try {
    targets = loadRelayTargets(env);
  } catch (error) {
    process.stderr.write(
      `health relay: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const perTarget = await Promise.all(targets.map((target) => observeTarget(target, options)));
  for (const lines of perTarget) {
    for (const line of lines) write(JSON.stringify(line));
  }
  return 0;
}

// The command entry point, guarded so importing the module (the tests read
// `observeTarget` and `runRelay`) does not run the pass.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runRelay(process.env, (l) => process.stdout.write(l + "\n"));
}
