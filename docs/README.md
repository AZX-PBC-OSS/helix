# Helix docs

Everything here is sorted by **kind**, not by feature. Which directory a document belongs in is
determined by what job it does — whether it records a _decision_, a _design ahead of the code_,
_what is true today_, a _dated snapshot_, or an _operational procedure_. Only entry points and the
two canonical anchors stay loose at the top level.

Start with [`../TOUR.md`](../TOUR.md) if you are about to read the code, or
[`OVERVIEW.md`](OVERVIEW.md) if you want the platform explained without the repo.

## The directories

| Directory                     | What belongs in it                                                                                                                                   | Time sense                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [`adr/`](adr/)                | One significant architecture decision per file (Context → Decision → Consequences). The canonical record of _why_ — where an ADR and older prose disagree, **the ADR wins**. | Permanent, amended in place   |
| [`design/`](design/)          | Deep design for a subsystem, usually written **before or alongside** the code: app-data, approvals, fetch-proxy, secrets & connections, dev-mode, git connections, custom backends, logging. | Forward-looking               |
| [`features/`](features/)      | How a shipped capability works **today** — the files to open, the behaviour to expect, what isn't built yet. Kept current with the code.               | Present tense                 |
| [`reviews/`](reviews/)        | Dated point-in-time artifacts: review outputs, verification passes, decision-support written for a specific review. Never edited to stay current — they are evidence of what was believed on a date. | Frozen at its date            |
| [`runbooks/`](runbooks/)      | Operational procedures a human follows step by step (e.g. the Entra app registration).                                                                 | Present tense                 |

Each of `adr/`, `features/`, and `reviews/` has its own README with an index.

## The loose files

| File                                                              | What it is                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`OVERVIEW.md`](OVERVIEW.md)                                      | Single-file orientation for anyone — product, security, engineering — meeting the platform for the first time.  |
| [`platform-architecture.md`](platform-architecture.md)            | The **what & why**. Section references throughout the code and docs ("§4.2") point here.                        |
| [`platform-project-plan.md`](platform-project-plan.md)            | The **with what & in what order**. The authority on done/partial/deferred status per milestone.                 |
| [`auth-review-guide.md`](auth-review-guide.md)                    | The reviewer's entry point to the auth & authorization surface — the most security-sensitive code in the platform. |

Open follow-up work is [`../TODO.md`](../TODO.md), distilled from the ADRs with a gating condition
on each item.

## Adding a doc

Ask what job it does, then put it in the matching directory — a new top-level file needs to be an
entry point or a canonical anchor to earn the spot, and anything loose that isn't linked from
[`../TOUR.md`](../TOUR.md) or here will quietly rot. Two distinctions worth getting right:

- **`design/` vs `features/`** — same subsystem, different tense. The design doc says what we
  intend and why we rejected the alternatives; the feature doc says what the code does right now.
  Several subsystems have both, and that's correct.
- **`reviews/` vs everything else** — if the document is only true as of a date, it goes in
  `reviews/` with the date in its filename. Don't update it later; write a new one, or fold the
  conclusion into an ADR.
