import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Pool } from "pg";
import { ConnectionMaterialSchema, type Env } from "@azx-pbc/shared";
import {
  ATTR_ENV,
  ATTR_OUTCOME,
  SPAN_EGRESS_RETIRE,
  type EgressRetirePassOutcome,
  type EgressRetirementOutcome,
} from "@azx-pbc/shared/telemetry";
import type { SecretStore } from "@azx-pbc/secret-store";
import { egressSpanAttributes } from "./spanAttributes.js";
import { instruments, tracer } from "./telemetry.js";

/**
 * The credential-retirement sweep (I-02 T-0025, ADR-0008): the consumer of the
 * in-row retirement ledger every writer marks. Whoever swaps or invalidates
 * delegated material writes the old sealed reference into the row's
 * `pendingRetire` field IN the same UPDATE as the swap (T-0010, T-0020, T-0021,
 * T-0024) — this sweep destroys what those marks name and clears the field,
 * well inside criterion 47's 15-minute recovery bound (the cadence is a config
 * knob, `EGRESS_RETIRE_SWEEP_INTERVAL_MS`, default one minute).
 *
 * The vault cannot be enumerated through the SecretStore seam (seal/open/
 * destroy only — ADR-0008 §Alternatives considered rejected adding one), so the
 * ledger in the row is the ONLY record of what needs destroying; nothing here
 * scans the vault, and no list method is added to the store.
 *
 * Per entry, in ADR-0008 §Decision's order:
 *
 * 1. **Read** — rows with a `pendingRetire` mark (SELECT; `helix_egress` has
 *    SELECT on `user_connections`).
 * 2. **Claim** — a conditional UPDATE clearing the mark only while it still
 *    holds exactly the reference that was read (`WHERE "pendingRetire" = X`).
 *    Only a successful claim (rowcount 1) proceeds. This is the conditional
 *    re-check that makes a reconnect racing the sweep safe: a writer that
 *    re-purposed the single-slot ledger between the read and the claim wins,
 *    the claim loses, and no destroy fires for anything the row now names
 *    (criterion 48) — the writer's own mark is consumed by a later pass.
 * 3. **Destroy** — both references of the claimed envelope, through the
 *    delegated store. The claim ordering is deliberate and load-bearing:
 *    claim-first means each ledger mark is destroyed AT MOST ONCE across
 *    replicas (a second replica's claim loses), and a destroy failure is made
 *    retriable by RESTORING the mark — conditionally (`WHERE "pendingRetire"
 *    IS NULL`), so a writer that took the slot in the meantime keeps its own
 *    reference and the restore never clobbers it. Retry is therefore
 *    unconditional on the next pass, never manual (criterion 47).
 *
 * The accepted residual (ADR-0008): a crash inside the sub-second claim→destroy
 * window strands the claimed reference unmarked — the same single-slot class
 * the writers already accept; the reference has no use path (the row is dead
 * or holds newer material) and cannot be found by any scan, which is exactly
 * why the sweep exists to consume marks promptly rather than hold them.
 *
 * The destroy is never held against a checked-out DB client (ADR-0007's
 * rejected lock-across-network-call shape): every statement here is a short
 * pooled query, so a slow vault call pins nothing. The sweep runs on an
 * unref'd interval (the burn-sweep precedent) that never stacks passes — a
 * tick while one is in flight is skipped — and `stop()` clears the timer and
 * awaits the in-flight pass, so graceful shutdown never orphans a half-done
 * claim. Nothing here runs on the proxy path.
 */

/** Bounded work per pass: destroys are rare, and a cap keeps one pass short. */
export const RETIRE_BATCH_LIMIT = 64;

/**
 * Why one retirement failed — the bounded `reason` on the fixed warn event.
 */
export type RetireFailureReason = "destroy_failed" | "restore_failed" | "ledger_slot_taken";

/** Bounded, fixed-string logging seam (the renewal module's shape). */
export interface RetirementSweepLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CredentialRetirementSweepDeps {
  /** The `helix_egress` pool (the delegated resolution/renewal pool). */
  pool: Pool;
  /** The delegated-custody store — the ONLY destroy path (ADR-0006 part 1). */
  delegatedStore: SecretStore;
  /** Sweep cadence, ms — config `EGRESS_RETIRE_SWEEP_INTERVAL_MS`. */
  intervalMs: number;
  /** Entries claimed+destroyed per pass, upper bound. */
  batchLimit?: number;
  log?: RetirementSweepLogger;
}

/** One ledger entry as the pass's SELECT hands it back. */
interface PendingRetireRow {
  id: string;
  env: string;
  pendingRetire: string;
  providerRef: string | null;
}

export class CredentialRetirementSweep {
  readonly #pool: Pool;
  readonly #delegatedStore: SecretStore;
  readonly #intervalMs: number;
  readonly #batchLimit: number;
  readonly #log: RetirementSweepLogger;

  #timer: NodeJS.Timeout | null = null;
  /** The pass in flight, so `stop()` can await it and ticks never stack. */
  #inFlight: Promise<void> | null = null;

  constructor(deps: CredentialRetirementSweepDeps) {
    this.#pool = deps.pool;
    this.#delegatedStore = deps.delegatedStore;
    this.#intervalMs = deps.intervalMs;
    this.#batchLimit = deps.batchLimit ?? RETIRE_BATCH_LIMIT;
    this.#log = deps.log ?? { warn() {} };
  }

  /**
   * Begin sweeping. The interval is unref'd — it never holds the process open
   * (the burn-sweep precedent). No immediate pass: the first one fires after
   * one interval, which is what keeps recovery bounded by the cadence rather
   * than by boot timing. Idempotent until `stop()`.
   */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      // A slow pass never stacks: the next tick while one is in flight is
      // skipped — overlapping passes would double-claim (harmless, the CAS
      // arbitrates) but also double-count and pin pool capacity for nothing.
      if (this.#inFlight) return;
      const pass = this.sweepOnce().finally(() => {
        if (this.#inFlight === pass) this.#inFlight = null;
      });
      this.#inFlight = pass;
    }, this.#intervalMs);
    this.#timer.unref();
  }

  /**
   * Stop sweeping and wait out any in-flight pass. Resolves only when no pass
   * is running, so a caller that ends the pool afterwards never pulls it out
   * from under a live claim or destroy. Always safe to call twice.
   */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  /**
   * One pass. Never rejects — every failure is bounded into the pass span's
   * outcome, the retirement counter, and the fixed warn event, because a
   * background loop that throws into the void (or into an unhandled
   * rejection) is exactly the failure criterion 47 wants visible instead.
   */
  async sweepOnce(): Promise<void> {
    const span = tracer.startSpan(SPAN_EGRESS_RETIRE, { kind: SpanKind.INTERNAL });
    let outcome: EgressRetirePassOutcome = "ok";
    try {
      const pending = await this.#pool.query<PendingRetireRow>(
        `SELECT c.id, c.env, c."pendingRetire", p.ref AS "providerRef"
           FROM user_connections c
           LEFT JOIN connection_providers p ON p.id = c."providerId"
          WHERE c."pendingRetire" IS NOT NULL
          ORDER BY c.id
          LIMIT $1`,
        [this.#batchLimit],
      );
      for (const row of pending.rows) {
        await this.#retireOne(row);
      }
    } catch {
      // The read itself failed (a down DB, a timeout): the pass did not run.
      // Individual entry failures below never throw, so this arm is only the
      // pass-level one — retried at the next tick.
      outcome = "failed";
    } finally {
      span.setAttributes(egressSpanAttributes({ [ATTR_OUTCOME]: outcome }));
      if (outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  }

  /** Claim → destroy one ledger entry. Never throws (ADR-0008's flow, in order). */
  async #retireOne(row: PendingRetireRow): Promise<void> {
    const env: Env = row.env === "dev" ? "dev" : "prod";
    // THE CLAIM — the conditional re-check (ADR-0008): clear the mark only
    // while it still holds exactly the reference this pass read. A writer that
    // swapped material and re-marked the row in between makes this match zero
    // rows, and the sweep destroys nothing for it (criterion 48).
    const claim = await this.#pool.query(
      `UPDATE user_connections SET "pendingRetire" = NULL
        WHERE id = $1::uuid AND "pendingRetire" = $2`,
      [row.id, row.pendingRetire],
    );
    if (claim.rowCount !== 1) {
      this.#count("claimed_lost", env);
      return;
    }

    // Only under a successful claim: destroy what the claimed mark named —
    // both references of the envelope every writer stores (the same
    // ConnectionMaterialSchema the writers serialize; a mark that fails its
    // own parse is a bug surfaced as a failed retirement, restored + retried +
    // visible, never silently dropped).
    try {
      const envelope = ConnectionMaterialSchema.parse(JSON.parse(row.pendingRetire));
      await this.#delegatedStore.destroy(envelope.access);
      await this.#delegatedStore.destroy(envelope.refresh);
    } catch {
      await this.#restoreAfterFailure(row, env);
      return;
    }
    this.#count("retired", env);
  }

  /**
   * A destroy (or parse) failure: put the entry back on the ledger and make
   * the failure visible. The restore is conditional on the slot still being
   * empty — a writer that claimed it in the meantime is writing its OWN
   * reference there, and clobbering it would strand that writer's mark; if
   * the writer re-marked the SAME reference (a reconnect re-marks the row's
   * pre-swap material), the mark already reads what we would restore. Either
   * way the next pass retries without manual intervention (criterion 47) —
   * unless the slot was taken, which is the ledger's accepted single-slot
   * residual and is said at the same fixed event, distinguished by `reason`.
   */
  async #restoreAfterFailure(row: PendingRetireRow, env: Env): Promise<void> {
    let reason: RetireFailureReason = "destroy_failed";
    try {
      const restored = await this.#pool.query(
        `UPDATE user_connections SET "pendingRetire" = $2
          WHERE id = $1::uuid AND "pendingRetire" IS NULL`,
        [row.id, row.pendingRetire],
      );
      if (restored.rowCount !== 1) reason = "ledger_slot_taken";
    } catch {
      // The restore itself failed (the DB did): the entry falls out of the
      // ledger — the same accepted residual class.
      reason = "restore_failed";
    }
    this.#logRetireFailed(row, env, reason);
    this.#count("failed", env);
  }

  /**
   * The fixed failure event (design.md §Operator-visible signals). Bounded
   * metadata only — connection id, providerRef, env — and no reason to ever
   * name the material: the destroy error text can embed credential material,
   * so nothing about it is logged, spanned, or counted beyond the outcome word.
   */
  #logRetireFailed(row: PendingRetireRow, env: Env, reason: RetireFailureReason): void {
    this.#log.warn(
      {
        event: "egress.connection_retire_failed",
        connectionId: row.id,
        providerRef: row.providerRef ?? undefined,
        env,
        reason,
      },
      "delegated credential retirement failed; the ledger entry stays retriable",
    );
  }

  #count(outcome: EgressRetirementOutcome, env: Env): void {
    instruments().retirements.add(1, { [ATTR_OUTCOME]: outcome, [ATTR_ENV]: env });
  }
}
