-- Flag-day reset for the scrypt cost bump (ADR-0004, ISSUE-08).
--
-- The shared-password hashes stored before this change were derived at Node's
-- default cost (N=2^14); the portal now hashes and the edge now verifies at
-- OWASP's N=2^17. A hash derived at the old cost verifies to `false` at the new
-- cost — silently — so a stale row would reject the *correct* passphrase with a
-- misleading "incorrect password". We chose a flag-day reset over a versioned
-- hash format (these are demo-only / no-production-data apps): null the stored
-- credential so the edge fails closed and the owner re-mints a fresh passphrase
-- via POST /api/v1/apps/:slug/access/password. `passwordEnc` (the only
-- recoverable plaintext) is cleared too so no ciphertext dangles without a
-- matching hash.
UPDATE "apps"
SET "passwordHash" = NULL,
    "passwordSalt" = NULL,
    "passwordEnc" = NULL,
    "passwordSetAt" = NULL
WHERE "passwordHash" IS NOT NULL
   OR "passwordSalt" IS NOT NULL
   OR "passwordEnc" IS NOT NULL
   OR "passwordSetAt" IS NOT NULL;
