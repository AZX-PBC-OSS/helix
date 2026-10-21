/**
 * The app-author guide for background jobs (`apps/docs/src/apps/jobs.md`) is
 * the platform's public statement of the jobs wire contract. These tests pin
 * that statement to the shipped constants and schemas: a guide that drifts
 * from `@azx-pbc/shared`, the jobs route constants, or the platform's own
 * policy constants fails here, with a message naming what moved.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FetchJobInputSchema,
  IDEMPOTENCY_KEY_HEADER,
  JOB_ERROR_CODES,
  JOB_REQUEST_ERROR_CODES,
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  JOBS_CAPACITY_DEFAULTS,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_MAX_INPUT_BYTES,
  JOBS_MAX_RESULT_BYTES,
  JOBS_PROGRESS_LABEL_MAX_BYTES,
  JOBS_RETRY_KEY_MAX_BYTES,
} from "@azx-pbc/shared";
import {
  ROUTE_JOBS_CANCEL,
  ROUTE_JOBS_RESULT,
  ROUTE_JOBS_SNAPSHOT,
  ROUTE_JOBS_SUBMIT,
} from "@azx-pbc/shared/telemetry";
import {
  JOBS_FETCH_DEADLINE_SECONDS,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
} from "./policy.js";
import { JOBS_FETCH_OUTBOUND_TIMEOUT_MS } from "./fetchJob.js";

const guide = readFileSync(new URL("../../../apps/docs/src/apps/jobs.md", import.meta.url), "utf8");
const skillTemplate = readFileSync(
  new URL("../../../packages/deploy-skill/SKILL.md", import.meta.url),
  "utf8",
);

// The route answers the real-stack suites prove, keyed by request-error code.
const REQUEST_ERROR_STATUSES: Record<string, number> = {
  job_server_unknown: 400,
  idempotency_key_invalid: 400,
  payload_invalid: 400,
  forbidden: 403,
  job_not_found: 404,
  idempotency_conflict: 409,
  job_not_ready: 409,
  job_terminal: 409,
  result_expired: 410,
  payload_too_large: 413,
  rate_limited: 429,
  jobs_capacity_exceeded: 429,
  jobs_unavailable: 503,
  jobs_disabled: 503,
};

/** Every request-error code a jobs route answers itself: the HTTP refusals, not the session gate. */
const ROUTE_REFUSAL_CODES = [
  ...JOB_REQUEST_ERROR_CODES.filter(
    (code) => !(JOB_ERROR_CODES as readonly string[]).includes(code) && code !== "unauthorized",
  ),
  "payload_invalid",
].sort();

/** The text of a `## <heading>` section, up to the next level-2 heading (`###` stays inside). */
function section(markdown: string, heading: string): string {
  const headingLine = `## ${heading}`;
  const start = markdown.indexOf(headingLine);
  if (start === -1) {
    throw new Error(`the guide has no "## ${heading}" section`);
  }
  const next = markdown.indexOf("\n## ", start + headingLine.length);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

/** The trimmed cells of every table row that is neither the header nor the `| --- |` separator. */
function tableRows(text: string): string[][] {
  const pipeLines = text.split("\n").filter((line) => line.trimStart().startsWith("|"));
  return pipeLines
    .slice(1) // the header row
    .filter(
      (line) =>
        !line.split("|").every((cell) => cell.trim() === "" || /^:?-+:?$/.test(cell.trim())),
    )
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
}

/** The content of a cell's first backtick span, or null when the cell has none. */
function codeOf(cell: string): string | null {
  return /`([^`]*)`/.exec(cell)?.[1] ?? null;
}

/** The bodies of every fenced block whose opening line is exactly ```json. */
function jsonBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] !== "```json") {
      index++;
      continue;
    }
    index++;
    const body: string[] = [];
    while (index < lines.length && lines[index] !== "```") {
      body.push(lines[index] ?? "");
      index++;
    }
    blocks.push(body.join("\n"));
    index++; // past the closing fence
  }
  return blocks;
}

describe("the background-jobs author guide", () => {
  it("lists the shipped statuses in order, and calls out the terminal ones", () => {
    const statuses = section(guide, "Statuses");
    const listed = tableRows(statuses).map((row) => codeOf(row[0] ?? ""));
    expect(listed, "the guide's status table").toEqual([...JOB_STATUSES]);
    for (const terminal of JOB_TERMINAL_STATUSES) {
      expect(statuses, `terminal status \`${terminal}\``).toContain(`\`${terminal}\``);
    }
  });

  it("explains every execution failure code except the submission refusal payload_invalid", () => {
    const codes = tableRows(section(guide, "Why a job failed")).map((row) => codeOf(row[0] ?? ""));
    const expected = [...JOB_ERROR_CODES].filter((code) => code !== "payload_invalid").sort();
    expect([...codes].sort(), "the guide's failure-code table").toEqual(expected);
  });

  it("answers every request-error code from the documented HTTP status", () => {
    const rows = tableRows(section(guide, "Errors from the jobs routes")).map((row) => ({
      status: row[0] ?? "",
      code: codeOf(row[1] ?? ""),
    }));
    const codes = rows.map((row) => row.code);

    const expectedCodes = ROUTE_REFUSAL_CODES;
    expect(new Set(Object.keys(REQUEST_ERROR_STATUSES)), "the status map this test pins").toEqual(
      new Set(expectedCodes),
    );

    for (const { status, code } of rows) {
      expect(
        code !== null && (JOB_REQUEST_ERROR_CODES as readonly string[]).includes(code),
        `${code ?? "(a code cell that lost its backticks)"} is a shipped request-error code`,
      ).toBe(true);
      expect(status, `the HTTP status for ${code ?? "(a missing code)"}`).toMatch(/^\d{3}$/);
      expect(Number(status), `the HTTP status for ${code ?? "(a missing code)"}`).toBe(
        REQUEST_ERROR_STATUSES[code ?? ""],
      );
    }
    expect([...codes].sort(), "the guide's request-error table").toEqual(expectedCodes);
  });

  it("shows a JSON example for every response shape, each parsing against a wire schema", () => {
    const blocks = jsonBlocks(guide);
    expect(blocks.length, "json example blocks found in the guide").toBeGreaterThanOrEqual(5);

    const wire = [
      { name: "JobAcceptedSchema", schema: JobAcceptedSchema },
      { name: "JobSnapshotSchema", schema: JobSnapshotSchema },
      { name: "JobCancellationAcceptedSchema", schema: JobCancellationAcceptedSchema },
      { name: "JobRequestErrorSchema", schema: JobRequestErrorSchema },
      { name: "FetchJobInputSchema", schema: FetchJobInputSchema },
    ];

    for (const [index, block] of blocks.entries()) {
      const parsed = JSON.parse(block);
      expect(
        wire.some(({ schema }) => schema.safeParse(parsed).success),
        `json example #${index} matches no wire schema:\n${block}`,
      ).toBe(true);
    }
    for (const { name, schema } of wire) {
      expect(
        blocks.filter((block) => schema.safeParse(JSON.parse(block)).success).length,
        `json examples accepted by ${name}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("routes the four operations and names the fetch type and the retry-key header", () => {
    const operations = section(guide, "The four operations");
    for (const [method, route] of [
      ["POST", ROUTE_JOBS_SUBMIT],
      ["GET", ROUTE_JOBS_SNAPSHOT],
      ["GET", ROUTE_JOBS_RESULT],
      ["DELETE", ROUTE_JOBS_CANCEL],
    ] as const) {
      expect(operations, `${method} ${route} in the operations table`).toContain(
        `\`${method} ${route}\``,
      );
    }
    expect(guide, `the fetch type \`${JOBS_FETCH_QUALIFIED_TYPE}\``).toContain(
      `\`${JOBS_FETCH_QUALIFIED_TYPE}\``,
    );
    expect(guide, "the retry-key header's documented spelling").toContain("Idempotency-Key");
    expect(
      "Idempotency-Key".toLowerCase(),
      "the documented header spelling is the shipped IDEMPOTENCY_KEY_HEADER",
    ).toBe(IDEMPOTENCY_KEY_HEADER);
  });

  it("states the platform's numbers as the shipped constants define them", () => {
    expect(JOBS_MAX_INPUT_BYTES, "the input size limit").toBe(65_536);
    expect(JOBS_MAX_RESULT_BYTES, "the result size limit").toBe(65_536);
    expect(JOBS_CAPACITY_DEFAULTS.submissionWindowSeconds, "the submission window").toBe(60);

    // Prose wraps across source lines, so match against whitespace-normalized
    // text, and report the missing figure rather than the whole guide.
    const prose = guide.replace(/\s+/g, " ");
    const states = (figure: string, what: string): void => {
      expect(prose.includes(figure), `${what}: the guide no longer says "${figure}"`).toBe(true);
    };
    states(`${JOBS_MAX_INPUT_BYTES / 1024} KiB`, "the input size in KiB");
    states(`${JOBS_MAX_INPUT_BYTES.toLocaleString("en-US")} bytes`, "the input size in bytes");
    states(`${JOBS_RETRY_KEY_MAX_BYTES} UTF-8 bytes`, "the retry-key size");
    states(`${JOBS_PROGRESS_LABEL_MAX_BYTES} UTF-8 bytes`, "the progress-label size");
    states(
      `${JOBS_CAPACITY_DEFAULTS.submissionAttemptsPerAppEnv} submission attempts per minute`,
      "the per-app submission rate",
    );
    states(`${JOBS_RESULT_TTL_SECONDS / 86_400} days from success`, "the result retention");
    states(
      `${JOBS_RECORD_TTL_SECONDS / 86_400} days from the job's terminal status`,
      "the record retention",
    );

    const minuteWords: Record<number, string> = { 5: "five" };
    const deadlineMinutes = JOBS_FETCH_DEADLINE_SECONDS / 60;
    const word = minuteWords[deadlineMinutes];
    expect(word, `no word pinned for a ${deadlineMinutes}-minute fetch deadline`).toBeDefined();
    states(`within ${word} minutes of acceptance`, "the fetch job's deadline");
  });

  it("stops the example client's polling at exactly the shipped terminal statuses", () => {
    const terminal = `[${JOB_TERMINAL_STATUSES.map((status) => `"${status}"`).join(", ")}]`;
    const client = /\n```js\n([\s\S]*?)\n```\n/.exec(guide)?.[1];
    expect(client, "the guide's example client block").toBeDefined();
    // Compiling without calling is a syntax check: the client declares only
    // functions and constants, so nothing runs.
    expect(() => new Function(client ?? ""), "the example client compiles").not.toThrow();
    expect(
      guide.includes(`const TERMINAL = ${terminal};`),
      `the example client's TERMINAL list is ${terminal}`,
    ).toBe(true);
  });
});

/**
 * The deploy skill teaches the same contract in condensed form, inside its
 * `IF:JOBS_OFFERED` block. It links to the guide for the full statement, so
 * every fact it does state is pinned here to the same constants the guide is.
 */
describe("the deploy skill's background-jobs section", () => {
  const start = skillTemplate.indexOf("<!-- IF:JOBS_OFFERED -->\n");
  const end = skillTemplate.indexOf("<!-- /IF:JOBS_OFFERED -->\n", start);
  const jobsSection = start === -1 || end === -1 ? "" : skillTemplate.slice(start, end);
  const prose = jobsSection.replace(/\s+/g, " ");

  it("is present in the skill template", () => {
    expect(jobsSection, "the skill's IF:JOBS_OFFERED block").toContain("### 3.7 Background jobs");
  });

  it("routes the four operations and names the fetch type and the retry-key header", () => {
    for (const [method, route] of [
      ["POST", ROUTE_JOBS_SUBMIT],
      ["GET", ROUTE_JOBS_SNAPSHOT],
      ["GET", ROUTE_JOBS_RESULT],
      ["DELETE", ROUTE_JOBS_CANCEL],
    ] as const) {
      expect(jobsSection, `${method} ${route} in the skill's operations table`).toContain(
        `\`${method} ${route}\``,
      );
    }
    expect(jobsSection).toContain(`\`${JOBS_FETCH_QUALIFIED_TYPE}\``);
    expect(jobsSection.toLowerCase()).toContain(`"${IDEMPOTENCY_KEY_HEADER}"`);
    expect(jobsSection).toContain("`Idempotency-Key`");
  });

  it("answers every route refusal from the same HTTP status the guide documents", () => {
    const table = jobsSection.slice(jobsSection.indexOf("| Status | Code"));
    const listed: string[] = [];
    for (const row of tableRows(table.slice(0, table.indexOf("\n\n")))) {
      const status = row[0] ?? "";
      const codes = [...(row[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      expect(codes.length, `a refusal row with no code: ${row.join(" | ")}`).toBeGreaterThan(0);
      for (const code of codes) {
        expect(Number(status), `the skill's HTTP status for ${code}`).toBe(
          REQUEST_ERROR_STATUSES[code],
        );
        listed.push(code);
      }
    }
    expect(listed.sort(), "the skill's refusal table").toEqual(ROUTE_REFUSAL_CODES);
  });

  it("names only shipped execution failure codes", () => {
    const named = /`error\.code` says why \(([^)]*)\)/.exec(prose)?.[1];
    expect(named, "the skill's failure-code examples").toBeDefined();
    for (const [, code] of (named ?? "").matchAll(/`([^`]+)`/g)) {
      expect(JOB_ERROR_CODES as readonly string[], `failure code ${code}`).toContain(code);
    }
  });

  it("stops polling at exactly the shipped terminal statuses", () => {
    const listed = JOB_TERMINAL_STATUSES.map((status) => `\`${status}\``).join(", ");
    expect(prose, "the skill's terminal-status list").toContain(`terminal status (${listed})`);
  });

  it("states the fetch job's limits and retention as the shipped constants define them", () => {
    const states = (figure: string, what: string): void => {
      expect(prose.includes(figure), `${what}: the skill no longer says "${figure}"`).toBe(true);
    };
    states(`at most ${JOBS_MAX_RESULT_BYTES / 1024} KiB`, "the result size");
    states(`after ${JOBS_FETCH_OUTBOUND_TIMEOUT_MS / 1000} seconds`, "the outbound timeout");
    const minuteWords: Record<number, string> = { 5: "five" };
    states(
      `within ${minuteWords[JOBS_FETCH_DEADLINE_SECONDS / 60] ?? "?"} minutes of acceptance`,
      "the fetch job's deadline",
    );
    states(`readable for ${JOBS_RESULT_TTL_SECONDS / 86_400} days`, "the result retention");
    states(`the record for ${JOBS_RECORD_TTL_SECONDS / 86_400} days`, "the record retention");
  });

  it("shows a submit client that compiles, keeps the key and bytes, and never resubmits on 401", () => {
    const client = /\n```js\n([\s\S]*?)\n```\n/.exec(jobsSection)?.[1];
    expect(client, "the skill's example client block").toBeDefined();
    expect(() => new Function(client ?? ""), "the example client compiles").not.toThrow();
    expect(client).toContain(`"Idempotency-Key": job.key`);
    expect(client).toContain("body: job.body");
    // The 401 branch returns without sending again.
    const on401 = /if \(res\?\.status === 401\) \{([\s\S]*?)\}/.exec(client ?? "")?.[1] ?? "";
    expect(on401, "the 401 branch").toContain("return null");
    expect(on401, "the 401 branch").not.toContain("fetch(");
  });
});
