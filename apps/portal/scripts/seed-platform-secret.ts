import type { SecretStore } from "@azx-pbc/secret-store";
import { InjectionRecipeSchema, type InjectionRecipe } from "@azx-pbc/shared";
import { createPrismaClient } from "../src/db/client.js";
import { createSecretStoreFromEnv } from "../src/secrets/custody.js";

/**
 * Dev convenience: seed the platform LLM vendor secret so `pnpm dev:edge` +
 * `pnpm dev:egress` serve the LLM gateway without a key in edge env (secrets
 * design §1 — the edge never holds the vendor key). Idempotent: if a platform
 * secret with the connection name already exists, it is left alone unless
 * `--force` is passed (which rotates it to the new value).
 *
 * Usage (from repo root):
 *   EDGE_LLM_ANTHROPIC_KEY=sk-ant-... pnpm --filter @azx-pbc/portal seed:llm
 *   pnpm --filter @azx-pbc/portal seed:llm -- sk-ant-...        # value as an arg
 *   pnpm --filter @azx-pbc/portal seed:llm -- --force           # rotate existing
 *
 * `--name` / `--recipe` cover non-Anthropic upstreams (ADR-0046 key mode — the
 * local-dev and BYO path, since a dev container has no managed identity). A
 * Foundry account key seeds both families, matching the connection names in
 * the edge env:
 *   pnpm --filter @azx-pbc/portal seed:llm -- <key> --name foundry
 *   pnpm --filter @azx-pbc/portal seed:llm -- <key> --name foundry-openai --recipe api-key
 *
 * Custody mirrors the running portal: Key Vault when `AZURE_KEY_VAULT_URL` is set,
 * else the dev envelope under `DEV_SECRETS_KEK_FILE`. Against a real vault the
 * credential comes from `DefaultAzureCredential`, so an operator running this
 * under `az login` needs no extra setup.
 */

/** The injection recipes a platform LLM secret may be seeded with. */
const RECIPES = {
  // Anthropic first-party, and Foundry's `/anthropic` Messages endpoint.
  "x-api-key": { kind: "header", name: "x-api-key", template: "{}" },
  // Azure OpenAI / Foundry `/openai/v1` key auth (its documented REST header).
  "api-key": { kind: "header", name: "api-key", template: "{}" },
  // OpenAI first-party (and any upstream that takes the key as a bearer).
  bearer: { kind: "header-bearer" },
} as const satisfies Record<string, InjectionRecipe>;
type RecipeName = keyof typeof RECIPES;

function buildStore(): SecretStore {
  const store = createSecretStoreFromEnv();
  if (!store) {
    throw new Error("no secret store configured — set DEV_SECRETS_KEK_FILE or AZURE_KEY_VAULT_URL");
  }
  return store;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const flagValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const valueArg = args.find(
    (a, i) => !a.startsWith("--") && args[i - 1] !== "--name" && args[i - 1] !== "--recipe",
  );
  const value = valueArg ?? process.env.EDGE_LLM_ANTHROPIC_KEY;
  const name = flagValue("--name") ?? process.env.EDGE_LLM_ANTHROPIC_CONNECTION ?? "anthropic";
  const recipeName = (flagValue("--recipe") ?? "x-api-key") as RecipeName;
  const recipe = RECIPES[recipeName];
  if (!recipe) {
    throw new Error(
      `unknown --recipe "${recipeName}" — expected one of: ${Object.keys(RECIPES).join(", ")}`,
    );
  }
  // Belt-and-suspenders: the recipe a row carries is what egress injects under,
  // so validate it against the same schema the write route uses.
  InjectionRecipeSchema.parse(recipe);

  if (!value) {
    throw new Error(
      "no vendor key — pass it as an arg or set EDGE_LLM_ANTHROPIC_KEY (the value is sealed, never logged)",
    );
  }

  const store = buildStore();
  const prisma = createPrismaClient();
  try {
    const existing = await prisma.appSecret.findFirst({ where: { scope: "platform", name } });
    if (existing && !force) {
      console.log(`platform secret "${name}" already exists (id ${existing.id}) — nothing to do.`);
      return;
    }

    // seal() writes to the vault before the row exists, so every path from here to a
    // committed row needs a rollback — otherwise a failure leaves a live, unreferenced
    // credential under an opaque name that nothing can correlate back.
    const material = await store.seal(value);
    let committed = false;
    try {
      if (existing) {
        // Recipes are immutable by design (secrets design) — rotating keeps the
        // stored one. Say so rather than let `--recipe` look like it applied.
        if (flagValue("--recipe")) {
          console.warn(
            `WARNING: --recipe has no effect on rotation — "${name}" keeps its stored recipe. ` +
              `Delete and re-create the secret to change it.`,
          );
        }
        await prisma.appSecret.update({
          where: { id: existing.id },
          data: { material, rotatedAt: new Date() },
        });
        committed = true;
        // Non-fatal (the row already points at the new value) but never silent: a
        // failed destroy strands a live vault entry holding the old vendor key.
        // Note this leaves exitCode 1 on an otherwise successful rotation — deliberate
        // as an operator signal, but it means a retry wrapper would re-rotate every pass.
        await store.destroy(existing.material).catch((err: unknown) => {
          console.error(
            `WARNING: rotated "${name}" but could not destroy the previous material — ` +
              `the old value may still be readable in the vault. Delete it by hand.`,
            err instanceof Error ? err.message : err,
          );
          process.exitCode = 1;
        });
        console.log(`rotated platform secret "${name}" (id ${existing.id}).`);
      } else {
        const row = await prisma.appSecret.create({
          data: {
            scope: "platform",
            appId: null,
            name,
            material,
            injection: recipe,
            createdBy: "seed-script",
          },
        });
        committed = true;
        console.log(`created platform secret "${name}" (id ${row.id}, recipe ${recipeName}).`);
      }
    } finally {
      if (!committed) {
        await store.destroy(material).catch((err: unknown) => {
          console.error(
            `WARNING: could not release the newly sealed material after a failed write — ` +
              `an unreferenced entry may be live in the vault.`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
