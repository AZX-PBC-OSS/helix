import { providerForModel, type LlmChatRequest, type ModelProvider } from "@azx-pbc/shared";
import {
  LlmProviderError,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOpts,
} from "./provider.js";

/**
 * Dispatches an LLM call to the right upstream by model, using the catalog's
 * `provider` field as the single source of truth (`providerForModel`). There is
 * no id-space overlap between the `claude-*` and `gpt-*`/`o*` families, so the
 * routing is unambiguous.
 *
 * Each sub-provider is nullable: a deployment may wire Anthropic, OpenAI, or
 * both. `supports()` lets the handler 503 a curated model whose family upstream
 * isn't configured on this edge *before* it opens a stream — the model is real
 * and priced, it just has nowhere to go here.
 *
 * The handler has already validated that the model is allowlisted + priced, so a
 * model reaching `stream()` is known to the catalog; an unknown model (no
 * `providerForModel`) can only arrive via misuse and fails closed.
 */
export class RoutingLlmProvider implements LlmProvider {
  readonly #byProvider: Partial<Record<ModelProvider, LlmProvider>>;

  constructor(providers: { anthropic?: LlmProvider | null; openai?: LlmProvider | null }) {
    this.#byProvider = {};
    if (providers.anthropic) this.#byProvider.anthropic = providers.anthropic;
    if (providers.openai) this.#byProvider.openai = providers.openai;
  }

  supports(model: string): boolean {
    const family = providerForModel(model);
    return family !== undefined && this.#byProvider[family] !== undefined;
  }

  async *stream(req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent> {
    const family = providerForModel(req.model);
    const provider = family && this.#byProvider[family];
    if (!provider) {
      // Reached only if the handler skipped the supports() pre-check; fail closed
      // with an upstream-shaped error (surfaced during iteration, like every
      // other provider) rather than a silent hang.
      throw new LlmProviderError(`no upstream configured for model "${req.model}"`, 503);
    }
    yield* provider.stream(req, opts);
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.#byProvider).map((p) => p.close()));
  }
}
