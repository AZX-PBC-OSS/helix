# Helix contributor docs

Start with [the repository tour](../TOUR.md) for a code-oriented introduction, or
[the system overview](OVERVIEW.md) for the product and architecture.

Operator and app-author guides live in the [public docs site](../apps/docs).
This directory contains contributor documentation. Link between the two where
needed instead of maintaining duplicate guides. The site uses the generic deploy
skill render described in ADR-0036, decision 7.

## Directories

| Directory | Purpose | When to update |
| --- | --- | --- |
| [adr/](adr/) | Architecture decisions: context, decision, and consequences. An ADR takes precedence over older prose. | Amend when a decision changes; preserve its history. |
| [design/](design/) | Detailed subsystem designs, including work planned but not yet built. | As the design changes. |
| [features/](features/) | Current behavior, implementation files, and known gaps for shipped features. | With the code. |
| [reviews/](reviews/) | Dated review findings and supporting evidence. | Keep the original snapshot; write a new review for later findings. |
| [runbooks/](runbooks/) | Operational procedures. | When the procedure changes. |

The ADR, feature, and review directories each have an index README.

## Main documents

| File | Purpose |
| --- | --- |
| [OVERVIEW.md](OVERVIEW.md) | Introduction to the product, architecture, and security model. |
| [platform-architecture.md](platform-architecture.md) | Architecture and rationale. Numbered section references in code and docs point here. |
| [platform-project-plan.md](platform-project-plan.md) | Milestones, implementation status, and planned work. |
| [auth-review-guide.md](auth-review-guide.md) | Guide to reviewing authentication and authorization. |
| [TODO.md](../TODO.md) | Open follow-up work and the conditions for starting it. |

## Adding a document

Choose the directory by the document's purpose. Keep only entry points and the
main architecture and project-plan documents at this level. Link new documents
from the relevant index.

A design describes intended behavior and trade-offs. A feature document describes
what the code does today; a subsystem may need both. A review records findings as
of a date. Put the date in its filename and record later decisions in an ADR.

The planned [background jobs plane](design/background-jobs-plane.md) is the current
design behind ADR-0045: named services, initially TypeScript/pg-boss. The
[runner PoC comparison](reviews/jobs-runner-poc-2026-10-08.md) records executed
candidate evidence. The [TaskQ review](design/background-jobs-taskq-refresh.md)
is historical source evidence; the earlier background-jobs memo covers the
deferred LLM pipeline.
