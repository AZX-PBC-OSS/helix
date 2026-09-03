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
 * The second half demonstrates ADR-0042: prefix grants + the list verb. The
 * waitlist is a set of records that GROWS at runtime — `record:<id>` keys under
 * a `record:` prefix grant — created with `If-None-Match: *` on the natural key
 * (create-if-absent is cross-record dedup for free) and enumerated with
 * `GET /_api/data/shared?prefix=record:`. No self-maintained `index` key: the
 * list verb IS the index, which deletes the lost-update race an index would
 * add and the 64 KiB ceiling an index would hit.
 *
 * Everything on screen is the platform's real behavior — the log pane prints
 * each exchange verbatim, and the probes drive deterministic collisions that
 * need no second tab.
 */

type Stock = { count: number };
/** One waitlist record — the value stored at `record:<id>`. */
type WaitlistRecord = { name: string; at: string };

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { currentVersion?: string | null } };
}

/** One entry of a list-verb page (ADR-0042) — key + version, never the value. */
interface SharedKeyEntry {
  key: string;
  version: string;
  updatedAt: string;
}
interface SharedListPage {
  keys: SharedKeyEntry[];
  nextCursor?: string;
}

const STOCK_KEY = "stock";
const SCRATCH_KEY = "scratch";
/** The waitlist's namespace (ADR-0042): every key starting with this is granted. */
const RECORD_PREFIX = "record:";
/** How many listed records to actually fetch + render (list gives keys only). */
const RECORD_RENDER_CAP = 8;

const countEl = document.querySelector<HTMLSpanElement>("#count")!;
const versionEl = document.querySelector<HTMLSpanElement>("#version")!;
const buyBtn = document.querySelector<HTMLButtonElement>("#buy")!;
const restockBtn = document.querySelector<HTMLButtonElement>("#restock")!;
const shopStatusEl = document.querySelector<HTMLParagraphElement>("#shop-status")!;
const logEl = document.querySelector<HTMLPreElement>("#log")!;
const probeOut = document.querySelector<HTMLPreElement>("#probe-out")!;
const probeOutRecords = document.querySelector<HTMLPreElement>("#probe-out-records")!;

/** Print one exchange line — the log pane is what makes CAS legible. */
function log(line: string): void {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function probeLog(line: string): void {
  probeOut.textContent += `${line}\n`;
}
/** Same, for the ADR-0042 probes' own pane. */
function recordsProbeLog(line: string): void {
  probeOutRecords.textContent += `${line}\n`;
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
async function runProbe(
  name: string,
  pane: HTMLPreElement,
  fn: () => Promise<void>,
): Promise<void> {
  pane.textContent = `— ${name} —\n`;
  const say = (line: string): void => {
    pane.textContent += `${line}\n`;
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
  await runProbe("lose a race on purpose", probeOut, async () => {
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
  await runProbe("write with no precondition", probeOut, async () => {
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
  await runProbe("claim the same key twice", probeOut, async () => {
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
  await runProbe("the If-Match: * escape hatch", probeOut, async () => {
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

// ── The waitlist: a runtime-growing shared namespace (ADR-0042) ──────────────

const recordsEl = document.querySelector<HTMLUListElement>("#records")!;
const recordsNoteEl = document.querySelector<HTMLParagraphElement>("#records-note")!;
const joinBtn = document.querySelector<HTMLButtonElement>("#join")!;
const waitlistStatusEl = document.querySelector<HTMLParagraphElement>("#waitlist-status")!;

function waitlistStatus(kind: "ok" | "bad" | "", text: string): void {
  waitlistStatusEl.className = `status${kind ? ` ${kind}` : ""}`;
  waitlistStatusEl.textContent = text;
}

/**
 * The index view: one list call per refresh. Keys + versions, never values —
 * the app fetches what it renders. `nextCursor` is noted but not walked (a
 * real app pages with it); this view caps at {@link RECORD_RENDER_CAP} fetches.
 */
async function refreshRecords(): Promise<void> {
  try {
    const res = await fetch(`/_api/data/shared?prefix=${encodeURIComponent(RECORD_PREFIX)}`);
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    const page = (await res.json()) as SharedListPage;
    log(`GET /_api/data/shared?prefix=${RECORD_PREFIX} → 200  (${page.keys.length} keys, versions included)`);

    recordsEl.textContent = "";
    const shown = page.keys.slice(0, RECORD_RENDER_CAP);
    for (const entry of shown) {
      // List gives metadata; the VALUE is a separate fetch per key.
      const get = await fetch(`/_api/data/shared/${encodeURIComponent(entry.key)}`);
      if (!get.ok) throw new Error(`read ${entry.key} failed: ${get.status}`);
      const { value } = (await get.json()) as { value: WaitlistRecord };
      const li = document.createElement("li");
      const keyEl = document.createElement("code");
      keyEl.textContent = entry.key;
      const vEl = document.createElement("span");
      vEl.className = "muted";
      vEl.textContent = ` v${entry.version} — `;
      li.append(keyEl, vEl, document.createTextNode(`${value.name} (${value.at.slice(0, 10)})`));
      recordsEl.append(li);
    }
    const more = page.keys.length - shown.length;
    recordsNoteEl.textContent =
      page.keys.length === 0
        ? "Empty — nobody has joined. Press “Join the waitlist”."
        : more > 0
          ? `…and ${more} more (a real app pages with nextCursor — the response is bounded at 200 keys).`
          : `The list verb is the index: no self-maintained “record index” key, no lost-update race on it.`;
  } catch (err) {
    waitlistStatus("bad", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Join: create a record at a natural key with create-if-absent. The id is
 * client-generated, so two visitors can never collide — and if one somehow
 * did, `If-None-Match: *` is the arbiter, not last-write-wins.
 */
async function joinWaitlist(): Promise<void> {
  waitlistStatus("", "");
  joinBtn.disabled = true;
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const key = `${RECORD_PREFIX}${id}`;
    const put = await fetch(`/_api/data/shared/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-none-match": "*" },
      body: JSON.stringify({ name: `visitor-${id}`, at: new Date().toISOString() } satisfies WaitlistRecord),
    });
    const etag = put.headers.get("etag");
    log(`PUT ${key} (if-none-match: *) → ${put.status}${etag ? `  (etag: ${etag})` : ""}`);
    if (!put.ok) throw new Error(`join failed: ${put.status}`);
    waitlistStatus("ok", `You're on the list — ${key}, version 1.`);
    await refreshRecords();
  } catch (err) {
    waitlistStatus("bad", err instanceof Error ? err.message : String(err));
  } finally {
    joinBtn.disabled = false;
  }
}

/**
 * Records probe 1 — CAS straight off the list. The list carries each key's
 * `version`, so an update needs NO per-key read first: list → pick →
 * `If-Match` the listed version. That's one round trip saved per record.
 */
async function probeCasOffList(): Promise<void> {
  await runProbe("update a record with no read", probeOutRecords, async () => {
    const res = await fetch(`/_api/data/shared?prefix=${encodeURIComponent(RECORD_PREFIX)}`);
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    const page = (await res.json()) as SharedListPage;
    const entry = page.keys[0];
    if (!entry) throw new Error("no records yet — join the waitlist first");
    recordsProbeLog(`GET ?prefix=${RECORD_PREFIX} → 200  (${page.keys.length} keys; first: ${entry.key} v${entry.version})`);

    const put = await fetch(`/_api/data/shared/${encodeURIComponent(entry.key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": `"${entry.version}"` },
      body: JSON.stringify({ name: "renamed-from-the-list", at: new Date().toISOString() } satisfies WaitlistRecord),
    });
    const etag = put.headers.get("etag");
    recordsProbeLog(
      `PUT ${entry.key} (if-match: "${entry.version}" — the LISTED version, no read) → ${put.status}` +
        (etag ? `  (etag: ${etag})` : ""),
    );
    if (put.status === 412) recordsProbeLog("  ↳ someone wrote between list and put — re-list and retry.");
    await refreshRecords();
  });
}

/**
 * Records probe 2 — enumeration is bounded by the grant (ADR-0042 decision 5).
 * A prefix the app was never granted is 403, not an empty list: the deny is
 * the point, and it is visible in the portal's audit ledger as `forbidden`.
 */
async function probeDenyList(): Promise<void> {
  await runProbe("list a prefix you were never granted", probeOutRecords, async () => {
    const res = await fetch("/_api/data/shared?prefix=secret:");
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    recordsProbeLog(`GET ?prefix=secret: → ${res.status} ${body?.error?.code ?? ""}`);
    recordsProbeLog("  ↳ the listing prefix must be covered by a shared-read PREFIX grant.");
    recordsProbeLog("  ↳ enumeration widens reading from guessable keys to granted keys — and no further.");
  });
}

/** Records probe 3 — there is no list-everything form; the prefix is required. */
async function probeNoPrefix(): Promise<void> {
  await runProbe("list with no prefix at all", probeOutRecords, async () => {
    const res = await fetch("/_api/data/shared");
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    recordsProbeLog(`GET /_api/data/shared (no prefix) → ${res.status} ${body?.error?.code ?? ""}`);
    recordsProbeLog("  ↳ without prefix grants the manifest IS the list; with them, the prefix scopes it.");
  });
}

/**
 * Records probe 4 — outside the granted namespace, guessing still gets
 * nothing: `record:` covers exactly the keys that start with it, and the
 * literal grants (`stock`, `scratch`) are unchanged beside it.
 */
async function probeGuessOutside(): Promise<void> {
  await runProbe("read a key outside the grant", probeOutRecords, async () => {
    const res = await fetch("/_api/data/shared/inventory");
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    recordsProbeLog(`GET /_api/data/shared/inventory → ${res.status} ${body?.error?.code ?? ""}`);
    recordsProbeLog("  ↳ startsWith is exact: “record:” grants a namespace, not a fuzzy match.");
  });
}

joinBtn.addEventListener("click", () => void joinWaitlist());
document.querySelector("#probe-cas-list")!.addEventListener("click", () => void probeCasOffList());
document.querySelector("#probe-deny-list")!.addEventListener("click", () => void probeDenyList());
document.querySelector("#probe-no-prefix")!.addEventListener("click", () => void probeNoPrefix());
document.querySelector("#probe-guess")!.addEventListener("click", () => void probeGuessOutside());

// Initial paint: the shelf, then the waitlist.
void refresh();
void refreshRecords();
