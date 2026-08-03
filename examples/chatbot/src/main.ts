import "./style.css";

/**
 * A static chatbot that calls an LLM through the AZX gateway. There is no API
 * key in this code: the app POSTs to a same-origin gateway path, and the edge
 * injects the vendor key, enforces the app's model allowlist + budget, and
 * streams the reply back. The session cookie rides along automatically.
 *
 * It exercises BOTH gateway surfaces to show they are the same policy/metering
 * spine with a different wire format:
 *   - **Agnostic** — `POST /_api/llm/chat`, the platform's neutral shape, named-
 *     event SSE (`event: delta`).
 *   - **OpenAI** — `POST /_api/openai/v1/chat/completions`, the OpenAI wire, with
 *     `chat.completion.chunk` frames + `[DONE]`.
 * The model (a `claude-*` or `gpt-*`/`o*` id) routes to its vendor independently
 * of which surface you pick — the model list comes from the app's own allowlist
 * via `GET /_api/openai/v1/models`.
 */

const ENDPOINTS = {
  native: { label: "Agnostic — /_api/llm/chat", url: "/_api/llm/chat" },
  openai: { label: "OpenAI — /_api/openai/v1", url: "/_api/openai/v1/chat/completions" },
} as const;
type EndpointKey = keyof typeof ENDPOINTS;

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: string;
}

const messagesEl = document.querySelector<HTMLUListElement>("#messages")!;
const form = document.querySelector<HTMLFormElement>("#chat-form")!;
const input = document.querySelector<HTMLInputElement>("#chat-input")!;
const sendBtn = document.querySelector<HTMLButtonElement>("#send")!;
const whoamiEl = document.querySelector<HTMLParagraphElement>("#whoami")!;
const endpointSel = document.querySelector<HTMLSelectElement>("#endpoint")!;
const modelSel = document.querySelector<HTMLSelectElement>("#model")!;
const jsonModeEl = document.querySelector<HTMLInputElement>("#json-mode")!;

const history: Message[] = [];

let endpoint: EndpointKey = "native";
endpointSel.addEventListener("change", () => {
  endpoint = endpointSel.value as EndpointKey;
});

/** Append a bubble and return its content node so streaming can grow it. */
function addBubble(role: Role | "error", text = ""): HTMLElement {
  const li = document.createElement("li");
  li.className = `bubble ${role}`;
  const body = document.createElement("span");
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

/** A known-good default so the app can still chat when the model list can't load. */
const FALLBACK_MODEL = "claude-opus-4-8";

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
 * Populate the model picker from the app's own allowlist. The OpenAI-compatible
 * `GET /_api/openai/v1/models` returns exactly `capabilities.llm.models` (a mix
 * of `claude-*` and `gpt-*`/`o*`), so the dropdown mirrors what the app is
 * actually granted — nothing is hardcoded here.
 *
 * On any failure it falls back to a single known-good model rather than
 * hard-blocking, so a send still reaches the gateway and surfaces the *real*
 * error (`model_not_allowed`, 401, …) instead of a guess about the cause.
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

/** Native surface: `event: delta` records carry `{ text }`; `event: error` throws. */
function nativeRecord(record: string, onDelta: (text: string) => void): void {
  let event = "message";
  for (const line of record.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  const data = dataOf(record);
  if (!data) return;
  const parsed = JSON.parse(data) as Record<string, unknown>;
  if (event === "delta") onDelta(String(parsed.text ?? ""));
  else if (event === "error") throw new Error(String(parsed.message ?? "stream error"));
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

/**
 * "JSON mode" (ADR-0034): constrain the reply to a schema. The same intent is
 * spelled differently on each surface — neutral `responseFormat` vs OpenAI's
 * `response_format` — and either way the JSON arrives through the ordinary delta
 * frames, so the SSE readers above need no special case.
 */
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    followUps: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "followUps"],
  additionalProperties: false,
} as const;

function jsonModeBody(surface: EndpointKey): Record<string, unknown> {
  if (!jsonModeEl.checked) return {};
  // The gateway always enforces, so neither shape carries a `strict` flag.
  return surface === "openai"
    ? {
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema: ANSWER_SCHEMA },
        },
      }
    : { responseFormat: { type: "json_schema", name: "answer", schema: ANSWER_SCHEMA } };
}

/** Pretty-print a JSON-mode reply; fall back to the raw text if it isn't JSON. */
function prettify(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
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
  // real answer — an empty assistant turn (a refusal, an aborted stream, an
  // o-series empty completion) would poison every later request, since message
  // content is validated non-empty upstream.
  const outgoing: Message[] = [...history, { role: "user", content: text }];

  const reply = addBubble("assistant");
  let accumulated = "";
  const ep = ENDPOINTS[endpoint];
  const parseRecord = endpoint === "openai" ? openAiRecord : nativeRecord;

  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: outgoing,
        stream: true,
        ...jsonModeBody(endpoint),
      }),
    });

    if (!res.ok || !res.body) {
      // Both surfaces put a human message at `error.message`; a 401 is the
      // session gate (same on either surface), regardless of body shape.
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
      parseRecord(record, (delta) => {
        accumulated += delta;
        reply.textContent = accumulated;
        reply.parentElement?.scrollIntoView({ block: "end" });
      }),
    );
    if (accumulated) {
      // Re-render prettified once complete (partial JSON can't be parsed mid-stream).
      // History keeps the model's raw text — prettifying is display-only.
      if (jsonModeEl.checked) {
        reply.textContent = prettify(accumulated);
        reply.parentElement?.classList.add("json"); // the `li.bubble`, not the inner span
      }
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
