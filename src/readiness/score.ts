/**
 * Readiness rubric — the yardstick the judge agent scores a story against.
 *
 * This is the seed of the product's core artifact: an objective, inspectable
 * definition of "engineering ready". The rubric will grow (see docs/adr/0001),
 * but the shape is stable: a set of named checks, each pass/fail, producing a
 * score and the list of what is still missing.
 */

export interface Story {
  /** One clear actor, e.g. "As a PM". */
  readonly actor?: string;
  /** Acceptance criteria, ideally in Given/When/Then (Gherkin) form. */
  readonly acceptanceCriteria: readonly string[];
  /** Named dependencies this story relies on. */
  readonly dependencies?: readonly string[];
  /** Open questions an engineer, customer, support, security or ops would ask. */
  readonly openQuestions?: readonly string[];
}

export interface ReadinessCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
}

export interface ReadinessResult {
  /** 0..1 fraction of checks passed. */
  readonly score: number;
  readonly checks: readonly ReadinessCheck[];
  /** Human-readable descriptions of the checks that failed. */
  readonly missing: readonly string[];
}

const GHERKIN = /\b(given|when|then)\b/i;

/**
 * Score a story against the readiness rubric v0.
 *
 * v0 checks (see ADR-0001 for the evolving rubric):
 *  - has a single clear actor
 *  - has at least one acceptance criterion
 *  - at least one acceptance criterion is written in Given/When/Then form
 *  - no unresolved open questions remain
 */
export function scoreReadiness(story: Story): ReadinessResult {
  const checks: ReadinessCheck[] = [
    {
      id: 'actor',
      description: 'Story names a single clear actor',
      passed: typeof story.actor === 'string' && story.actor.trim().length > 0,
    },
    {
      id: 'has-acceptance-criteria',
      description: 'Story has at least one acceptance criterion',
      passed: story.acceptanceCriteria.length > 0,
    },
    {
      id: 'gherkin-acceptance-criteria',
      description: 'At least one acceptance criterion uses Given/When/Then',
      passed: story.acceptanceCriteria.some((ac) => GHERKIN.test(ac)),
    },
    {
      id: 'no-open-questions',
      description: 'No unresolved open questions remain',
      passed: (story.openQuestions ?? []).length === 0,
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const score = checks.length === 0 ? 0 : passedCount / checks.length;
  const missing = checks.filter((c) => !c.passed).map((c) => c.description);

  return { score, checks, missing };
}
