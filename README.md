# Product Factory

An agentic **product delivery factory**. It turns a product manager's high-level intent (a brain-dump) into engineering-ready work through a collaborating multi-agent refinement loop, then exports the result as tickets.

Product Factory is the sibling of [Software Factory](https://github.com/on-par/software-factory). Software Factory answers "build the thing right" (verified issues to merged PRs). Product Factory answers "build the right thing" (raw intent to engineering-ready stories). Someday they compose: Product Factory output becomes Software Factory input.

## Why

Real friction sits between product vision and engineering implementation. Business states a goal, the PM translates it into requirements, engineering reviews and asks predictable questions, the PM revises, and only after several slow, meeting-bound rounds does a story become implementation-ready. Most of that back-and-forth is discovering missing information, surfacing assumptions, and clarifying intent. Those are excellent candidates for agentic work.

Product Factory does the predictable refinement **before** human refinement. Agents proactively find the gaps, risks, ambiguities, and dependencies an engineer, customer, support, security, or ops person would raise, so the humans spend their time on strategy and prioritization instead of translation.

The goal is not to replace the product manager. It is to remove low-value administrative and translation work and to raise the quality of what goes into human refinement.

## Core principle: move ambiguity left

Every unanswered question found before implementation is rework, waste, and delivery risk avoided. The factory continuously attempts to answer:

- What is unclear?
- What assumptions exist?
- What dependencies exist?
- What would an engineer ask? A customer? Support? Security? Operations?

## The loop

```
PM brain-dump (voice / text)
      │
 1. INTERVIEWER   comprehends intent, asks clarifying questions until intent is pinned
      │
 2. INTENT DOC    the source of truth  ── human gate #1 (PM approves)
      │
 3. DECOMPOSER    intent → epic → stories → acceptance criteria
      │
 4. PERSONA PANEL "what would eng / customer / support / security / ops ask?"
      │
 5. JUDGE         scores each story against the intent doc (AI-as-judge);
      │           generator↔critic rework loop until score ≥ threshold or budget spent
      │
 6. READINESS REPORT + open questions  ── human gate #2 (PM approves to publish)
      │
 7. EXPORT        Jira / GitHub issue / markdown
```

The defensible artifact is not the tickets. It is the **intent doc plus traceability**: every story and every acceptance criterion links back to a line of stated intent, so the judge has something objective to grade against and a human can see exactly where a requirement came from.

## Status

Early. This repo is a walking skeleton: a runnable TypeScript/Node CLI with the readiness rubric seed and a green verification gate. The loop lands issue by issue, in vertical slices. See the open [epics and issues](https://github.com/on-par/product-factory/issues).

## Quick start

```bash
git clone https://github.com/on-par/product-factory
cd product-factory
npm install
npm run build
node dist/cli.js readiness-demo
```

## Development

Node.js >= 20. Run from the repo root.

| Task                    | Command                  |
| ----------------------- | ------------------------ |
| Build                   | `npm run build`          |
| Typecheck               | `npm run typecheck`      |
| Lint                    | `npm run lint`           |
| Format                  | `npm run format`         |
| Test (with coverage)    | `npm run test`           |
| Full verify (CI parity) | `bash scripts/verify.sh` |

Before committing, run `bash scripts/verify.sh` and make sure it is green.

## License

MIT. See [LICENSE](./LICENSE).
