# chatbot

A static chatbot that talks to Claude **through the AZX gateway**, not directly.
It's the canonical exercise for the M4 LLM proxy: the app holds no vendor key,
makes a same-origin `POST /_api/llm/chat`, and renders the streamed reply.

```
browser ──POST /_api/llm/chat──▶ edge ──(injects key, checks allowlist+budget)──▶ Claude
        ◀──────── SSE deltas ──────────────────── streamed back ──────────────────┘
```

- **No secrets in the bundle.** The edge holds the Anthropic key; the app sends
  the platform's neutral request shape (`{ model, messages, stream }`).
- **Session-gated.** `/_api/llm/chat` is behind the same session as the rest of
  the app; an unauthenticated fetch gets a 401 (the app prompts to sign in).
- **Metered + allowlisted.** The model must be in the app's manifest
  `capabilities.llm.models`, and calls count against `tokensPerDay`.

## Grant the LLM capability

Unlike `hello-world`/`notes`, this app needs an LLM grant in its manifest
(architecture §6.3). After `azx create`, set it with the portal API (the CLI
manifest command is a later addition):

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/chatbot/manifest" \
  -H "authorization: Bearer $AZX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"llm":{"models":["claude-opus-4-8"],"tokensPerDay":200000}}}'
```

You can also pass `capabilities` in the `POST /api/v1/apps` create body.

## Build & deploy

```bash
cd examples/chatbot
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export AZX_TOKEN="$PORTAL_DEV_TOKEN"
azx create --display-name "Chatbot"
# grant the llm capability (see above)
azx deploy --promote
```

The edge needs a vendor key to serve the capability — put
`EDGE_LLM_ANTHROPIC_KEY=sk-ant-…` in the gitignored `apps/edge/.env.local`
(or the environment) before `pnpm dev:edge`. Without it, `/_api/llm/chat`
returns `503 capability_unavailable`.

Then open `https://chatbot.localtest.me:8080`, sign in, and chat.
