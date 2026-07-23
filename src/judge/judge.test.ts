import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeStories,
  loadVerdicts,
  buildJudgePrompt,
  validateAlignmentReasons,
  VERDICTS_DIR,
  type JudgeModelCaller,
} from './judge.js';
import {
  generateAcceptanceCriteria,
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

const judgeFakeCaller = (payload: unknown): JudgeModelCaller => {
  return async () => JSON.stringify(payload);
};

function goodJudgePayload() {
  return {
    stories: [
      { storyIndex: 0, intentAlignmentScore: 1, reasons: [] },
      {
        storyIndex: 1,
        intentAlignmentScore: 0.8,
        reasons: ['scenario omits the JSON schema promised by INT-002'],
      },
    ],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-judge-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('judgeStories', () => {
  it('scores a story against intent and rubric (AC: readiness + alignment scores with reasons)', async () => {
    const { decomposition, criteria } = await seedCriteria(dir);

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.verdicts.criteriaId).toBe(criteria.id);
    expect(result.verdicts.decompositionId).toBe(decomposition.id);
    expect(result.verdicts.intentId).toBe(decomposition.intentId);
    expect(result.verdicts.stories.length).toBe(criteria.stories.length);

    const [story0, story1] = result.verdicts.stories;

    expect(story0.tracesTo).toEqual(criteria.stories[0].tracesTo);
    expect(story0.storyTitle).toBe(criteria.stories[0].storyTitle);
    expect(story0.readinessScore).toBe(1);
    expect(story0.readinessReasons).toEqual([]);
    expect(story0.intentAlignmentScore).toBe(1);
    expect(story0.intentAlignmentReasons).toEqual([]);

    expect(story1.intentAlignmentScore).toBe(0.8);
    expect(story1.intentAlignmentReasons).toEqual([
      'scenario omits the JSON schema promised by INT-002',
    ]);
    expect(story1.readinessScore).toBeGreaterThanOrEqual(0);
    expect(story1.readinessScore).toBeLessThanOrEqual(1);
  });

  it('detects intent drift and names the contradicted statement', async () => {
    const { criteria } = await seedCriteria(dir);
    const payload = {
      stories: [
        { storyIndex: 0, intentAlignmentScore: 1, reasons: [] },
        {
          storyIndex: 1,
          intentAlignmentScore: 0.1,
          reasons: ['story exports XML but INT-002 requires JSON export'],
        },
      ],
    };

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(payload));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const drifted = result.verdicts.stories.find((s) => s.storyIndex === 1);
    expect(drifted?.intentAlignmentScore).toBe(0.1);
    expect(drifted?.intentAlignmentReasons[0]).toContain('INT-002');
  });

  it('yields a content-derived id stable across runs', async () => {
    const { criteria } = await seedCriteria(dir);

    const first = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));
    const second = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(first.verdicts.id).toMatch(/^[0-9a-f]{12}$/);
    expect(second.verdicts.id).toBe(first.verdicts.id);
  });

  it('rejects a payload covering only some stories', async () => {
    const { criteria } = await seedCriteria(dir);
    const partialPayload = { stories: [goodJudgePayload().stories[0]] };

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(partialPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('coverage problems');
    expect(result.error).toContain('story index 1 has no verdict');
  });

  it('rejects a payload referencing an unknown story index with judge-specific wording', async () => {
    const { criteria } = await seedCriteria(dir);
    const badPayload = {
      stories: [
        { storyIndex: 0, intentAlignmentScore: 1, reasons: [] },
        { storyIndex: 7, intentAlignmentScore: 1, reasons: [] },
      ],
    };

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(badPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('coverage problems');
    expect(result.error).toContain('verdict entry references unknown story index 7');
  });

  it('rejects a payload with a duplicate story index', async () => {
    const { criteria } = await seedCriteria(dir);
    const payload = goodJudgePayload();
    const duplicatePayload = { stories: [payload.stories[0], payload.stories[0]] };

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(duplicatePayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('coverage problems');
    expect(result.error).toContain('appears more than once');
  });

  it('rejects a deduction with no reasons', async () => {
    const { criteria } = await seedCriteria(dir);
    const payload = {
      stories: [
        { storyIndex: 0, intentAlignmentScore: 0.5, reasons: [] },
        { storyIndex: 1, intentAlignmentScore: 1, reasons: [] },
      ],
    };

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(payload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('missing reasons');
    expect(result.error).toContain('story index 0 has an alignment deduction but no reasons');
  });

  it('invalid model output returns an error', async () => {
    const { criteria } = await seedCriteria(dir);

    const result = await judgeStories(dir, criteria.id, async () => 'not json');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid judge payload');
  });

  it('a caller that throws surfaces the failure', async () => {
    const { criteria } = await seedCriteria(dir);

    const result = await judgeStories(dir, criteria.id, async () => {
      throw new Error('network down');
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('model call failed:');
  });

  it('tolerates a payload wrapped in code fences', async () => {
    const { criteria } = await seedCriteria(dir);
    const fenced: JudgeModelCaller = async () =>
      '```json\n' + JSON.stringify(goodJudgePayload()) + '\n```';

    const result = await judgeStories(dir, criteria.id, fenced);

    expect(result.ok).toBe(true);
  });

  it('unknown criteria id returns not found', async () => {
    const result = await judgeStories(dir, 'ffffffffffff', judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set ffffffffffff not found');
  });

  it('malformed criteria id returns the same not-found shape', async () => {
    const result = await judgeStories(dir, 'nope', judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set nope not found');
  });

  it('persists the verdict set as a round-trippable JSON artifact', async () => {
    const { criteria } = await seedCriteria(dir);

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const artifactPath = join(dir, WORKSPACE_DIR, VERDICTS_DIR, `${result.verdicts.id}.json`);
    expect(result.artifactPath).toBe(artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(persisted).toEqual(result.verdicts);
    expect(result.verdicts.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rejects a judge payload whose index has no matching story in a corrupted criteria set', async () => {
    const { criteria } = await seedCriteria(dir);
    const criteriaDir = join(dir, WORKSPACE_DIR, 'criteria');
    const corrupted = {
      ...criteria,
      stories: [criteria.stories[0], { ...criteria.stories[1], storyIndex: 0 }],
    };
    writeFileSync(join(criteriaDir, `${criteria.id}.json`), JSON.stringify(corrupted));

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`criteria set ${criteria.id} has no story at index 1`);
  });
});

describe('loadVerdicts', () => {
  it('round-trips a verdict set written by judgeStories', async () => {
    const { criteria } = await seedCriteria(dir);
    const written = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));
    if (!written.ok) throw new Error('expected ok');

    const result = loadVerdicts(dir, written.verdicts.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.verdicts).toEqual(written.verdicts);
    expect(result.artifactPath).toBe(written.artifactPath);
  });

  it('malformed verdict id returns not found', () => {
    const result = loadVerdicts(dir, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set nope not found');
  });

  it('absent verdict file returns not found', () => {
    const result = loadVerdicts(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set ffffffffffff not found');
  });

  it('a file containing an unrelated shape returns "is not a valid verdict set"', () => {
    const verdictsDir = join(dir, WORKSPACE_DIR, VERDICTS_DIR);
    mkdirSync(verdictsDir, { recursive: true });
    writeFileSync(join(verdictsDir, 'abcabcabcabc.json'), JSON.stringify({ nope: true }), 'utf8');

    const result = loadVerdicts(dir, 'abcabcabcabc');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set abcabcabcabc is not a valid verdict set');
  });
});

describe('buildJudgePrompt', () => {
  it('includes every intent statement, story sentence, rendered scenario, and the JSON-shape instruction', async () => {
    const { decomposition, criteria } = await seedCriteria(dir);

    const prompt = buildJudgePrompt(DOC, decomposition.stories, criteria);

    for (const statement of DOC.statements) {
      expect(prompt).toContain(`[${statement.id}]`);
      expect(prompt).toContain(statement.text);
    }
    criteria.stories.forEach((storyCriteria) => {
      const story = decomposition.stories[storyCriteria.storyIndex];
      expect(prompt).toContain(`[${storyCriteria.storyIndex}]`);
      expect(prompt).toContain(storySentence(story));
      for (const scenario of storyCriteria.scenarios) {
        expect(prompt).toContain(scenario.name);
      }
    });
    expect(prompt).toContain('"stories"');
    expect(prompt).toContain('contradicts');
    expect(prompt).toContain('names the contradicted statement id');
  });
});

describe('validateAlignmentReasons', () => {
  it('reports a deduction with no reasons', () => {
    const problems = validateAlignmentReasons([
      { storyIndex: 0, intentAlignmentScore: 0.5, reasons: [] },
    ]);
    expect(problems).toEqual(['story index 0 has an alignment deduction but no reasons']);
  });

  it('reports no problem for a perfect score with empty reasons', () => {
    const problems = validateAlignmentReasons([
      { storyIndex: 0, intentAlignmentScore: 1, reasons: [] },
    ]);
    expect(problems).toEqual([]);
  });

  it('reports no problem for a deduction that carries reasons', () => {
    const problems = validateAlignmentReasons([
      { storyIndex: 0, intentAlignmentScore: 0.4, reasons: ['drifted from INT-001'] },
    ]);
    expect(problems).toEqual([]);
  });
});

describe('judgeStories lineage failures', () => {
  it('surfaces a missing decomposition', async () => {
    const { criteria } = await seedCriteria(dir);
    const criteriaDir = join(dir, WORKSPACE_DIR, 'criteria');
    const corrupted = { ...criteria, decompositionId: 'ffffffffffff' };
    writeFileSync(join(criteriaDir, `${criteria.id}.json`), JSON.stringify(corrupted));

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition ffffffffffff not found');
  });

  it('surfaces a missing intent doc', async () => {
    const { criteria } = await seedCriteria(dir);
    const criteriaDir = join(dir, WORKSPACE_DIR, 'criteria');
    const corrupted = { ...criteria, intentId: 'ffffffffffff' };
    writeFileSync(join(criteriaDir, `${criteria.id}.json`), JSON.stringify(corrupted));

    const result = await judgeStories(dir, criteria.id, judgeFakeCaller(goodJudgePayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc ffffffffffff not found');
  });
});
