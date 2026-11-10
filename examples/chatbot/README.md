# chatbot

A static chatbot that talks to Claude **through the AZX gateway**, not directly.
It's the canonical exercise for the M4 LLM proxy: the app holds no vendor key,
makes a same-origin `POST /_api/openai/v1/chat/completions`, and renders the streamed reply.

```text
browser → edge /_api/openai/v1/chat/completions → egress → model provider
        ← OpenAI chat completion chunks and [DONE] ← streamed reply
```

- **No secrets in the bundle.** Egress injects the vendor key; the app sends
  OpenAI-compatible requests with `model`, `messages`, `max_tokens`, and `stream`.
  The model picker lists the app's allowlist from `/_api/openai/v1/models`.
- **Session-gated.** `/_api/openai/v1/chat/completions` is behind the same session as the rest of
  the app; an unauthenticated fetch gets a 401 (the app prompts to sign in).
- **Metered + allowlisted.** The model must be in the app's manifest
  `capabilities.llm.models`, and calls count against `dollarsPerDay`.
- **JSON mode.** The "JSON mode" toggle sends `response_format` with a
  `json_schema` so the reply is schema-constrained JSON,
  pretty-printed on arrival — see
  [structured output](../../docs/features/llm-gateway.md#structured-output). Needs a
  model that can enforce a schema (`claude-haiku-4-5`, `claude-opus-4-8`,
  `claude-fable-5`, any `gpt-*`/`o*`); others `400`.

## Grant the LLM capability

Unlike `hello-world`/`notes`, this app needs an LLM grant in its manifest
(architecture §6.3). After `helix create`, set it with the portal API (the CLI
manifest command is a later addition):

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/chatbot/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"llm":{"models":["claude-haiku-4-5"],"dollarsPerDay":5}}}'
```

You can also pass `capabilities` in the `POST /api/v1/apps` create body.

## Build & deploy

```bash
cd examples/chatbot
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Chatbot"
# grant the llm capability (see above)
helix deploy --promote
```

The LLM capability routes through `helix-egress` — the edge never holds the
vendor key. To serve it locally:

```bash
# 1. Seal the vendor key into the secret store (once). The key is read here
#    only to encrypt it; the edge never sees it.
EDGE_LLM_ANTHROPIC_KEY=sk-ant-… pnpm --filter @azx-pbc/portal seed:llm

# 2. Run the mechanism plane (resolves + injects the sealed key).
pnpm dev:egress

# 3. Run the edge with egress configured (EDGE_EGRESS_URL +
#    HELIX_INSTRUCTION_SECRET are set in the devcontainer env).
pnpm dev:edge
```

Without egress configured, `/_api/openai/v1/chat/completions` returns `503`
with OpenAI error type `api_error`. The edge has no direct-to-vendor path.

Then open `https://chatbot.local.helix.azxlabs.io:8080`, sign in, and chat.
