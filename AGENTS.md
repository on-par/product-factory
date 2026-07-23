# AGENTS.md

Context for AI coding agents working in this repository. Read this before starting any task.

## Project overview

**Product Factory** (`@on-par/product-factory`) is a TypeScript/Node.js tool that turns a product manager's high-level intent into engineering-ready work through a collaborating multi-agent refinement loop, then exports the result as tickets. It is the sibling of [Software Factory](https://github.com/on-par/software-factory): Software Factory builds the thing right, Product Factory builds the right thing.

The pipeline is: **INTERVIEWER → INTENT DOC → DECOMPOSER → PERSONA PANEL → JUDGE (generator/critic rework) → READINESS REPORT → EXPORT**. Two human gates: after the intent doc and before publish. The distinguishing idea is **traceability**: every story and acceptance criterion links back to a line of stated intent, which is what makes the judge step objective.

## Repository layout

```
product-factory/
├── src/
│   ├── index.ts              Public API (UI-less engine surface)
│   ├── cli.ts                The `product-factory` / `pf` CLI entrypoint
│   └── readiness/            Readiness rubric — the judge's yardstick
├── scripts/verify.sh         Full verification gate (mirrors CI)
├── docs/adr/                 Architecture Decision Records
├── .github/workflows/ci.yml  CI pipeline
├── tsconfig.json
└── package.json
```

The layout is intentionally small today and grows in vertical slices as the loop lands. Expect it to evolve toward an `@on-par/product-factory-core` engine plus a thin CLI, mirroring Software Factory's `config ← core ← cli` split, once the epics justify it.

## Key commands

Run from the repo root. Node.js >= 20 required.

| Task                    | Command                  |
| ----------------------- | ------------------------ |
| Install                 | `npm install`            |
| Build                   | `npm run build`          |
| Typecheck               | `npm run typecheck`      |
| Lint                    | `npm run lint`           |
| Format                  | `npm run format`         |
| Format check            | `npm run format:check`   |
| Test (with coverage)    | `npm run test`           |
| Full verify (CI parity) | `bash scripts/verify.sh` |

## Conventions

- **Language:** TypeScript, strict mode, ESM only (`"type": "module"`). Use `import`/`export` with `.js` extensions on relative imports (NodeNext resolution).
- **Runtime:** Node.js >= 20.
- **The engine is UI-less.** `src/index.ts` is the narrow public API; the CLI consumes it. Keep presentation concerns out of the engine so a server can consume it later.
- **Tests are colocated** `*.test.ts` next to the source they cover, run by Vitest. Coverage thresholds are enforced in `vitest.config.ts`; do not lower them.
- **TDD is expected:** write or update the colocated test alongside any source change.
- **Traceability is the product.** When you add a stage, preserve the link from output back to the intent doc. Do not build features that break the intent → story → acceptance-criterion lineage.

## Definition of ready (for issues we build)

Issues in this repo are authored to be shippable by Software Factory. Each story follows INVEST, carries **Given/When/Then** acceptance criteria, and is sliced to the smallest deliverable vertical slice of value.

## Before committing

Run the full verification gate and make sure everything is green:

```bash
bash scripts/verify.sh
```

Build, typecheck, lint, format check, and test (with coverage) must all pass. This is exactly what CI enforces.
