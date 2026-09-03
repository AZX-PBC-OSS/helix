# 0043. App-data identifiers are printable ASCII

**Status:** Accepted _(recorded 2026-09-03, implemented the same day)_
**Related:** ADR [0015](0015-app-data-three-scope-model.md) (the three scopes whose keys these are); ADR [0042](0042-shared-prefix-grants-and-list-verb.md) (prefix grants — the surface that made the character set load-bearing, and whose review findings 5 and 7 are cited below); ADR [0035](0035-offline-capability-platform-service-worker.md) (the scope-allowlist precedent); `packages/shared/src/manifest.ts` (`isValidDataKey`), `apps/edge/src/gateway/data-handler.ts` (`validKey`)

## Context

App-data keys, collection names, and (since ADR-0042) grant prefixes were validated as "non-empty, ≤ 256 bytes of UTF-8, no control characters" — a *blocklist* rule: anything except C0/DEL was legal. `examples` and the deploy skill teach ASCII identifiers (`record:<id>`, `stock`, `prefs`), but nothing required them, and the platform's first adversarial review of the prefix work surfaced what the blocklist was quietly admitting:

- **Review finding 7** — the fake store and the real store's `COLLATE "C"` keyset can disagree about page boundaries for astral-plane keys, because JS code-unit order and bytewise UTF-8 order diverge above the BMP. The fix compensated (`Buffer.compare` in the fake); the cause was the character set.
- **Review finding 5** — a prefix containing `[` could hijack the greedy delta-path regex so its *removal* silently no-op'd. The fix anchored the regex; free-form characters remain the reason such anchoring is necessary.
- **Review finding 8** — a single space is a legal grant, invisible in a diff.

None of those is the reason for this decision, though. The reason is what a key **is**: a string used in four trusted places at once — a URL path segment, an authorization grant in the manifest, a component of an approval delta path, and a line in the admin-facing approval diff. For a value with that job, "no control characters" is the wrong shape of rule, because Unicode's *format* characters (category Cf) are not C0 controls and pass it entirely:

- **U+202E (right-to-left override)** in a `sharedReadPrefixes` grant reorders the rendered diff — the prefix an admin reads in the approval queue is not the bytes being authorized.
- **U+200B (zero-width space)** hides completely — a grant that looks like `record:` and is not.
- **Homoglyphs** (a Cyrillic `а` in `record:`) are invisible to a human reviewer and authorize different bytes than they appear to.
- **Un-normalized Unicode** encodes one visual key several ways (precomposed `é` vs `e` + combining accent): distinct keys, identical to every reader, and no canonicalization step exists anywhere in the path.

This repository has already made this exact decision once, for the same class of value: `isValidServiceWorkerScope` accepts **unreserved URL characters only** — "a positive allowlist rather than a blocklist because this value is used twice in the trusted path… where a stray CR/LF would be header injection" (ADR-0035 §3). The app-data key is used in *four* trusted places.

## Decision

**Keys, collection names, and grant prefixes (literal and prefix arrays) are printable ASCII: `0x20`–`0x7E`, 1–256 characters, no leading or trailing space.** Interior space is legal (`my prefs` is a fine key). Values are untouched: they remain arbitrary Unicode JSON — the classic identifier/content split, and the deliberate scope of this rule.

One rule, in one place: `isValidDataKey` in `packages/shared/src/manifest.ts`, exported and consumed by the manifest schema (all five grant-string arrays), the edge's request-time `validKey` (keys, collection names, the list verb's prefix, and the decoded cursor), and the SPA's editor preview. Request time, manifest time, and the editor cannot disagree about the accepted set — the drift the repo's own double-validation comments warn about. Because every legal string is ASCII, characters are bytes: the cap is 256 of either, and the manifest's `TextEncoder` browser-barrel workaround for counting UTF-8 bytes is deleted.

An invalid identifier is a `400 validation_failed` at the edge and a zod issue at the manifest — the same failure either way, and the message names the rule.

### Compatibility

Tightening a validated surface retroactively rejects stored state, so it was tightened only after proving nothing stored violates it: a sweep of the live dev database (`app_data.key`, the manifest JSONB grant strings, `app_collection_items.collection`) found **zero** non-ASCII, non-printable, or space-padded values — consistent with the platform's state (pre-pilot; ADR-0042's prefix fields had not yet shipped anywhere). The projection's fail-closed behaviour (a stored grant the schema refuses projects `data: null`; every data verb 403s) is the backstop for any deployment that skips the sweep, and `projection.test.ts` pins it for exactly this class of row. **The sweep is the procedure to re-run on the Azure deployment before promoting this change.**

## Consequences

- **The finding-7 class is gone at the root, not compensated.** On ASCII, JS code-unit order, bytewise UTF-8 order, and every collation agree — the fake's `Buffer.compare` comparator and the real store's `COLLATE "C"` pin are now belt-and-braces rather than a necessity, and they stay (out-of-band rows — seeded by tests, or written by a future bug — must still page identically everywhere).
- **Grant diffs are what they appear to be.** No bidi reordering, no zero-width padding, no homoglyphs, no invisible edge spaces — the admin queue approves exactly the bytes it renders. The `[`/`]` ambiguity of finding 5 stays fixed by the anchored regex (brackets remain legal ASCII; excluding them buys nothing further).
- **No normalization step is ever needed.** One visual identifier, one byte sequence.
- **The 256-char cap is a char cap and a byte cap simultaneously**, and the SPA's byte-counting workaround is deleted with the `TextEncoder`.
- **A non-ASCII identifier a deployed app actually wants** (say, a shared key named `設定`) is re-expressed as an ASCII key with the text in the value — which is where human language belonged all along. This is the whole cost of the decision, and it is paid by the app author at design time, loudly, rather than by an admin at approval time, invisibly.
- **Non-goals:** restricting values (arbitrary Unicode JSON, unchanged); canonicalization or case-folding (nothing to canonicalize now); changing the 64 KiB value cap or key length cap.

### Explicit non-goals

- **URL-safe vs printable-ASCII.** `:` is load-bearing in the platform's own idiom (`record:<id>`), so the RFC 3986 unreserved set the scope rule uses is too tight here. The set is "printable ASCII, no padding" — full stop.
- **Excluding `[`/`]` from grant strings.** Considered alongside this decision; rejected because the anchored `ARRAY_PATH` already makes them unambiguous and natural keys like `matrix[0]` are plausible. Revisit only against a real confusion incident.
