import { createSecretStore, readDevKey, type SecretStore } from "@azx-pbc/secret-store";
import { createPrismaClient } from "../src/db/client.js";

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
 * Custody mirrors the running portal: Key Vault when `AZURE_KEY_VAULT_URL` is set,
 * else the dev envelope under `DEV_SECRETS_KEK_FILE`.
 */

function buildStore(): SecretStore {
  if (process.env.AZURE_KEY_VAULT_URL) {
    return createSecretStore({ keyVaultUrl: process.env.AZURE_KEY_VAULT_URL });
  }
  if (process.env.DEV_SECRETS_KEK_FILE) {
    return createSecretStore({ devMasterKey: readDevKey(process.env.DEV_SECRETS_KEK_FILE) });
  }
  throw new Error("no secret store configured — set DEV_SECRETS_KEK_FILE or AZURE_KEY_VAULT_URL");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const valueArg = args.find((a) => !a.startsWith("--"));
  const value = valueArg ?? process.env.EDGE_LLM_ANTHROPIC_KEY;
  const name = process.env.EDGE_LLM_ANTHROPIC_CONNECTION ?? "anthropic";

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

    const material = await store.seal(value);
    if (existing) {
      await prisma.appSecret.update({
        where: { id: existing.id },
        data: { material, rotatedAt: new Date() },
      });
      await store.destroy(existing.material).catch(() => {});
      console.log(`rotated platform secret "${name}" (id ${existing.id}).`);
    } else {
      const row = await prisma.appSecret.create({
        data: {
          scope: "platform",
          appId: null,
          name,
          material,
          injection: { kind: "header", name: "x-api-key", template: "{}" },
          createdBy: "seed-script",
        },
      });
      console.log(`created platform secret "${name}" (id ${row.id}).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
