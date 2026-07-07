/**
 * `@helix/app-sdk` — the one seam a Helix app reaches platform capabilities
 * through, with a **swappable transport** so the *same app code* runs in dev and
 * prod (docs/design/dev-mode.md §8).
 *
 * - **Deployed** (served by the edge): calls its own origin's `/_api/*` under the
 *   visitor's session cookie. No config needed — `base` is "" (same-origin).
 * - **Cross-origin dev preview** (WebContainer/Lovable): calls the dev host with
 *   a bearer dev token + the app slug. Config is injected as `globalThis.__HELIX__`
 *   by the preview environment.
 *
 * The app never branches on environment — it calls `helix.llm.chat(...)` and the
 * transport is selected from config. Zero runtime dependencies: an app bundles
 * this without pulling anything else in.
 *
 * Today only the LLM capability is wired (the dev-gateway spike is LLM-only —
 * see apps/edge/src/dev/). `data`/`fetch` land here when the real dev tier does.
 */

export interface HelixConfig {
  /** Base origin for `/_api/*` calls. "" (default) = same-origin (deployed). */
  base?: string;
  /** Dev bearer token; its presence selects the cross-origin dev transport. */
  token?: string;
  /** App slug — required by the dev host (prod derives it from the origin). */
  app?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Optional system prompt (carried out-of-band, like the gateway contract). */
  system?: string;
  maxTokens?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  stopReason: string;
  usage: ChatUsage;
}

export interface ChatStreamOptions {
  /** Called with each text delta as it streams in. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface HelixClient {
  llm: {
    /** Stream a chat completion; resolves with the full text once `done` arrives. */
    chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult>;
  };
}

interface HelixGlobal {
  __HELIX__?: HelixConfig;
}

/** Explicit config wins; else the preview-injected `globalThis.__HELIX__`; else same-origin. */
function resolveConfig(config?: HelixConfig): HelixConfig {
  if (config) return config;
  return (globalThis as unknown as HelixGlobal).__HELIX__ ?? {};
}

export function createHelixClient(config?: HelixConfig): HelixClient {
  const cfg = resolveConfig(config);
  const base = cfg.base ?? "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  // A token means the cross-origin dev transport: authenticate as the developer
  // and name the app (prod needs neither — cookie + origin carry both).
  if (cfg.token) {
    headers.authorization = `Bearer ${cfg.token}`;
    if (cfg.app) headers["x-helix-dev-app"] = cfg.app;
  }

  return {
    llm: {
      async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatResult> {
        const res = await fetch(`${base}/_api/llm/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...req, stream: true }),
          signal: opts?.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`helix llm chat failed: HTTP ${res.status}`);
        }
        return await readSse(res.body, opts?.onDelta);
      },
    },
  };
}

/** Read the neutral gateway SSE (`event: delta|done|error`) into a ChatResult. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let stopReason = "end_turn";
  let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const record = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const { event, data } = parseRecord(record);
      if (!data) continue;
      const payload = JSON.parse(data) as {
        text?: string;
        stopReason?: string;
        usage?: ChatUsage;
        message?: string;
      };
      if (event === "delta" && typeof payload.text === "string") {
        text += payload.text;
        onDelta?.(payload.text);
      } else if (event === "done") {
        stopReason = payload.stopReason ?? stopReason;
        if (payload.usage) {
          usage = {
            inputTokens: payload.usage.inputTokens,
            outputTokens: payload.usage.outputTokens,
          };
        }
      } else if (event === "error") {
        throw new Error(payload.message ?? "helix llm error");
      }
    }
  }
  return { text, stopReason, usage };
}

function parseRecord(record: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: dataLines.join("\n") };
}
