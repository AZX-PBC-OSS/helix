import "./style.css";

/**
 * helix-help — a docs-grounded chatbot for Helix app developers, and the
 * example of the two read-only gateway surfaces working together:
 *
 *   1. **The fetch proxy** loads the platform's public documentation at
 *      runtime. The docs site (a static GitHub Pages site) serves a markdown
 *      twin of every page plus an `llms.txt` index; the app fetches a
 *      hand-picked subset through `/_api/fetch/<url>` and embeds it in the
 *      system prompt. No secret, no RAG, no embeddings — just ~10K tokens of
 *      real docs re-sent with each turn.
 *   2. **The OpenAI-compatible surface** (`/_api/openai/v1/*`) does the
 *     chatting: streaming `chat/completions` with the session cookie, the
 *     model allowlisted in the app's manifest, the vendor key injected
 *     server-side by egress.
 *
 * There is no API key in this bundle and no server of its own.
 */

/** The public docs site (GitHub Pages, site base path `/helix/`). */
const DOCS_BASE = "https://azx-pbc-oss.github.io/helix";

/**
 * The "Building apps" subset, picked for the audience: developers writing and
 * deploying Helix apps (plus `deploy/local-dev`, since that is how they run
 * the platform to test against). Each page's `.md` twin is fetched separately
 * through the proxy — together they are ~38 KB (~10K tokens), so the whole
 * thing fits in the system prompt and RAG stays out of the picture.
 */
const DOCS_PAGES = [
  "apps/quickstart",
  "apps/manifest",
  "apps/gateway",
  "apps/cli",
  "deploy/local-dev",
] as const;

/** A known-good default so the app can still chat when the model list can't load. */
const FALLBACK_MODEL = "gpt-5-mini";

/** History cap: bounds the per-turn payload on top of the docs system prompt. */
const HISTORY_LIMIT = 20;

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: string;
}

/** What a docs page fetch turned up, for the status chip and the system prompt. */
interface DocsState {
  /** page path (e.g. `apps/quickstart`) → markdown body. */
  pages: Map<string, string>;
  /** Pages that failed, with the reason the proxy surfaced. */
  failures: Array<{ page: string; detail: string }>;
}

const messagesEl = document.querySelector<HTMLUListElement>("#messages")!;
const form = document.querySelector<HTMLFormElement>("#chat-form")!;
const input = document.querySelector<HTMLInputElement>("#chat-input")!;
const sendBtn = document.querySelector<HTMLButtonElement>("#send")!;
const whoamiEl = document.querySelector<HTMLParagraphElement>("#whoami")!;
const docsEl = document.querySelector<HTMLParagraphElement>("#docs-status")!;
const modelSel = document.querySelector<HTMLSelectElement>("#model")!;

const history: Message[] = [];

/** Set once the boot docs fetch settles; read again on every send. */
let docs: DocsState | null = null;

/** Append a bubble and return its content node so streaming can grow it. */
function addBubble(role: Role | "error", text = ""): HTMLDivElement {
  const li = document.createElement("li");
  li.className = `bubble ${role}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  li.append(body);
  messagesEl.append(li);
  li.scrollIntoView({ block: "end" });
  return body;
}

/** Show who the gateway sees us as (Appendix A.6 `/_api/me`). */
async function loadWhoami(): Promise<void> {
  try {
    const res = await fetch("/_api/me", { headers: { accept: "application/json" } });
    if (res.status === 401) {
      whoamiEl.innerHTML = `Not signed in — <a href="/">sign in</a> to chat.`;
      return;
    }
    if (!res.ok) return;
    const me = (await res.json()) as { user: { displayName: string } };
    whoamiEl.textContent = `Signed in as ${me.user.displayName}`;
  } catch {
    /* offline / dev — leave it blank */
  }
}

function setModels(ids: string[], disabled = false): void {
  modelSel.innerHTML = "";
  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    modelSel.append(opt);
  }
  modelSel.disabled = disabled;
}

/**
 * Populate the model picker from the app's own allowlist, exactly like
 * `chatbot` does — `GET /_api/openai/v1/models` mirrors
 * `capabilities.llm.models`, nothing is hardcoded. On any failure it falls
 * back to a single known-good model rather than hard-blocking, so a send
 * still reaches the gateway and surfaces the *real* error.
 */
async function loadModels(): Promise<void> {
  try {
    const res = await fetch("/_api/openai/v1/models", { headers: { accept: "application/json" } });
    if (!res.ok) {
      setModels([FALLBACK_MODEL]);
      return;
    }
    const list = (await res.json()) as { data: Array<{ id: string }> };
    setModels(list.data.length > 0 ? list.data.map((m) => m.id) : [FALLBACK_MODEL]);
  } catch {
    setModels([FALLBACK_MODEL]);
  }
}

/**
 * Fetch one docs page **through the fetch proxy**: the target URL is spliced
 * raw into the path (no JSON envelope), the session cookie rides along, and
 * the edge checks the app's manifest origin grant before egress makes the
 * call. Proxy errors are a small JSON body: `{ code, message }`.
 */
async function fetchDocPage(page: string): Promise<string> {
  const res = await fetch(`/_api/fetch/${DOCS_BASE}/${page}.md`, {
    headers: { accept: "text/plain" },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    throw new Error(err?.message ?? `${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Fetch every docs page in parallel; partial success is kept, not discarded. */
async function loadDocs(): Promise<DocsState> {
  const results = await Promise.allSettled(DOCS_PAGES.map((p) => fetchDocPage(p)));
  const state: DocsState = { pages: new Map(), failures: [] };
  results.forEach((r, i) => {
    const page = DOCS_PAGES[i]!;
    if (r.status === "fulfilled") state.pages.set(page, r.value);
    else state.failures.push({ page, detail: String(r.reason) });
  });
  return state;
}

/** The status chip in the header: what the bot knows and where it came from. */
function renderDocsStatus(state: DocsState | null): void {
  if (state === null) {
    docsEl.textContent = "Loading docs…";
    docsEl.classList.remove("bad");
    return;
  }
  const kb = ([...state.pages.values()].reduce((n, t) => n + t.length, 0) / 1024).toFixed(1);
  const failed = state.failures.map((f) => `${f.page} (${f.detail})`).join(", ");
  if (state.pages.size === 0) {
    docsEl.textContent = `Docs unavailable — replies will be from general knowledge. Last error: ${failed}`;
    docsEl.classList.add("bad");
  } else if (state.failures.length > 0) {
    docsEl.textContent = `Docs loaded: ${state.pages.size}/${DOCS_PAGES.length} pages · ${kb} KB · failed: ${failed}`;
    docsEl.classList.add("bad");
  } else {
    docsEl.textContent = `Docs loaded: ${state.pages.size} pages · ${kb} KB · via /_api/fetch → ${DOCS_BASE}`;
    docsEl.classList.remove("bad");
  }
}

/**
 * The system prompt: a short role preamble plus the fetched docs verbatim.
 * Rebuilt on every send so late-arriving doc pages are picked up mid-chat.
 */
function currentSystemPrompt(): string {
  const preamble = [
    "You are helix-help, a concise assistant for developers building apps that run on the Helix platform (the AZX App Platform).",
    `Answer from the platform documentation embedded below, and link the relevant pages (${DOCS_BASE}/<page>.md) for further reading.`,
    "If the documentation doesn't cover a question, say so, then answer from general knowledge and flag it as such.",
    "Format replies as markdown-lite: short paragraphs, bullet lists, `inline code`, and fenced code blocks.",
  ].join("\n");

  if (!docs || docs.pages.size === 0) {
    return `${preamble}\n\nThe documentation could not be loaded right now — answer from general knowledge and be explicit when you are unsure.`;
  }
  const pages = [...docs.pages].map(([page, md]) => `## doc: ${page}\n\n${md}`);
  return `${preamble}\n\n# Helix platform documentation\n\n${pages.join("\n\n---\n\n")}`;
}

/**
 * Minimal, injection-safe markdown → DOM: fenced code blocks, bullet lists,
 * headings as bold paragraphs, and inline `code` / **bold** / [links](url).
 * All text lands via `textContent`, and only `https:` hrefs are ever set, so
 * nothing in an LLM reply (or a fetched doc) can inject markup.
 */
function renderInline(target: HTMLElement, text: string): void {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const token = m[0];
    const idx = m.index ?? 0;
    if (idx > last) target.append(text.slice(last, idx));
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      target.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      target.append(strong);
    } else {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      if (href.startsWith("https://")) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = label;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        target.append(a);
      } else {
        target.append(token);
      }
    }
    last = idx + token.length;
  }
  if (last < text.length) target.append(text.slice(last));
}

function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      i++; // the closing fence (or end of input mid-stream)
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    if (line.startsWith("- ")) {
      const ul = document.createElement("ul");
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        const li = document.createElement("li");
        renderInline(li, lines[i]!.slice(2));
        ul.append(li);
        i++;
      }
      frag.append(ul);
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      const p = document.createElement("p");
      p.className = "md-heading";
      renderInline(p, line.replace(/^#{1,6} /, ""));
      frag.append(p);
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph: absorb until a blank line or the start of another block.
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("- ") &&
      !/^#{1,6} /.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    const p = document.createElement("p");
    renderInline(p, para.join("\n"));
    frag.append(p);
  }
  return frag;
}

/** Split an SSE body into records (blank-line separated) and hand each to `onRecord`. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      onRecord(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }
}

/** `data:` payload of an SSE record (concatenated `data:` lines). */
function dataOf(record: string): string {
  const lines: string[] = [];
  for (const line of record.split("\n")) {
    if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
  }
  return lines.join("\n");
}

/** OpenAI surface: `data: {chunk}` frames; `[DONE]` ends; an `error` object throws. */
function openAiRecord(record: string, onDelta: (text: string) => void): void {
  const data = dataOf(record);
  if (!data || data === "[DONE]") return;
  const parsed = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string } }>;
    error?: { message?: string };
  };
  if (parsed.error) throw new Error(parsed.error.message ?? "stream error");
  for (const choice of parsed.choices ?? []) {
    if (choice.delta?.content) onDelta(choice.delta.content);
  }
}

async function send(text: string): Promise<void> {
  const model = modelSel.value;
  if (!model) {
    addBubble("error", "No model selected — sign in so the model list can load.");
    return;
  }

  addBubble("user", text);
  // Send with the pending turn, but don't commit to `history` until we have a
  // real answer — an empty assistant turn (a refusal, an aborted stream)
  // would poison every later request, since message content is validated
  // non-empty upstream. History is capped: the docs system prompt is re-sent
  // with every turn, so the payload is bounded by construction.
  const recent = history.slice(-HISTORY_LIMIT);
  const outgoing: Array<{ role: "system" | Role; content: string }> = [
    { role: "system", content: currentSystemPrompt() },
    ...recent,
    { role: "user", content: text },
  ];

  const reply = addBubble("assistant");
  let accumulated = "";

  try {
    const res = await fetch("/_api/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: outgoing, stream: true }),
    });

    if (!res.ok || !res.body) {
      // The OpenAI surface puts a human message at `error.message`; a 401 is
      // the session gate regardless of body shape.
      const err = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      reply.parentElement?.classList.replace("assistant", "error");
      reply.textContent =
        res.status === 401
          ? "Your session expired — reload to sign in again."
          : `Request failed (${res.status}): ${err?.error?.message ?? res.statusText}`;
      return;
    }

    await readSse(res.body, (record) =>
      openAiRecord(record, (delta) => {
        accumulated += delta;
        reply.textContent = accumulated;
        reply.parentElement?.scrollIntoView({ block: "end" });
      }),
    );
    if (accumulated) {
      // Render markdown once complete (partial fences can't be parsed
      // mid-stream). History keeps the model's raw markdown — rendering is
      // display-only.
      reply.textContent = "";
      reply.append(renderMarkdown(accumulated));
      history.push({ role: "user", content: text }, { role: "assistant", content: accumulated });
    }
  } catch (err) {
    reply.parentElement?.classList.replace("assistant", "error");
    reply.textContent = `Stream error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  void send(text).finally(() => {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  });
});

void loadWhoami();
void loadModels();
renderDocsStatus(null);
void loadDocs().then((state) => {
  docs = state;
  renderDocsStatus(state);
});
