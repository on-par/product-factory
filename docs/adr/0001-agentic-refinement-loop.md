# ADR 0001: The agentic refinement loop and its artifacts

Status: Accepted
Date: 2026-07-23

## Context

Product refinement (turning stated intent into engineering-ready work) is slow, meeting-bound, manual, and inconsistent. Most of the effort is discovering missing information, surfacing assumptions, and clarifying intent. These activities are predictable enough to be done by agents before humans get involved.

We need an architecture that does this refinement while keeping humans in control and keeping every output defensible (traceable back to what the PM actually meant).

## Decision

Product Factory is a staged multi-agent loop:

1. **Interviewer** — comprehends the PM's brain-dump and asks clarifying questions until intent is pinned. This stage is where most of the product value lives; the quality of the whole system is bounded by it.
2. **Intent doc** — the canonical source of truth. Human gate #1: the PM approves it before decomposition.
3. **Decomposer** — expands the intent doc into epic, stories, and acceptance criteria.
4. **Persona panel** — interrogates the decomposition from the perspective of engineering, customer, support, security, and operations, producing gaps, risks, assumptions, and dependencies.
5. **Judge** — scores each story against the intent doc (AI-as-judge). A generator/critic rework loop iterates until the score clears a threshold or a bounded budget is spent. The loop must have a stopping rule; it never runs unbounded.
6. **Readiness report** — the scored result plus remaining open questions. Human gate #2: the PM approves before publishing.
7. **Export** — Jira, GitHub issue, or markdown.

### Core artifacts

- **Intent doc** — the source of truth every later stage grades against.
- **Readiness rubric** — the objective, inspectable definition of "engineering ready" the judge scores with. Seeded in `src/readiness/`.
- **Traceability links** — every story and acceptance criterion links back to a line of the intent doc.

## Consequences

- The judge is only possible because the intent doc and rubric exist. Grading against "vibes" is not a thing; grading against a written intent is.
- The interviewer, not the decomposer, is where engineering effort should concentrate. Garbage in bounds everything downstream.
- The generator/critic loop needs an explicit budget (score threshold, max iterations, or no-improvement stop) to avoid burning tokens and oscillating.
- Traceability is a hard constraint, not a feature. Any stage that breaks the intent → story → acceptance-criterion lineage is out of spec.
- Tickets are a cheap export at the end, not the product. The product is the traceable intent-to-story lineage.
