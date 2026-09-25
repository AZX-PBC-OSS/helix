import { z } from "zod";
import {
  DeltaSchema,
  isProviderBindingEffective,
  parseFetchOriginKey,
  type AppManifest,
  type Capabilities,
  type ProviderBindingStatus,
  type ProviderStamp,
} from "@azx-pbc/shared";
import type { PrismaClient } from "../db/client.js";

/**
 * Per-binding effectiveness on the manifest read (I-02 T-0028) — the data
 * behind the SPA's Reapproval-needed badge. A stored manifest declaring a
 * provider binding that is no longer effective (the provider was deleted, or
 * a sensitive edit stale-dated the filing stamp) reports `effective: false`
 * here; the owner resubmits by saving the manifest again.
 *
 * The comparison is T-0009's {@link isProviderBindingEffective} — the one
 * definition, consumed exactly as the consent consult consumes it
 * (`connections/consent.ts`): collect the provider stamps the app's APPROVED
 * requests filed for the bound ref, and call the binding effective when any
 * current row under that ref still matches a filed stamp. A binding is
 * env-agnostic on the manifest (it resolves in the caller's tier at call
 * time), so the read asks the same question per row rather than per tier.
 *
 * The result attaches to the manifest payload as `providerBindings`, computed
 * at serve time — never stored, and omitted entirely when the manifest
 * declares no provider binding, so every binding-free payload keeps its
 * original shape.
 */

/**
 * The provider stamps an approved request filed for provider-bound origin
 * adds under one ref. A malformed deltas record parses as no stamps — a
 * broken approval row must report the binding ineffective (fail closed),
 * never grant a badge-less read off an unreadable grant.
 */
function stampsFor(deltas: unknown, ref: string): ProviderStamp[] {
  const parsed = z.array(DeltaSchema).safeParse(deltas);
  if (!parsed.success) return [];
  const out: ProviderStamp[] = [];
  for (const d of parsed.data) {
    if (typeof d.to !== "string" || !d.path.startsWith("fetch.origins[+")) continue;
    if (parseFetchOriginKey(d.to).provider !== ref) continue;
    for (const stamp of d.providerStamps ?? []) {
      if (stamp.ref === ref) out.push(stamp);
    }
  }
  return out;
}

/**
 * Compute `providerBindings` for a manifest's capabilities and attach it —
 * the single serve-time wrapper both manifest reads (the GET route and the
 * write-gate's PUT response) go through, so the badge cannot disagree between
 * them.
 */
export async function manifestWithBindings(
  prisma: PrismaClient,
  appId: string,
  manifest: AppManifest,
): Promise<AppManifest> {
  const bindings = await providerBindingStatuses(prisma, appId, manifest.capabilities);
  // Omitted when the manifest declares no provider binding, so every
  // binding-free manifest response keeps its exact pre-T-0028 shape.
  return { ...manifest, ...(bindings.length > 0 ? { providerBindings: bindings } : {}) };
}

async function providerBindingStatuses(
  prisma: PrismaClient,
  appId: string,
  capabilities: Capabilities,
): Promise<ProviderBindingStatus[]> {
  const bound = (capabilities.fetch?.origins ?? []).filter((o) => o.provider !== undefined);
  if (bound.length === 0) return [];
  const refs = [...new Set(bound.map((o) => o.provider as string))];

  const [rows, approved] = await Promise.all([
    prisma.connectionProvider.findMany({ where: { ref: { in: refs } } }),
    prisma.approvalRequest.findMany({
      where: { appId, status: "approved" },
      select: { deltas: true },
    }),
  ]);
  const stampsByRef = new Map<string, ProviderStamp[]>();
  for (const row of approved) {
    for (const ref of refs) {
      const stamps = stampsFor(row.deltas, ref);
      if (stamps.length === 0) continue;
      const list = stampsByRef.get(ref) ?? [];
      list.push(...stamps);
      stampsByRef.set(ref, list);
    }
  }

  return bound.map((o) => {
    const ref = o.provider as string;
    const effective = rows.some(
      (row) =>
        row.ref === ref &&
        (stampsByRef.get(ref) ?? []).some((stamp) =>
          isProviderBindingEffective(stamp, { id: row.id, ref: row.ref, revision: row.revision }),
        ),
    );
    return { origin: o.origin, ref, effective };
  });
}
