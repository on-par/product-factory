import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reworkStories,
  buildReworkPrompt,
  evaluateReworkStopping,
  validateRevisionCoverage,
  combinedScore,
  bestRound,
  REWORKS_DIR,
  type ReworkCallers,
  type ReworkRound,
} from './rework.js';
import {
  generateAcceptanceCriteria,
  loadCriteria,
  type CriteriaModelCaller,
  type CriteriaSet,
} from '../criteria/criteria.js';
import {
  decomposeIntent,
  storySentence,
  type Decomposition,
  type DecomposeModelCaller,
} from '../decompose/decompose.js';
import { saveIntentDoc, type IntentDoc } from '../intent/build.js';
import { approveIntentDoc } from '../intent/approve.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const DOC: IntentDoc = {
  id: 'aaaaaaaaaaaa',
  interviewId: 'bbbbbbbbbbbb',
  transcriptId: 'cccccccccccc',
  createdAt: '2026-01-01T00:00:00.000Z',
  goal: 'Ship exports',
  actor: 'PM',
  constraints: ['deadline Q3'],
  statements: [
    { id: 'INT-001', text: 'Line one.', source: 'transcript' },
    { id: 'INT-002', text: 'Line two.', source: 'transcript' },
    { id: 'INT-003', text: 'Answer one.', source: 'answer', questionIndex: 0, question: 'Q?' },
  ],
};

const DECOMPOSE_PAYLOAD = {
  epic: { title: 'Exports epic', summary: 'Ship exports end to end' },
  stories: [
    {
      title: 'Export CSV',
      asA: 'PM',
      iWant: 'to export stories as CSV',
      soThat: 'I can share them',
      tracesTo: ['INT-001', 'INT-003'],
    },
    {
      title: 'Export JSON',
      asA: 'PM',
      iWant: 'to export as JSON',
      soThat: 'tools can ingest it',
      tracesTo: ['INT-002'],
    },
  ],
};

function seedApprovedDoc(dir: string): void {
  saveIntentDoc(dir, DOC);
  const r = approveIntentDoc(dir, DOC.id, 'tester');
  if (!r.ok) throw new Error('expected ok');
}

const decomposeFakeCaller = (payload: unknown): DecomposeModelCaller => {
  return async () => JSON.stringify(payload);
};

async function seedDecomposition(dir: string): Promise<Decomposition> {
  seedApprovedDoc(dir);
  const result = await decomposeIntent(dir, DOC.id, decomposeFakeCaller(DECOMPOSE_PAYLOAD));
  if (!result.ok) throw new Error('expected ok');
  return result.decomposition;
}

const criteriaFakeCaller = (payload: unknown): CriteriaModelCaller => {
  return async () => JSON.stringify(payload);
};

function goodCriteriaPayload() {
  return {
    stories: [
      {
        storyIndex: 0,
        scenarios: [
          {
            name: 'Export as CSV',
            given: ['a PM has stories to export'],
            when: ['they request a CSV export'],
            then: ['a CSV file is produced'],
          },
        ],
      },
      {
        storyIndex: 1,
        scenarios: [
          {
            name: 'Export as JSON',
            given: ['a PM has stories to export'],
            when: ['they request a JSON export'],
            then: ['a JSON file is produced'],
          },
        ],
      },
    ],
  };
}

async function seedCriteria(
  dir: string,
): Promise<{ decomposition: Decomposition; criteria: CriteriaSet }> {
  const decomposition = await seedDecomposition(dir);
  const result = await generateAcceptanceCriteria(
    dir,
    decomposition.id,
    criteriaFakeCaller(goodCriteriaPayload()),
  );
  if (!result.ok) throw new Error('expected ok');
  return { decomposition, criteria: result.criteria };
}

/** A judge caller scripted from a fixed sequence of payloads; the last payload repeats once exhausted. */
function scriptedJudge(payloads: readonly unknown[]): {
  caller: CriteriaModelCaller;
  calls: () => number;
} {
  let call = 0;
  return {
    caller: async () => {
      const payload = payloads[Math.min(call, payloads.length - 1)];
      call += 1;
      return JSON.stringify(payload);
    },
    calls: () => call,
  };
}

/** A generator caller that always revises story 1 with distinct scenario text per call. */
function scriptedGenerator(): { caller: CriteriaModelCaller; calls: () => number } {
  let call = 0;
  return {
    caller: async () => {
      call += 1;
      return JSON.stringify({
        stories: [
          {
            storyIndex: 1,
            scenarios: [
              {
                name: `Export as JSON revision ${call}`,
                given: ['a PM has stories to export'],
                when: ['they request a JSON export'],
                then: [`a JSON file is produced (rev ${call})`],
              },
            ],
          },
        ],
      });
    },
    calls: () => call,
  };
}

function judgePayload(story0Alignment: number, story1Alignment: number) {
  return {
    stories: [
      {
        storyIndex: 0,
        intentAlignmentScore: story0Alignment,
        reasons: story0Alignment < 1 ? ['drift'] : [],
      },
      {
        storyIndex: 1,
        intentAlignmentScore: story1Alignment,
        reasons: story1Alignment < 1 ? ['drift'] : [],
      },
    ],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-rework-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reworkStories', () => {
  it('lifts a story above threshold and re-scores it', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2), judgePayload(1, 1)]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const result = await reworkStories(dir, criteria.id, callers, { threshold: 0.8 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('threshold-met');
    expect(result.session.rounds.length).toBe(2);
    expect(result.session.rounds[1].score).toBeGreaterThanOrEqual(0.8);
    expect(result.session.rounds[1].criteriaId).not.toBe(result.session.rounds[0].criteriaId);
    expect(result.session.bestIteration).toBe(1);

    const loaded = loadCriteria(dir, result.session.bestCriteriaId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected ok');
    const story1 = loaded.criteria.stories.find((s) => s.storyIndex === 1);
    expect(story1?.tracesTo).toEqual(criteria.stories[1].tracesTo);
    expect(story1?.storyTitle).toBe(criteria.stories[1].storyTitle);
  });

  it('stops immediately when the baseline already clears the threshold', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const result = await reworkStories(dir, criteria.id, callers, { threshold: 0.8 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('threshold-met');
    expect(result.session.rounds.length).toBe(1);
    expect(result.session.bestIteration).toBe(0);
    expect(generator.calls()).toBe(0);
  });

  it('is bounded by maxIterations (budget-exhausted)', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([
      judgePayload(1, 0.1),
      judgePayload(1, 0.2),
      judgePayload(1, 0.3),
      judgePayload(1, 0.4),
    ]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const result = await reworkStories(dir, criteria.id, callers, {
      threshold: 0.8,
      maxIterations: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('budget-exhausted');
    expect(result.session.rounds.length).toBe(4);
    expect(result.session.bestIteration).toBe(3);
    expect(result.session.bestCriteriaId).toBe(result.session.rounds[3].criteriaId);
    expect(result.session.bestVerdictId).toBe(result.session.rounds[3].verdictId);
    expect(judge.calls()).toBe(4);
  });

  it('stops on no-improvement when scores are equal', async () => {
    const { criteria } = await seedCriteria(dir);
    const payload = judgePayload(1, 0.2);
    const judge = scriptedJudge([payload, payload, payload, payload]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const result = await reworkStories(dir, criteria.id, callers, { threshold: 0.8 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('no-improvement');
    expect(result.session.rounds.length).toBe(2);
    expect(result.session.bestIteration).toBe(0);
  });

  it('stops when a round regresses relative to the previous round', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.5), judgePayload(1, 0.2)]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const result = await reworkStories(dir, criteria.id, callers, { threshold: 0.8 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('no-improvement');
    expect(result.session.bestIteration).toBe(0);
  });

  it('yields a content-derived id stable across runs', async () => {
    const { criteria } = await seedCriteria(dir);
    const runOnce = async () => {
      const judge = scriptedJudge([judgePayload(1, 0.2), judgePayload(1, 1)]);
      const generator = scriptedGenerator();
      return reworkStories(
        dir,
        criteria.id,
        { generate: generator.caller, judge: judge.caller },
        { threshold: 0.8 },
      );
    };

    const first = await runOnce();
    const second = await runOnce();
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(first.session.id).toMatch(/^[0-9a-f]{12}$/);
    expect(second.session.id).toBe(first.session.id);
  });

  it('persists the rework session as a round-trippable JSON artifact', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2), judgePayload(1, 1)]);
    const generator = scriptedGenerator();

    const result = await reworkStories(
      dir,
      criteria.id,
      { generate: generator.caller, judge: judge.caller },
      { threshold: 0.8 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const artifactPath = join(dir, WORKSPACE_DIR, REWORKS_DIR, `${result.session.id}.json`);
    expect(result.artifactPath).toBe(artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(persisted).toEqual(result.session);
  });

  it('rejects an out-of-range threshold', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const tooHigh = await reworkStories(dir, criteria.id, callers, { threshold: 1.5 });
    expect(tooHigh.ok).toBe(false);
    if (tooHigh.ok) throw new Error('expected not ok');
    expect(tooHigh.error).toBe('threshold must be between 0 and 1');

    const tooLow = await reworkStories(dir, criteria.id, callers, { threshold: -0.1 });
    expect(tooLow.ok).toBe(false);
    if (tooLow.ok) throw new Error('expected not ok');
    expect(tooLow.error).toBe('threshold must be between 0 and 1');
  });

  it('rejects an invalid maxIterations', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();
    const callers: ReworkCallers = { generate: generator.caller, judge: judge.caller };

    const zero = await reworkStories(dir, criteria.id, callers, { maxIterations: 0 });
    expect(zero.ok).toBe(false);
    if (zero.ok) throw new Error('expected not ok');
    expect(zero.error).toBe('maxIterations must be a positive integer');

    const fractional = await reworkStories(dir, criteria.id, callers, { maxIterations: 2.5 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) throw new Error('expected not ok');
    expect(fractional.error).toBe('maxIterations must be a positive integer');
  });

  it('unknown criteria id returns not found', async () => {
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();

    const result = await reworkStories(dir, 'ffffffffffff', {
      generate: generator.caller,
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set ffffffffffff not found');
  });

  it('surfaces a missing decomposition', async () => {
    const { criteria } = await seedCriteria(dir);
    const criteriaDir = join(dir, WORKSPACE_DIR, 'criteria');
    const corrupted = { ...criteria, decompositionId: 'ffffffffffff' };
    writeFileSync(join(criteriaDir, `${criteria.id}.json`), JSON.stringify(corrupted));
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();

    const result = await reworkStories(dir, criteria.id, {
      generate: generator.caller,
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition ffffffffffff not found');
  });

  it('surfaces a missing intent doc', async () => {
    const { criteria } = await seedCriteria(dir);
    const criteriaDir = join(dir, WORKSPACE_DIR, 'criteria');
    const corrupted = { ...criteria, intentId: 'ffffffffffff' };
    writeFileSync(join(criteriaDir, `${criteria.id}.json`), JSON.stringify(corrupted));
    const judge = scriptedJudge([judgePayload(1, 1)]);
    const generator = scriptedGenerator();

    const result = await reworkStories(dir, criteria.id, {
      generate: generator.caller,
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc ffffffffffff not found');
  });

  it('judge failure propagates', async () => {
    const { criteria } = await seedCriteria(dir);
    const generator = scriptedGenerator();

    const result = await reworkStories(dir, criteria.id, {
      generate: generator.caller,
      judge: async () => 'not json',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid judge payload');
  });

  it('generator returning invalid JSON fails the loop', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2)]);

    const result = await reworkStories(dir, criteria.id, {
      generate: async () => 'not json',
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid rework payload');
  });

  it('a generator that throws surfaces the failure', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2)]);

    const result = await reworkStories(dir, criteria.id, {
      generate: async () => {
        throw new Error('network down');
      },
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('model call failed:');
  });

  it('generator revising a non-failing story fails coverage validation', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2)]);

    const result = await reworkStories(dir, criteria.id, {
      generate: async () =>
        JSON.stringify({
          stories: [
            {
              storyIndex: 0,
              scenarios: [{ name: 'x', given: ['g'], when: ['w'], then: ['t'] }],
            },
          ],
        }),
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('coverage problems');
    expect(result.error).toContain('which was not asked for rework');
  });

  it('generator omitting a requested story fails coverage validation', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(0.2, 0.2)]);

    const result = await reworkStories(dir, criteria.id, {
      generate: async () =>
        JSON.stringify({
          stories: [
            {
              storyIndex: 0,
              scenarios: [{ name: 'x', given: ['g'], when: ['w'], then: ['t'] }],
            },
          ],
        }),
      judge: judge.caller,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('coverage problems');
    expect(result.error).toContain('has no revision');
  });

  it('tolerates a generator payload wrapped in code fences', async () => {
    const { criteria } = await seedCriteria(dir);
    const judge = scriptedJudge([judgePayload(1, 0.2), judgePayload(1, 1)]);

    const result = await reworkStories(dir, criteria.id, {
      generate: async () =>
        '```json\n' +
        JSON.stringify({
          stories: [
            {
              storyIndex: 1,
              scenarios: [{ name: 'x', given: ['g'], when: ['w'], then: ['t'] }],
            },
          ],
        }) +
        '\n```',
      judge: judge.caller,
    });

    expect(result.ok).toBe(true);
  });
});

describe('buildReworkPrompt', () => {
  it('contains intent statements, failing story sentence, current scenarios, and critic reasons', async () => {
    const { decomposition, criteria } = await seedCriteria(dir);
    const failing = [
      {
        storyIndex: 1,
        storyTitle: criteria.stories[1].storyTitle,
        tracesTo: criteria.stories[1].tracesTo,
        score: 0.5,
        reasons: ['scenario omits the JSON schema promised by INT-002'],
      },
    ];

    const prompt = buildReworkPrompt(DOC, decomposition.stories, criteria, failing);

    for (const statement of DOC.statements) {
      expect(prompt).toContain(`[${statement.id}]`);
      expect(prompt).toContain(statement.text);
    }
    expect(prompt).toContain(storySentence(decomposition.stories[1]));
    expect(prompt).toContain('traces-to: INT-002');
    expect(prompt).toContain('Export as JSON');
    expect(prompt).toContain('critic: scenario omits the JSON schema promised by INT-002');
    expect(prompt).toContain('"stories"');
    expect(prompt).toContain('never revise a story that is not listed');
    expect(prompt).not.toContain('Export as CSV');
  });
});

describe('evaluateReworkStopping', () => {
  const round = (iteration: number, score: number): ReworkRound => ({
    iteration,
    criteriaId: `criteria-${iteration}`,
    verdictId: `verdict-${iteration}`,
    score,
    stories: [],
  });

  it('reports threshold-met when the last round is at or above threshold', () => {
    expect(evaluateReworkStopping([round(0, 0.9)], 0.8, 3)).toBe('threshold-met');
  });

  it('reports in-progress below threshold with budget remaining', () => {
    expect(evaluateReworkStopping([round(0, 0.5)], 0.8, 3)).toBe('in-progress');
  });

  it('reports no-improvement for equal scores across rounds', () => {
    expect(evaluateReworkStopping([round(0, 0.5), round(1, 0.5)], 0.8, 3)).toBe('no-improvement');
  });

  it('reports no-improvement for a regression', () => {
    expect(evaluateReworkStopping([round(0, 0.5), round(1, 0.3)], 0.8, 3)).toBe('no-improvement');
  });

  it('reports budget-exhausted once the max iteration is reached with improving scores', () => {
    expect(
      evaluateReworkStopping([round(0, 0.2), round(1, 0.4), round(2, 0.5), round(3, 0.6)], 0.8, 3),
    ).toBe('budget-exhausted');
  });

  it('treats exactly-at-threshold as threshold-met (boundary)', () => {
    expect(evaluateReworkStopping([round(0, 0.8)], 0.8, 3)).toBe('threshold-met');
  });
});

describe('combinedScore', () => {
  it('averages readiness and intent-alignment scores', () => {
    expect(
      combinedScore({
        storyIndex: 0,
        storyTitle: 't',
        tracesTo: [],
        readinessScore: 1,
        readinessReasons: [],
        intentAlignmentScore: 0,
        intentAlignmentReasons: [],
      }),
    ).toBe(0.5);
    expect(
      combinedScore({
        storyIndex: 0,
        storyTitle: 't',
        tracesTo: [],
        readinessScore: 1,
        readinessReasons: [],
        intentAlignmentScore: 1,
        intentAlignmentReasons: [],
      }),
    ).toBe(1);
  });
});

describe('validateRevisionCoverage', () => {
  it('reports no problems for an exact match', () => {
    expect(validateRevisionCoverage([{ storyIndex: 1 }], [1])).toEqual([]);
  });

  it('reports an unrequested story index', () => {
    const problems = validateRevisionCoverage([{ storyIndex: 2 }], [1]);
    expect(problems).toEqual([
      'revision targets story index 2, which was not asked for rework',
      'story index 1 has no revision',
    ]);
  });

  it('reports a duplicate story index', () => {
    const problems = validateRevisionCoverage([{ storyIndex: 1 }, { storyIndex: 1 }], [1]);
    expect(problems).toContain('story index 1 appears more than once');
  });

  it('reports a missing story index', () => {
    const problems = validateRevisionCoverage([], [1]);
    expect(problems).toEqual(['story index 1 has no revision']);
  });
});

describe('bestRound', () => {
  const round = (iteration: number, score: number): ReworkRound => ({
    iteration,
    criteriaId: `criteria-${iteration}`,
    verdictId: `verdict-${iteration}`,
    score,
    stories: [],
  });

  it('the earliest round wins a tie', () => {
    expect(bestRound([round(0, 0.5), round(1, 0.5)]).iteration).toBe(0);
  });

  it('a later higher score wins', () => {
    expect(bestRound([round(0, 0.5), round(1, 0.9)]).iteration).toBe(1);
  });
});
