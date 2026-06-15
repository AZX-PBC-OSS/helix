import "./style.css";

/**
 * A static chatbot that calls Claude through the AZX gateway. There is no API
 * key in this code: the app POSTs the platform's neutral chat shape to the
 * same-origin path `/_api/llm/chat`, and the edge injects the vendor key,
 * enforces the app's model allowlist + token budget, and streams the reply
 * back as Server-Sent Events. The session cookie rides along automatically.
 */

const MODEL = "claude-opus-4-8";

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

const history: Message[] = [];

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

/** Parse the gateway's SSE stream, invoking `onDelta` for each text chunk. */
async function streamChat(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
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
      const record = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      handleRecord(record, onDelta);
    }
  }
}

function handleRecord(record: string, onDelta: (text: string) => void): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  if (event === "delta") onDelta(String(data.text ?? ""));
  else if (event === "error") throw new Error(String(data.message ?? "stream error"));
}

async function send(text: string): Promise<void> {
  history.push({ role: "user", content: text });
  addBubble("user", text);

  const reply = addBubble("assistant");
  let accumulated = "";

  try {
    const res = await fetch("/_api/llm/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: history, stream: true }),
    });

    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      const code = err?.error?.code;
      reply.parentElement?.classList.replace("assistant", "error");
      reply.textContent =
        code === "unauthorized"
          ? "Your session expired — reload to sign in again."
          : `Request failed${code ? ` (${code})` : ""}: ${err?.error?.message ?? res.statusText}`;
      return;
    }

    await streamChat(res.body, (delta) => {
      accumulated += delta;
      reply.textContent = accumulated;
      reply.parentElement?.scrollIntoView({ block: "end" });
    });
    history.push({ role: "assistant", content: accumulated });
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
