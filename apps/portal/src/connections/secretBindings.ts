import {
  StoredInjectionRecipeSchema,
  SecretStampSchema,
  fetchOriginKey,
  parseFetchOriginKey,
  type Capabilities,
  type Delta,
  type SecretStamp,
} from "@azx-pbc/shared";
import type { PrismaClient } from "../db/client.js";
import { AppError } from "../plugins/errors.js";

type Db = Pick<PrismaClient, "appSecret" | "secretConnectionBinding">;

export async function resolvedSecretStamps(
  db: Db,
  appId: string,
  name: string,
): Promise<SecretStamp[]> {
  const rows = await db.appSecret.findMany({
    where: {
      name,
      OR: [
        { scope: "app", appId },
        { scope: "global", grants: { some: { appId } } },
      ],
    },
  });
  return (["prod", "dev"] as const).flatMap((env) => {
    const candidates = rows.filter((r) => r.env === env);
    const row = candidates.find((r) => r.scope === "app") ?? candidates[0];
    if (!row) return [];
    const parsed = StoredInjectionRecipeSchema.safeParse(row.injection);
    if (!parsed.success) throw new AppError("validation_failed", "connection recipe is unreadable");
    return [{ name, env, secretId: row.id, injection: parsed.data }];
  });
}

export async function stampSecretDeltas(db: Db, appId: string, deltas: Delta[]): Promise<Delta[]> {
  return Promise.all(
    deltas.map(async (d) => {
      if (!d.path.startsWith("fetch.origins[+") || typeof d.to !== "string") return d;
      const name = parseFetchOriginKey(d.to).connection;
      if (!name) return d;
      return { ...d, secretStamps: await resolvedSecretStamps(db, appId, name) };
    }),
  );
}

export async function secretBindingStatuses(db: Db, appId: string, caps: Capabilities) {
  return Promise.all(
    (caps.fetch?.origins ?? [])
      .filter((o) => o.connection)
      .map(async (o) => {
        const name = o.connection!;
        const [stamps, bindings] = await Promise.all([
          resolvedSecretStamps(db, appId, name),
          db.secretConnectionBinding.findMany({ where: { appId, origin: o.origin, name } }),
        ]);
        const guarded =
          bindings.length > 0 || stamps.some((s) => s.injection.kind === "oauth-service-account");
        const effective =
          !guarded ||
          (stamps.length > 0 &&
            stamps.every((s) =>
              bindings.some((b) => b.env === s.env && b.secretId === s.secretId),
            ));
        return {
          origin: o.origin,
          name,
          effective,
          stamps,
          serviceAccount: stamps.some((s) => s.injection.kind === "oauth-service-account"),
        };
      }),
  );
}

export async function restampSecretBindings(
  db: Db,
  appId: string,
  caps: Capabilities,
  deltas: Delta[],
): Promise<Delta[]> {
  const statuses = await secretBindingStatuses(db, appId, caps);
  return statuses
    .filter((s) => !s.effective)
    .flatMap((s) => {
      const key = fetchOriginKey({ origin: s.origin, connection: s.name });
      const path = `fetch.origins[+${key}]`;
      return deltas.some((d) => d.path === path) ? [] : [{ path, to: key, risk: "high" as const }];
    });
}

/** Recheck inside the approval transaction, then publish the identities egress may spend. */
export async function approveSecretBindings(db: Db, appId: string, deltas: Delta[]): Promise<void> {
  for (const d of deltas) {
    if (!d.path.startsWith("fetch.origins[+") || typeof d.to !== "string") continue;
    const binding = parseFetchOriginKey(d.to);
    if (!binding.connection) continue;
    const current = await resolvedSecretStamps(db, appId, binding.connection);
    const stamps = (d.secretStamps ?? []).map((s) => SecretStampSchema.parse(s));
    // A pending request from an older portal must never bless newly introduced OAuth.
    const guarded =
      d.secretStamps !== undefined ||
      current.some((s) => s.injection.kind === "oauth-service-account");
    if (!guarded) continue;
    if (JSON.stringify(stamps) !== JSON.stringify(current)) {
      throw new AppError("conflict", "the connection changed after filing; resubmit the manifest");
    }
    for (const s of stamps) {
      const key = { appId, origin: binding.origin, name: s.name, env: s.env };
      await db.secretConnectionBinding.upsert({
        where: { appId_origin_name_env: key },
        create: { ...key, secretId: s.secretId },
        update: { secretId: s.secretId },
      });
    }
  }
}
