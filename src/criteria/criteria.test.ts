import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateAcceptanceCriteria,
  loadCriteria,
  buildCriteriaPrompt,
  validateScenarioCoverage,
  renderScenario,
  checkStoryReadiness,
  CRITERIA_DIR,
  type CriteriaModelCaller,
  type GherkinScenario,
} from './criteria.js';
import {
  decomposeIntent,
  storySentence,
  type Decomposition,
  type DecomposeModelCaller,
} from '../decompose/decompose.js';
import { saveIntentDoc, type IntentDoc } from '../intent/build.js';
import { approveIntentDoc } from '../intent/approve.js';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { scoreReadiness } from '../readiness/score.js';

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

const fakeCaller = (payload: unknown): CriteriaModelCaller => {
  return async () => JSON.stringify(payload);
};

function goodPayload() {
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-criteria-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generateAcceptanceCriteria', () => {
  it('generates Gherkin acceptance criteria for every story (AC: every story covered)', async () => {
    const decomposition = await seedDecomposition(dir);

    const result = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.criteria.decompositionId).toBe(decomposition.id);
    expect(result.criteria.intentId).toBe(decomposition.intentId);
    expect(result.criteria.stories.length).toBe(decomposition.stories.length);

    const seenIndices = new Set<number>();
    result.criteria.stories.forEach((storyCriteria, position) => {
      expect(storyCriteria.scenarios.length).toBeGreaterThanOrEqual(1);
      expect(seenIndices.has(storyCriteria.storyIndex)).toBe(false);
      seenIndices.add(storyCriteria.storyIndex);

      const story = decomposition.stories[storyCriteria.storyIndex];
      expect(storyCriteria.storyTitle).toBe(story.title);
      expect(storyCriteria.tracesTo).toEqual(story.tracesTo);
      // sorted ascending by storyIndex
      if (position > 0) {
        expect(storyCriteria.storyIndex).toBeGreaterThan(
          result.criteria.stories[position - 1].storyIndex,
        );
      }
    });

    const artifactPath = join(dir, WORKSPACE_DIR, CRITERIA_DIR, `${result.criteria.id}.json`);
    expect(result.artifactPath).toBe(artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(parsed).toEqual(result.criteria);
  });

  it('every scenario has at least one given, when, and then step (AC: criteria are parseable)', async () => {
    const decomposition = await seedDecomposition(dir);

    const result = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    for (const storyCriteria of result.criteria.stories) {
      for (const scenario of storyCriteria.scenarios) {
        expect(scenario.given.length).toBeGreaterThanOrEqual(1);
        expect(scenario.when.length).toBeGreaterThanOrEqual(1);
        expect(scenario.then.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('rejects a scenario missing its then steps', async () => {
    const decomposition = await seedDecomposition(dir);
    const badPayload = goodPayload();
    badPayload.stories[0].scenarios[0].then = [];

    const result = await generateAcceptanceCriteria(dir, decomposition.id, fakeCaller(badPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid criteria payload');
  });

  it('rejects a payload referencing an unknown story index', async () => {
    const decomposition = await seedDecomposition(dir);
    const badPayload = {
      stories: [
        {
          storyIndex: 7,
          scenarios: [
            {
              name: 'Bogus',
              given: ['a'],
              when: ['b'],
              then: ['c'],
            },
          ],
        },
      ],
    };

    const result = await generateAcceptanceCriteria(dir, decomposition.id, fakeCaller(badPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('unknown story index 7');
  });

  it('rejects a payload covering only some stories', async () => {
    const decomposition = await seedDecomposition(dir);
    const partialPayload = {
      stories: [goodPayload().stories[0]],
    };

    const result = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(partialPayload),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('story index 1 has no scenarios');
  });

  it('rejects a payload with duplicate entries for the same story', async () => {
    const decomposition = await seedDecomposition(dir);
    const payload = goodPayload();
    const duplicatePayload = {
      stories: [payload.stories[0], payload.stories[0], payload.stories[1]],
    };

    const result = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(duplicatePayload),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('appears more than once');
  });

  it('yields a content-derived id stable across runs', async () => {
    const decomposition = await seedDecomposition(dir);

    const first = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );
    const second = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(first.criteria.id).toMatch(/^[0-9a-f]{12}$/);
    expect(second.criteria.id).toBe(first.criteria.id);
  });

  it('unknown decompositionId returns not found', async () => {
    const result = await generateAcceptanceCriteria(dir, 'ffffffffffff', fakeCaller(goodPayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition ffffffffffff not found');
  });

  it('malformed decompositionId returns the same not-found shape', async () => {
    const result = await generateAcceptanceCriteria(dir, 'nope', fakeCaller(goodPayload()));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition nope not found');
  });

  it('invalid model output returns an error', async () => {
    const decomposition = await seedDecomposition(dir);

    const result = await generateAcceptanceCriteria(dir, decomposition.id, async () => 'not json');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid criteria payload');
  });

  it('a caller that throws surfaces the failure', async () => {
    const decomposition = await seedDecomposition(dir);

    const result = await generateAcceptanceCriteria(dir, decomposition.id, async () => {
      throw new Error('network down');
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('model call failed:');
  });

  it('tolerates a payload wrapped in code fences', async () => {
    const decomposition = await seedDecomposition(dir);
    const fenced: CriteriaModelCaller = async () =>
      '```json\n' + JSON.stringify(goodPayload()) + '\n```';

    const result = await generateAcceptanceCriteria(dir, decomposition.id, fenced);

    expect(result.ok).toBe(true);
  });

  it('flags a story that fails the readiness rubric and persists the flag (AC: flag on the story)', async () => {
    seedApprovedDoc(dir);
    const decomposeResult = await decomposeIntent(
      dir,
      DOC.id,
      decomposeFakeCaller({
        epic: DECOMPOSE_PAYLOAD.epic,
        stories: [{ ...DECOMPOSE_PAYLOAD.stories[0], asA: ' ' }, DECOMPOSE_PAYLOAD.stories[1]],
      }),
    );
    if (!decomposeResult.ok) throw new Error('expected ok');

    const result = await generateAcceptanceCriteria(
      dir,
      decomposeResult.decomposition.id,
      fakeCaller(goodPayload()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.criteria.stories[0].readinessFlags).toContain('Story names a single clear actor');

    const persisted = JSON.parse(readFileSync(result.artifactPath, 'utf8'));
    expect(persisted.stories[0].readinessFlags).toContain('Story names a single clear actor');
  });

  it('emits no readiness flags for a fully-formed story (AC: fully formed story passes clean)', async () => {
    const decomposition = await seedDecomposition(dir);

    const result = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    for (const storyCriteria of result.criteria.stories) {
      expect(storyCriteria.readinessFlags).toEqual([]);
    }
  });
});

describe('loadCriteria', () => {
  it('round-trips a persisted criteria set', async () => {
    const decomposition = await seedDecomposition(dir);
    const generated = await generateAcceptanceCriteria(
      dir,
      decomposition.id,
      fakeCaller(goodPayload()),
    );
    if (!generated.ok) throw new Error('expected ok');

    const result = loadCriteria(dir, generated.criteria.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.criteria).toEqual(generated.criteria);
    expect(result.artifactPath).toBe(generated.artifactPath);
  });

  it('malformed criteria id returns not found', () => {
    const result = loadCriteria(dir, 'nope');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set nope not found');
  });

  it('missing criteria file returns not found', () => {
    const result = loadCriteria(dir, 'ffffffffffff');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set ffffffffffff not found');
  });

  it('invalid JSON returns an invalid-shape error', () => {
    const criteriaDir = join(dir, WORKSPACE_DIR, CRITERIA_DIR);
    mkdirSync(criteriaDir, { recursive: true });
    writeFileSync(join(criteriaDir, 'aaaaaaaaaaaa.json'), 'not json', 'utf8');

    const result = loadCriteria(dir, 'aaaaaaaaaaaa');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set aaaaaaaaaaaa is not a valid criteria set');
  });

  it('invalid shape returns an invalid-shape error', () => {
    const criteriaDir = join(dir, WORKSPACE_DIR, CRITERIA_DIR);
    mkdirSync(criteriaDir, { recursive: true });
    writeFileSync(join(criteriaDir, 'aaaaaaaaaaaa.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const result = loadCriteria(dir, 'aaaaaaaaaaaa');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('criteria set aaaaaaaaaaaa is not a valid criteria set');
  });
});

describe('renderScenario', () => {
  it('renders Given/When/Then with And for subsequent steps', () => {
    const scenario: GherkinScenario = {
      name: 'Export as CSV',
      given: ['a PM is signed in', 'they have stories to export'],
      when: ['they request a CSV export'],
      then: ['a CSV file is produced', 'the file lists every story'],
    };

    const rendered = renderScenario(scenario);

    expect(rendered).toBe(
      [
        'Scenario: Export as CSV',
        '  Given a PM is signed in',
        '  And they have stories to export',
        '  When they request a CSV export',
        '  Then a CSV file is produced',
        '  And the file lists every story',
      ].join('\n'),
    );
  });

  it('satisfies the readiness rubric Gherkin check', () => {
    const scenario: GherkinScenario = {
      name: 'Export as CSV',
      given: ['a PM has stories to export'],
      when: ['they request a CSV export'],
      then: ['a CSV file is produced'],
    };

    const rendered = renderScenario(scenario);
    const result = scoreReadiness({
      actor: 'As a PM',
      acceptanceCriteria: [rendered],
      openQuestions: [],
    });

    const gherkinCheck = result.checks.find((check) => check.id === 'gherkin-acceptance-criteria');
    expect(gherkinCheck?.passed).toBe(true);
  });
});

describe('checkStoryReadiness', () => {
  const validScenario: GherkinScenario = {
    name: 'Export as CSV',
    given: ['a PM has stories to export'],
    when: ['they request a CSV export'],
    then: ['a CSV file is produced'],
  };

  it('flags a story with a whitespace-only actor', () => {
    const story = { ...DECOMPOSE_PAYLOAD.stories[0], asA: ' ' };

    const flags = checkStoryReadiness(story, [validScenario]);

    expect(flags).toEqual(['Story names a single clear actor']);
  });

  it('returns no flags for a story with a real actor and a valid scenario', () => {
    const story = { ...DECOMPOSE_PAYLOAD.stories[0], asA: 'PM' };

    const flags = checkStoryReadiness(story, [validScenario]);

    expect(flags).toEqual([]);
  });

  it('flags a story with a real actor and no scenarios', () => {
    const story = { ...DECOMPOSE_PAYLOAD.stories[0], asA: 'PM' };

    const flags = checkStoryReadiness(story, []);

    expect(flags).toEqual([
      'Story has at least one acceptance criterion',
      'At least one acceptance criterion uses Given/When/Then',
    ]);
  });
});

describe('validateScenarioCoverage', () => {
  it('returns no problems when every story is covered exactly once', () => {
    expect(validateScenarioCoverage([{ storyIndex: 0 }, { storyIndex: 1 }], 2)).toEqual([]);
  });

  it('reports an unknown story index', () => {
    expect(validateScenarioCoverage([{ storyIndex: 5 }], 2)).toEqual([
      'scenario group references unknown story index 5',
      'story index 0 has no scenarios',
      'story index 1 has no scenarios',
    ]);
  });

  it('reports a duplicate story index', () => {
    expect(validateScenarioCoverage([{ storyIndex: 0 }, { storyIndex: 0 }], 1)).toEqual([
      'story index 0 appears more than once',
    ]);
  });

  it('reports a story with no scenarios', () => {
    expect(validateScenarioCoverage([{ storyIndex: 0 }], 2)).toEqual([
      'story index 1 has no scenarios',
    ]);
  });
});

describe('buildCriteriaPrompt', () => {
  it('includes every story index, sentence, traces-to ids, and the JSON-shape instruction', () => {
    const decomposition: Decomposition = {
      id: 'abcdefabcdef',
      intentId: DOC.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      epic: DECOMPOSE_PAYLOAD.epic,
      stories: DECOMPOSE_PAYLOAD.stories,
    };

    const prompt = buildCriteriaPrompt(decomposition);

    decomposition.stories.forEach((story, index) => {
      expect(prompt).toContain(`[${index}]`);
      expect(prompt).toContain(storySentence(story));
      for (const id of story.tracesTo) {
        expect(prompt).toContain(id);
      }
    });
    expect(prompt).toContain('"stories"');
  });
});
