/**
 * True when `err` is a Prisma unique-constraint violation (P2002), optionally
 * on a specific target column. Detected structurally so we don't depend on the
 * generated error class.
 *
 * Prisma 7's pg driver adapter reports the offending columns at
 * `meta.driverAdapterError.cause.constraint.fields`; classic clients use
 * `meta.target`. We check both.
 *
 * Raw queries (`$queryRaw`) never surface P2002 — a failed statement reports
 * P2010 with the adapter error embedded in `meta`, so the same structural
 * check recognizes the UniqueConstraintViolation kind there. Model and raw
 * writers can share this one predicate.
 */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== "P2002" && code !== "P2010") return false;
  if (!target) return uniqueKind(err, code === "P2002");
  return uniqueViolationFields(err).includes(target);
}

/** P2002 is a unique violation by definition; P2010 must say so structurally. */
function uniqueKind(err: object, required: boolean): boolean {
  if (required) return true;
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  return (
    (meta as { driverAdapterError?: { cause?: { kind?: unknown } } }).driverAdapterError?.cause
      ?.kind === "UniqueConstraintViolation"
  );
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
