# helix-help

A **docs-grounded chatbot** for people building Helix apps — and the example of two
gateway surfaces cooperating with no backend of its own: the app loads the platform
documentation **at runtime through the fetch proxy** and answers questions over the
**OpenAI-compatible LLM surface**.

```
boot:   browser ──GET /_api/fetch/https://azx-pbc-oss.github.io/helix/apps/quickstart.md──▶
        edge (manifest origin grant) ──▶ egress (SSRF checks) ──▶ GitHub Pages

turn:   browser ──POST /_api/openai/v1/chat/completions──▶
        edge (allowlist + budget, meters) ──▶ egress (injects vendor key) ──▶ gpt-5-mini
              ◀──────────────────── SSE deltas streamed back ──────────────────────┘
```

- **No secrets in the bundle, no RAG, no embeddings.** The docs site serves a
  markdown twin of every page; the app fetches five of them (the "Building apps"
  core + local dev), concatenates them into the system prompt, and re-sends them
  each turn. No vector store, no index — the whole context is **~38 KB
  (~10K tokens)**, well within any modern model's window.
- **Keyless origin grant.** The fetch proxy needs only
  `capabilities.fetch.origins: [{ origin: "https://azx-pbc-oss.github.io" }]` in
  the manifest — no connection secret, no admin approval. Egress still applies its
  SSRF controls; the edge meters the call.
- **Session-gated.** Both `/_api/fetch/*` and `/_api/openai/v1/*` ride the same
  session as the rest of the app; an unauthenticated fetch gets a 401 (the app
  prompts to sign in).
- **Metered + allowlisted.** The model must be in the manifest
  `capabilities.llm.models`, and calls count against `dollarsPerDay`. At ~10K
  input tokens per turn, `gpt-5-mini` prices this well under a cent — the budget
  is effectively unbounded.
- **Degrades gracefully.** Docs load in parallel and partial failure is kept (the
  status chip shows `4/5 pages`); if none load, the bot says it's answering from
  general knowledge. Replies render as markdown-lite, built with `textContent`
  only — nothing from the model is ever parsed as HTML.

## Grant the capabilities

Unlike `hello-world`/`notes`, this app needs an LLM grant and a fetch-proxy origin
grant in its manifest. After `helix create`, set it with the portal API:

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/helix-help/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"llm":{"models":["gpt-5-mini"],"dollarsPerDay":2},"fetch":{"origins":[{"origin":"https://azx-pbc-oss.github.io"}]}}}'
```

You can also pass `capabilities` in the `POST /api/v1/apps` create body.

## Build & deploy

```bash
cd examples/helix-help
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Helix Help"
# grant the capabilities (see above)
helix deploy --promote
```

Both capabilities route through `helix-egress` — the LLM call for the vendor key,
the docs fetch for its SSRF controls. To serve it locally:

```bash
# 1. Seal a vendor key into the secret store (once), for the LLM surface.
EDGE_LLM_OPENAI_KEY=sk-… pnpm --filter @azx-pbc/portal seed:llm

# 2. Run the mechanism plane (injects the key; fronts the docs fetch).
pnpm dev:egress

# 3. Run the edge with egress configured (EDGE_EGRESS_URL +
#    HELIX_INSTRUCTION_SECRET are set in the devcontainer env).
pnpm dev:edge
```

Without egress configured, both surfaces fail closed — `503
capability_unavailable` for the chat, `503` from the proxy for the docs fetch.

Then open `https://helix-help.local.helix.azxlabs.io:8080`, sign in, wait for the
docs chip to read `5 pages`, and ask something like *"how do I grant my app an LLM
budget?"* or *"what does the manifest's fetch capability look like?"*.
