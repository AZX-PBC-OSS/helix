import "./style.css";

/**
 * Last Widget Co. — a PUBLIC AZX app (no login) demonstrating ADR-0041:
 * app-data writes are compare-and-swap on an opaque version, and `shared`
 * writes REQUIRE a precondition (`If-Match` / `If-None-Match: *`).
 *
 * The stock count lives at one shared key, `shared/stock`, readable and
 * writable by every visitor. The failure being prevented is OVERSELLING: two
 * tabs read "1 left", both buy, and last-write-wins would sell it twice. With
 * CAS the loser gets a loud 412, re-reads, and sees an empty shelf.
 *
 * Everything on screen is the platform's real behavior — the log pane prints
 * each exchange verbatim, and the probes drive deterministic collisions that
 * need no second tab.
 */

type Stock = { count: number };

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { currentVersion?: string | null } };
}

const STOCK_KEY = "stock";
const SCRATCH_KEY = "scratch";

const countEl = document.querySelector<HTMLSpanElement>("#count")!;
const versionEl = document.querySelector<HTMLSpanElement>("#version")!;
const buyBtn = document.querySelector<HTMLButtonElement>("#buy")!;
const restockBtn = document.querySelector<HTMLButtonElement>("#restock")!;
const shopStatusEl = document.querySelector<HTMLParagraphElement>("#shop-status")!;
const logEl = document.querySelector<HTMLPreElement>("#log")!;
const probeOut = document.querySelector<HTMLPreElement>("#probe-out")!;

/** Print one exchange line — the log pane is what makes CAS legible. */
function log(line: string): void {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function probeLog(line: string): void {
  probeOut.textContent += `${line}\n`;
}

/** Render the value + version the app last saw. */
function renderStock(stock: Stock | null, version: string | null): void {
  countEl.textContent = stock ? String(stock.count) : "–";
  versionEl.textContent = version ? `version ${version}` : "version —";
  versionEl.title = version ? `ETag: "${version}"` : "nothing written yet";
}

function shopStatus(kind: "ok" | "bad" | "", text: string): void {
  shopStatusEl.className = `status${kind ? ` ${kind}` : ""}`;
  shopStatusEl.textContent = text;
}

/**
 * The canonical shared-write loop (deploy-skill §3.2): read → modify →
 * If-Match → bounded retry on 412. This is the ONLY way this app writes shared
 * state — a precondition-less PUT is refused 428.
 */
async function updateShared(
  key: string,
  mutate: (current: Stock | undefined) => Stock,
  say: (line: string) => void,
): Promise<{ value: Stock; version: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`/_api/data/shared/${key}`);
    // A failed read is NOT "key absent" — a 403/429/503 must not fall into the
    // create branch and misreport as contention.
    if (!res.ok && res.status !== 404) throw new Error(`read failed: ${res.status}`);
    const current =
      res.status === 404 ? undefined : ((await res.json()) as { value: Stock }).value;
    const etag = res.headers.get("etag"); // null when the key doesn't exist yet
    say(
      `GET ${key} → ${res.status}` +
        (etag ? `  (etag: ${etag}, value: ${JSON.stringify(current)})` : "  (no such key)"),
    );

    const next = mutate(current); // may throw, e.g. "sold out"
    const put = await fetch(`/_api/data/shared/${key}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        // Claim an unwritten key; otherwise CAS on exactly what you read.
        ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
      },
      body: JSON.stringify(next),
    });
    const putEtag = put.headers.get("etag");
    say(
      `PUT ${key} (${etag ? `if-match: ${etag}` : "if-none-match: *"}) → ${put.status}` +
        (putEtag ? `  (etag: ${putEtag})` : ""),
    );
    if (put.ok) return { value: next, version: (putEtag ?? '"?"').replaceAll('"', "") };

    if (put.status === 412) {
      const body = (await put.json().catch(() => null)) as ApiErrorBody | null;
      const currentVersion = body?.error?.details?.currentVersion;
      say(
        `  ↳ 412 conflict — someone else wrote first; the shelf is now at version ` +
          `${currentVersion ?? "unknown"}. Re-reading and retrying (attempt ${attempt + 1})…`,
      );
      continue; // the loop's re-read picks up the winner's value
    }
    const body = (await put.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(`write failed: ${put.status} ${body?.error?.code ?? ""}`.trim());
  }
  throw new Error(`"${key}" is contended — gave up after 3 attempts`);
}

/** Initial paint: read the shelf (and show the ETag doing its quiet job). */
async function refresh(): Promise<void> {
  try {
    const res = await fetch(`/_api/data/shared/${STOCK_KEY}`);
    if (res.status === 404) {
      log(`GET ${STOCK_KEY} → 404  (nothing written yet — restock to begin)`);
      renderStock(null, null);
      return;
    }
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const { value } = (await res.json()) as { value: Stock };
    const etag = res.headers.get("etag");
    log(`GET ${STOCK_KEY} → 200  (etag: ${etag}, value: ${JSON.stringify(value)})`);
    renderStock(value, etag ? etag.replaceAll('"', "") : null);
  } catch (err) {
    shopStatus("bad", err instanceof Error ? err.message : String(err));
  }
}

/** Buy one widget — read-modify-write under CAS, with the retry visible. */
async function buy(): Promise<void> {
  shopStatus("", "");
  try {
    const { value, version } = await updateShared(
      STOCK_KEY,
      (current) => {
        const n = current?.count ?? 0;
        if (n <= 0) throw new Error("Sold out — the shelf is empty.");
        return { count: n - 1 };
      },
      log,
    );
    renderStock(value, version);
    shopStatus("ok", `One widget yours. ${value.count} left.`);
  } catch (err) {
    shopStatus("bad", err instanceof Error ? err.message : String(err));
    // A sold-out shelf may have been restocked since our read — resync.
    await refresh();
  }
}

/** Restock through the same loop — create-if-absent on first ever run. */
async function restock(): Promise<void> {
  shopStatus("", "");
  try {
    const { value, version } = await updateShared(STOCK_KEY, () => ({ count: 3 }), log);
    renderStock(value, version);
    shopStatus("ok", "Restocked to 3.");
  } catch (err) {
    shopStatus("bad", err instanceof Error ? err.message : String(err));
  }
}

/** Run a probe with its own output pane, and mirror the lines into the log. */
async function runProbe(name: string, fn: () => Promise<void>): Promise<void> {
  probeOut.textContent = `— ${name} —\n`;
  const say = (line: string): void => {
    probeLog(line);
    log(`[${name}] ${line}`);
  };
  try {
    await fn();
  } catch (err) {
    say(`!! ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Probe 1 — the ADR's lost-update scenario, forced with no second tab: read,
 * write, then write again with the SAME (now stale) precondition. Loses with
 * 412; the error body discloses the current version; one retry with it lands.
 */
async function probeStale(): Promise<void> {
  await runProbe("lose a race on purpose", async () => {
    const res = await fetch(`/_api/data/shared/${SCRATCH_KEY}`);
    if (!res.ok && res.status !== 404) throw new Error(`read failed: ${res.status}`);
    const etag = res.headers.get("etag");
    probeLog(`GET ${SCRATCH_KEY} → ${res.status}${etag ? `  (etag: ${etag})` : ""}`);

    // Write once with the fresh precondition — this is "the other tab" winning.
    const win = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
      },
      body: JSON.stringify({ count: Date.now() % 1000 }),
    });
    probeLog(
      `PUT (${etag ? `if-match: ${etag}` : "if-none-match: *"}) → ${win.status}  (the other tab wins)`,
    );
    if (!win.ok) throw new Error(`setup write failed: ${win.status}`);

    // Now replay the STALE precondition — this tab never saw the win.
    const stale = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
      },
      body: JSON.stringify({ count: -1 }),
    });
    const body = (await stale.json().catch(() => null)) as ApiErrorBody | null;
    probeLog(`PUT (same stale precondition) → ${stale.status} ${body?.error?.code ?? ""}`);
    if (stale.status !== 412) throw new Error(`expected 412, got ${stale.status}`);
    const current = body?.error?.details?.currentVersion;
    probeLog(
      `  ↳ lost the race. The 412 body discloses the current version: ${current ?? "?"}\n` +
        `  ↳ before CAS, this write would have silently clobbered the winner.`,
    );

    // In-band recovery: retry once with the disclosed version.
    const retry = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": `"${current}"` },
      body: JSON.stringify({ count: -1 }),
    });
    probeLog(`PUT (if-match: "${current}" — the disclosed version) → ${retry.status}  (recovered)`);
  });
}

/** Probe 2 — a shared write with no precondition is refused outright (428). */
async function probeRaw(): Promise<void> {
  await runProbe("write with no precondition", async () => {
    const res = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 0 }),
    });
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    probeLog(`PUT ${SCRATCH_KEY} (no If-Match / If-None-Match) → ${res.status}`);
    probeLog(`  ↳ ${body?.error?.code}: ${body?.error?.message}`);
    probeLog(`  ↳ a shared write must state what it believes. This is the platform asking.`);
  });
}

/** Probe 3 — If-None-Match: * is create-if-absent; the second claim 412s. */
async function probeClaim(): Promise<void> {
  await runProbe("claim the same key twice", async () => {
    for (const n of [1, 2]) {
      const res = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify({ count: n }),
      });
      const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
      probeLog(
        `claim #${n}: PUT (if-none-match: *) → ${res.status}` +
          (res.status === 412
            ? `  — already exists at version ${body?.error?.details?.currentVersion ?? "?"}`
            : `  (etag: ${res.headers.get("etag")})`),
      );
    }
    probeLog(`  ↳ exactly one claimant can ever win a key — that is create-if-absent.`);
  });
}

/** Probe 4 — If-Match: * asserts nothing, so it is refused like no header. */
async function probeStar(): Promise<void> {
  await runProbe("the If-Match: * escape hatch", async () => {
    const res = await fetch(`/_api/data/shared/${SCRATCH_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "*" },
      body: JSON.stringify({ count: 0 }),
    });
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    probeLog(`PUT ${SCRATCH_KEY} (if-match: *) → ${res.status} ${body?.error?.code ?? ""}`);
    probeLog(`  ↳ "any current representation" states no assumption — refused.`);
  });
}

buyBtn.addEventListener("click", () => void buy());
restockBtn.addEventListener("click", () => void restock());
document.querySelector("#probe-stale")!.addEventListener("click", () => void probeStale());
document.querySelector("#probe-raw")!.addEventListener("click", () => void probeRaw());
document.querySelector("#probe-claim")!.addEventListener("click", () => void probeClaim());
document.querySelector("#probe-star")!.addEventListener("click", () => void probeStar());

void refresh();
