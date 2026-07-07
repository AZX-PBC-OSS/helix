import { z } from "zod";
import type { LlmMessage } from "./llm.js";

/**
 * OpenAI-compatible chat-completions contract (the `POST /v1/chat/completions`
 * lingua franca). This is the **builder-facing** shape — not the app-facing
 * `/_api/llm/chat` gateway, which stays provider-neutral in its own dialect.
 *
 * The point of speaking OpenAI's wire format here is provider-agnosticism *by
 * construction*: any tool that talks to OpenAI (bolt.diy, aider, OpenHands,
 * Cursor, the OpenAI SDK itself) can point at the platform's LLM seam unedited,
 * so the builder is never chained to a vendor SDK. Agnosticism about the
 * *upstream* lives behind the `LlmProvider` seam in the edge; agnosticism about
 * the *client* lives here, in the choice of an open interchange format.
 *
 * We accept a deliberate subset — the fields a chat client actually sends — and
 * translate it to the neutral {@link ./llm.js LlmChatRequest} the provider seam
 * consumes. Unknown fields (temperature, top_p, stream_options, …) are ignored
 * rather than rejected, so a fuller client still works.
 */

/**
 * A chat turn in OpenAI shape. `content` is a plain string or an array of
 * content parts (the multimodal form); we read the text parts and ignore the
 * rest. `system`/`developer` roles carry the system prompt (which the neutral
 * shape hoists out of the message list); `tool` messages are dropped in this
 * subset.
 */
export const OpenAiChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() })),
  ]),
});
export type OpenAiChatMessage = z.infer<typeof OpenAiChatMessageSchema>;

/**
 * `POST /v1/chat/completions` request. Only the fields we honor are modeled;
 * `max_completion_tokens` is OpenAI's newer name for `max_tokens` and wins when
 * both are present. Extra keys are stripped, not rejected.
 */
export const OpenAiChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OpenAiChatMessageSchema).min(1),
  max_tokens: z.int().positive().optional(),
  max_completion_tokens: z.int().positive().optional(),
  stream: z.boolean().default(false),
});
export type OpenAiChatRequest = z.infer<typeof OpenAiChatRequestSchema>;

/** Flatten OpenAI `content` (string | text-parts) to a single string. */
export function openAiContentToText(content: OpenAiChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * Translate an OpenAI message list into the neutral shape the provider seam
 * wants: system/developer turns are concatenated into a single `system` string
 * (Anthropic carries the system prompt out-of-band), and user/assistant turns
 * become the `messages` array. `tool` turns and any turn whose text is empty
 * are dropped — Anthropic rejects empty content, and the demo has no tool loop.
 */
export function openAiMessagesToNeutral(messages: OpenAiChatMessage[]): {
  system?: string;
  messages: LlmMessage[];
} {
  const systemParts: string[] = [];
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const text = openAiContentToText(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") continue;
    if (!text) continue;
    out.push({ role: m.role, content: text });
  }
  const system = systemParts.join("\n\n");
  return system ? { system, messages: out } : { messages: out };
}

/**
 * Map an Anthropic-style stop reason onto an OpenAI `finish_reason`. The
 * provider seam yields Anthropic's vocabulary today; OpenAI clients key their
 * UI off `stop`/`length`/`tool_calls`, so translate rather than leak it.
 */
export function finishReasonFromStopReason(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    // "end_turn", "stop_sequence", "refusal", anything else → a clean stop.
    default:
      return "stop";
  }
}

/** An OpenAI-shaped error body (`{ error: { message, type, code } }`). */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string | null };
}

export function openAiError(
  message: string,
  type: string,
  code: string | null = null,
): OpenAiErrorBody {
  return { error: { message, type, code } };
}
