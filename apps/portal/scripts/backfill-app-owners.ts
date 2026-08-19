import { createPrismaClient } from "../src/db/client.js";

/**
 * Adopt ownerless apps.
 *
 * `App.ownerId` is nullable because it was added with the approvals work
 * (docs/design/approvals.md §4) — rows created before that carry no owner. That
 * was harmless while every read was unscoped, but the apps page now defaults to
 * `scope=mine`, so an ownerless app is invisible to everyone until it is adopted.
 * This assigns those rows an owner; it never reassigns one that already has an
 * owner, so it is safe to re-run.
 *
 * The principal is supplied at run time and deliberately not baked into a
 * migration — whose apps these are is a property of the deployment, not of the
 * code. Pass the same value the portal would see as `actor.sub`: the verifier
 * collapses the subject to `email ?? preferred_username ?? sub`, so for an
 * ordinary Entra user that is their email address.
 *
 * Usage (from repo root):
 *   pnpm --filter @azx-pbc/portal db:backfill-owners -- ops@example.com
 *   BACKFILL_OWNER_ID=ops@example.com pnpm --filter @azx-pbc/portal db:backfill-owners
 *   pnpm --filter @azx-pbc/portal db:backfill-owners -- ops@example.com --name "Ops Team"
 *   pnpm --filter @azx-pbc/portal db:backfill-owners -- ops@example.com --dry-run
 *
 * `--name` also fills the display column; without it only the identity is set and
 * the portal falls back to rendering `ownerId`, which is the pre-existing
 * behaviour for these rows either way.
 */

interface Options {
  ownerId: string;
  ownerName?: string;
  ownerEmail?: string;
  dryRun: boolean;
}

/** Flags that take a following value; everything else is a bare switch. */
const VALUE_FLAGS = new Set(["name", "email"]);

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let dryRun = false;
  let positional: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    // pnpm forwards its own `--` separator into argv; it is not an argument.
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "dry-run") {
        dryRun = true;
      } else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        values.set(name, value);
        i += 1; // consumed
      } else {
        throw new Error(`unknown flag --${name}`);
      }
      continue;
    }
    positional ??= arg;
  }

  const ownerId = positional ?? process.env.BACKFILL_OWNER_ID;
  if (!ownerId) {
    throw new Error(
      "no owner — pass the principal as an argument or set BACKFILL_OWNER_ID " +
        "(use the value the portal sees as actor.sub, usually an email address)",
    );
  }

  // A subject that looks like an address is one: the verifier prefers the `email`
  // claim when composing `actor.sub`, so this matches what create would store.
  const ownerName = values.get("name");
  const ownerEmail = values.get("email") ?? (ownerId.includes("@") ? ownerId : undefined);
  return {
    ownerId,
    ...(ownerName ? { ownerName } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    dryRun,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = createPrismaClient();

  try {
    const orphans = await prisma.app.findMany({
      where: { ownerId: null },
      select: { slug: true, displayName: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    if (orphans.length === 0) {
      console.log("no ownerless apps — nothing to do.");
      return;
    }

    console.log(`${orphans.length} ownerless app(s):`);
    for (const a of orphans) {
      console.log(`  ${a.slug} — ${a.displayName} (created ${a.createdAt.toISOString()})`);
    }

    if (opts.dryRun) {
      console.log(`\n--dry-run: would assign these to "${opts.ownerId}". No writes made.`);
      return;
    }

    // Re-filter on ownerId inside the write: anything adopted between the read
    // above and here keeps the owner it just got.
    const { count } = await prisma.app.updateMany({
      where: { ownerId: null },
      data: {
        ownerId: opts.ownerId,
        ...(opts.ownerName ? { ownerName: opts.ownerName } : {}),
        ...(opts.ownerEmail ? { ownerEmail: opts.ownerEmail } : {}),
      },
    });

    console.log(`\nassigned ${count} app(s) to "${opts.ownerId}".`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
