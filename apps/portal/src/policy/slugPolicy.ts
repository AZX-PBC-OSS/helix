import { slugRejection, type SlugRejection } from "@azx-pbc/shared";
import type { PrismaClient } from "../db/client.js";

/**
 * App-name policy at creation: the platform's reserved labels plus the terms an
 * administrator has blocked on the Platform Settings screen. Read per call —
 * the table is small and creation is rare, and a cache would let a just-added
 * term miss on another replica.
 */
export async function checkSlugPolicy(
  prisma: PrismaClient,
  slug: string,
): Promise<SlugRejection | null> {
  const rows = await prisma.blockedSlugTerm.findMany({ select: { term: true } });
  return slugRejection(
    slug,
    rows.map((r) => r.term),
  );
}
