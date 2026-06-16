/**
 * The edge's cached registry projection (architecture §7): an in-memory
 * slug → entry map loaded from Postgres with hand-written SQL (no ORM in the
 * edge — project plan §1). The portal owns the schema; the edge only reads.
 *
 * Failure stance: serve stale. A load error keeps the previous map, so the
 * data path doesn't depend on the portal or a healthy DB connection — only
 * the very first load gates serving (isLoaded()).
 */
import {
  DataCapabilitySchema,
  LlmCapabilitySchema,
  type DataCapability,
  type LlmCapability,
  type VisibilityMode,
} from "@helix/shared";

export interface RegistryEntry {
  appId: string;
  slug: string;
  archived: boolean;
  /** Live version's blob prefix (`apps/<appId>/<n>/`), null if nothing live. */
  blobPrefix: string | null;
  /** Access rule (architecture §4.2); checked at login and on every request. */
  visibilityMode: VisibilityMode;
  /** The group that may open the app — only when `visibilityMode` is `group`. */
  visibilityGroupId: string | null;
  /**
   * The app's LLM grant (manifest `capabilities.llm`, architecture §6.3), or
   * null when the app has no LLM capability — the gateway 403s those. Parsed
   * from the `capabilities` JSON at load time; malformed JSON yields null
   * (fail-closed) rather than crashing the projection.
   */
  llm: LlmCapability | null;
  /**
   * The app's data grant (manifest `capabilities.data`, app-data design §4), or
   * null when the app has no data capability — the data gateway 403s those.
   * Parsed fail-closed exactly like `llm`.
   */
  data: DataCapability | null;
}

/** Extract `capabilities.llm` from the raw JSON column, fail-closed to null. */
function parseLlmCapability(capabilities: unknown): LlmCapability | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const llm = (capabilities as Record<string, unknown>).llm;
  if (llm === undefined) return null;
  const parsed = LlmCapabilitySchema.safeParse(llm);
  return parsed.success ? parsed.data : null;
}

/** Extract `capabilities.data` from the raw JSON column, fail-closed to null. */
function parseDataCapability(capabilities: unknown): DataCapability | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const data = (capabilities as Record<string, unknown>).data;
  if (data === undefined) return null;
  const parsed = DataCapabilitySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export interface RegistryReader {
  /** undefined = unknown slug. */
  getApp(slug: string): RegistryEntry | undefined;
  /** False until the first successful load — app hosts 503 until then. */
  isLoaded(): boolean;
}

interface ProjectionRow {
  id: string;
  slug: string;
  archived: boolean;
  blob_prefix: string | null;
  visibility_mode: VisibilityMode;
  visibility_group_id: string | null;
  /** The `capabilities` JSONB column (pg parses it to an object). */
  capabilities: unknown;
}

/** Narrow query seam: `pg.Pool#query` shaped, fake-able in unit tests. */
export interface ProjectionQuerier {
  query(sql: string): Promise<{ rows: ProjectionRow[] }>;
}

// Prisma created camelCase columns (no @map), so identifiers must be quoted —
// unquoted they would silently lowercase and fail.
const PROJECTION_SQL = `
  SELECT a.id, a.slug, a."archivedAt" IS NOT NULL AS archived, v."blobPrefix" AS blob_prefix,
         a."visibilityMode"::text AS visibility_mode, a."visibilityGroupId" AS visibility_group_id,
         a.capabilities AS capabilities
  FROM apps a
  LEFT JOIN versions v ON v.id = a."currentVersionId"
`;

export class RegistryProjection implements RegistryReader {
  #querier: ProjectionQuerier;
  #map = new Map<string, RegistryEntry>();
  #loaded = false;
  #inFlight: Promise<void> | null = null;
  #dirty = false;
  #onLoadError: (err: unknown) => void;

  constructor(querier: ProjectionQuerier, opts: { onLoadError?: (err: unknown) => void } = {}) {
    this.#querier = querier;
    this.#onLoadError = opts.onLoadError ?? (() => {});
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#map.get(slug);
  }

  isLoaded(): boolean {
    return this.#loaded;
  }

  /**
   * Reload the projection. Loads are serialized: a call during an in-flight
   * load marks it dirty and piggybacks on exactly one follow-up load, so a
   * burst of NOTIFYs collapses instead of stampeding the DB.
   */
  load(): Promise<void> {
    if (this.#inFlight) {
      this.#dirty = true;
      return this.#inFlight;
    }
    this.#inFlight = this.#loadOnce().finally(() => {
      this.#inFlight = null;
      if (this.#dirty) {
        this.#dirty = false;
        void this.load();
      }
    });
    return this.#inFlight;
  }

  async #loadOnce(): Promise<void> {
    try {
      const { rows } = await this.#querier.query(PROJECTION_SQL);
      // Build fresh, swap atomically (single assignment — no torn reads).
      const next = new Map<string, RegistryEntry>();
      for (const row of rows) {
        next.set(row.slug, {
          appId: row.id,
          slug: row.slug,
          archived: row.archived,
          blobPrefix: row.blob_prefix,
          visibilityMode: row.visibility_mode,
          visibilityGroupId: row.visibility_group_id,
          llm: parseLlmCapability(row.capabilities),
          data: parseDataCapability(row.capabilities),
        });
      }
      this.#map = next;
      this.#loaded = true;
    } catch (err) {
      // Keep serving the previous map (stale beats down — architecture §7).
      this.#onLoadError(err);
    }
  }
}
