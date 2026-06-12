/**
 * True when `err` is a Prisma unique-constraint violation (P2002), optionally
 * on a specific target column. Detected structurally so we don't depend on the
 * generated error class.
 *
 * Prisma 7's pg driver adapter reports the offending columns at
 * `meta.driverAdapterError.cause.constraint.fields`; classic clients use
 * `meta.target`. We check both.
 */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code !== "P2002") return false;
  if (!target) return true;
  return uniqueViolationFields(err).includes(target);
}

function uniqueViolationFields(err: object): string[] {
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return [];

  const classic = (meta as { target?: unknown }).target;
  if (Array.isArray(classic)) return classic.filter((f): f is string => typeof f === "string");

  const fields = (
    meta as { driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
  ).driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [];
}
