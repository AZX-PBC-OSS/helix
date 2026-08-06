# Reviews

Dated, point-in-time artifacts: review outputs, verification passes, and decision-support written
for a specific review. **Nothing here is maintained.** Each document is evidence of what was
believed and found on its date — reading one and assuming it describes the platform today is a
mistake. Where a review's conclusion still stands, it was folded into an
[ADR](../adr/) or a [feature doc](../features/), and _that_ is the current statement.

| Document                                                                                   | Date       | What it is                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`2026-06-25-architecture-review.md`](2026-06-25-architecture-review.md)                   | 2026-06-25 | Review of the backend trusted path (edge, portal, egress, shared, secret-store) — where the implementation was thinner than the design claimed. |
| [`2026-06-25-architecture-review/`](2026-06-25-architecture-review/)                       | 2026-06-25 | The same pass's per-finding write-ups: SSRF/IPv6 canonicalization, instruction replay, edge↔egress TLS, instruction hardening, fail-closed startup guards, connection-binding integrity, docs consistency. |
| [`2026-06-26-adr-challenge.md`](2026-06-26-adr-challenge.md)                               | 2026-06-26 | A 5-model adversarial panel challenging every ADR then on file (UPHOLD / WEAKEN / OVERTURN), grounded in source.                                |
| [`2026-06-26-adr-challenge-verification.md`](2026-06-26-adr-challenge-verification.md)     | 2026-06-26 | Independent re-check of every row of the challenge against source — which challenges held, and which didn't.                                    |
| [`2026-06-build-vs-buy.md`](2026-06-build-vs-buy.md)                                       | 2026-06    | Decision-support for the M4.5 design review: why build Helix rather than assemble it from off-the-shelf products, and the strategic fork behind that verdict. |

ADRs 0001–0013 were scaffolded from the 2026-06-25 review; `ISSUE-xx` / `DEC-xx` references in
those ADRs point into it. ADRs 0025–0026 came out of the same pass. The open follow-ups distilled
from all of it live in [`../../TODO.md`](../../TODO.md).
