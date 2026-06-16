import "./style.css";

/**
 * Orbit waitlist — a PUBLIC AZX app (no login) showcasing the app-data gateway
 * (app-data design §3). It exercises two of the three scopes that are safe for a
 * public, anonymous app:
 *
 *   - collection (§3.2): visitors POST their contact info to a *write-only*
 *     collection. There is no read/list verb at the edge and the edge DB role
 *     is INSERT-only, so no visitor (and no attacker) can ever dump the list.
 *     The owner drains it from the portal.
 *   - shared-read (§3.3): an owner-seeded announcement every visitor may read.
 *
 * No vendor key, no DB credentials, no backend — the edge enforces everything.
 */

const announceEl = document.querySelector<HTMLParagraphElement>("#announce")!;
const form = document.querySelector<HTMLFormElement>("#form")!;
const nameEl = document.querySelector<HTMLInputElement>("#name")!;
const emailEl = document.querySelector<HTMLInputElement>("#email")!;
const noteEl = document.querySelector<HTMLTextAreaElement>("#note")!;
const submitEl = document.querySelector<HTMLButtonElement>("#submit")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const proveBtn = document.querySelector<HTMLButtonElement>("#prove")!;
const proveOut = document.querySelector<HTMLPreElement>("#prove-out")!;

/** Read the owner-seeded shared announcement (§3.3 sharedRead), if any. */
async function loadAnnouncement(): Promise<void> {
  try {
    const res = await fetch("/_api/data/shared/announcement", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return; // 404 = not seeded yet; just leave the banner hidden.
    const { value } = (await res.json()) as { value: unknown };
    if (typeof value === "string" && value) {
      announceEl.textContent = value;
      announceEl.hidden = false;
    }
  } catch {
    /* offline / dev — leave it hidden */
  }
}

/** Append one signup to the write-only `signups` collection (§3.2). */
async function submit(): Promise<void> {
  const item = {
    name: nameEl.value.trim(),
    email: emailEl.value.trim(),
    note: noteEl.value.trim() || undefined,
  };

  const res = await fetch("/_api/data/collections/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });

  if (res.status === 201) {
    form.querySelectorAll("label").forEach((l) => l.remove());
    submitEl.remove();
    statusEl.classList.add("ok");
    statusEl.textContent = `You're on the list, ${item.name.split(" ")[0] || "friend"}. We'll be in touch.`;
    return;
  }

  // Surface the gateway's stable error envelope.
  const err = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  const code = err?.error?.code;
  statusEl.classList.add("bad");
  statusEl.textContent =
    code === "quota_exceeded"
      ? "The waitlist is taking a quick breather (daily limit) — try again tomorrow."
      : `Couldn't submit${code ? ` (${code})` : ""}: ${err?.error?.message ?? res.statusText}`;
}

/**
 * Demonstrate the write-only property: a GET on the collection path has no verb
 * at the edge, so it is refused. The list cannot be enumerated from the browser.
 */
async function proveWriteOnly(): Promise<void> {
  proveBtn.disabled = true;
  proveOut.textContent = "GET /_api/data/collections/signups …";
  try {
    const res = await fetch("/_api/data/collections/signups", {
      headers: { accept: "application/json" },
    });
    const body = await res.text();
    proveOut.textContent =
      `HTTP ${res.status} ${res.statusText}\n` +
      `${body || "(no body)"}\n\n` +
      `→ No read verb exists. Your submission — and everyone else's — is unreadable from here.`;
  } catch (err) {
    proveOut.textContent = `Request blocked: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    proveBtn.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  statusEl.className = "status";
  statusEl.textContent = "";
  submitEl.disabled = true;
  void submit().finally(() => {
    submitEl.disabled = false;
  });
});

proveBtn.addEventListener("click", () => void proveWriteOnly());

void loadAnnouncement();
