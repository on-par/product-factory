import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decomposeIntent,
  loadDecomposition,
  buildDecomposePrompt,
  validateTraceability,
  storySentence,
  DECOMPOSITIONS_DIR,
  type DecomposeModelCaller,
  type DecomposedStory,
} from './decompose.js';
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

function seedApprovedDoc(dir: string): void {
  saveIntentDoc(dir, DOC);
  const r = approveIntentDoc(dir, DOC.id, 'tester');
  if (!r.ok) throw new Error('expected ok');
}

const fakeCaller = (payload: unknown): DecomposeModelCaller => {
  return async () => JSON.stringify(payload);
};

const GOOD_PAYLOAD = {
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-decompose-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('decomposeIntent', () => {
  it('decomposes into traceable stories (AC 1)', async () => {
    seedApprovedDoc(dir);

    const result = await decomposeIntent(dir, DOC.id, fakeCaller(GOOD_PAYLOAD));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.decomposition.epic).toEqual(GOOD_PAYLOAD.epic);
    expect(result.decomposition.stories.length).toBeGreaterThanOrEqual(1);
    const known = new Set(DOC.statements.map((s) => s.id));
    for (const story of result.decomposition.stories) {
      expect(story.asA.length).toBeGreaterThan(0);
      expect(story.iWant.length).toBeGreaterThan(0);
      expect(story.soThat.length).toBeGreaterThan(0);
      expect(story.tracesTo.length).toBeGreaterThanOrEqual(1);
      for (const id of story.tracesTo) {
        expect(known.has(id)).toBe(true);
      }
    }

    const artifactPath = join(
      dir,
      WORKSPACE_DIR,
      DECOMPOSITIONS_DIR,
      `${result.decomposition.id}.json`,
    );
    expect(result.artifactPath).toBe(artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(parsed).toEqual(result.decomposition);
  });

  it('yields a content-derived id stable across runs', async () => {
    seedApprovedDoc(dir);

    const first = await decomposeIntent(dir, DOC.id, fakeCaller(GOOD_PAYLOAD));
    const second = await decomposeIntent(dir, DOC.id, fakeCaller(GOOD_PAYLOAD));
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(first.decomposition.id).toMatch(/^[0-9a-f]{12}$/);
    expect(second.decomposition.id).toBe(first.decomposition.id);
  });

  it('rejects orphan traces (AC 2)', async () => {
    seedApprovedDoc(dir);
    const badPayload = {
      epic: GOOD_PAYLOAD.epic,
      stories: [
        {
          title: 'Export CSV',
          asA: 'PM',
          iWant: 'to export stories as CSV',
          soThat: 'I can share them',
          tracesTo: ['INT-999'],
        },
      ],
    };

    const result = await decomposeIntent(dir, DOC.id, fakeCaller(badPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('INT-999');

    const decompositionsDir = join(dir, WORKSPACE_DIR, DECOMPOSITIONS_DIR);
    expect(existsSync(decompositionsDir)).toBe(false);
  });

  it('rejects a story with empty tracesTo', async () => {
    seedApprovedDoc(dir);
    const badPayload = {
      epic: GOOD_PAYLOAD.epic,
      stories: [
        {
          title: 'Export CSV',
          asA: 'PM',
          iWant: 'to export stories as CSV',
          soThat: 'I can share them',
          tracesTo: [],
        },
      ],
    };

    const result = await decomposeIntent(dir, DOC.id, fakeCaller(badPayload));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid decomposition payload');
  });

  it('rejects an unapproved doc', async () => {
    saveIntentDoc(dir, DOC);

    const result = await decomposeIntent(dir, DOC.id, fakeCaller(GOOD_PAYLOAD));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`intent doc ${DOC.id} is not approved`);
  });

  it('unknown intentId returns not found', async () => {
    const result = await decomposeIntent(dir, 'ffffffffffff', fakeCaller(GOOD_PAYLOAD));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc ffffffffffff not found');
  });

  it('malformed intentId returns the same not-found shape', async () => {
    const result = await decomposeIntent(dir, 'nope', fakeCaller(GOOD_PAYLOAD));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc nope not found');
  });

  it('invalid model output returns an error', async () => {
    seedApprovedDoc(dir);

    const result = await decomposeIntent(dir, DOC.id, async () => 'not json');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('model returned an invalid decomposition payload');
  });

  it('a caller that throws surfaces the failure', async () => {
    seedApprovedDoc(dir);

    const result = await decomposeIntent(dir, DOC.id, async () => {
      throw new Error('network down');
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('model call failed:');
  });

  it('tolerates a payload wrapped in code fences', async () => {
    seedApprovedDoc(dir);
    const fenced: DecomposeModelCaller = async () =>
      '```json\n' + JSON.stringify(GOOD_PAYLOAD) + '\n```';

    const result = await decomposeIntent(dir, DOC.id, fenced);

    expect(result.ok).toBe(true);
  });
});

describe('loadDecomposition', () => {
  it('round-trips an artifact created by decomposeIntent', async () => {
    seedApprovedDoc(dir);
    const created = await decomposeIntent(dir, DOC.id, fakeCaller(GOOD_PAYLOAD));
    if (!created.ok) throw new Error('expected ok');

    const result = loadDecomposition(dir, created.decomposition.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.decomposition).toEqual(created.decomposition);
    expect(result.artifactPath).toBe(created.artifactPath);
  });

  it('unknown decompositionId returns not found', () => {
    const result = loadDecomposition(dir, 'ffffffffffff');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition ffffffffffff not found');
  });

  it('malformed decompositionId returns the same not-found shape', () => {
    const result = loadDecomposition(dir, 'nope');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition nope not found');
  });

  it('corrupt artifact file returns an invalid-decomposition error', () => {
    const decompositionsDir = join(dir, WORKSPACE_DIR, DECOMPOSITIONS_DIR);
    const id = 'abcdefabcdef';
    mkdirSync(decompositionsDir, { recursive: true });
    writeFileSync(join(decompositionsDir, `${id}.json`), 'not json', 'utf8');

    const result = loadDecomposition(dir, id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`decomposition ${id} is not a valid decomposition`);
  });
});

describe('validateTraceability', () => {
  it('returns no problems for valid stories', () => {
    const stories = GOOD_PAYLOAD.stories as DecomposedStory[];
    expect(validateTraceability(stories, DOC)).toEqual([]);
  });

  it('reports one message per orphan id, naming the story and the id', () => {
    const stories: DecomposedStory[] = [
      {
        title: 'Export CSV',
        asA: 'PM',
        iWant: 'to export',
        soThat: 'value',
        tracesTo: ['INT-999'],
      },
    ];

    const problems = validateTraceability(stories, DOC);
    expect(problems).toEqual(['story "Export CSV" references unknown intent id INT-999']);
  });
});

describe('storySentence', () => {
  it('composes the As a / I want / so that sentence', () => {
    const story: DecomposedStory = {
      title: 'Export CSV',
      asA: 'PM',
      iWant: 'to export stories as CSV',
      soThat: 'I can share them',
      tracesTo: ['INT-001'],
    };
    expect(storySentence(story)).toBe(
      'As a PM, I want to export stories as CSV, so that I can share them.',
    );
  });
});

describe('buildDecomposePrompt', () => {
  it('includes every statement id, doc sections, and the JSON-shape instruction', () => {
    const prompt = buildDecomposePrompt(DOC);
    expect(prompt).toContain('INT-001');
    expect(prompt).toContain('INT-002');
    expect(prompt).toContain('INT-003');
    expect(prompt).toContain('Goal: Ship exports');
    expect(prompt).toContain('Actor: PM');
    expect(prompt).toContain('Constraints:');
    expect(prompt).toContain('- deadline Q3');
    expect(prompt).toContain('"epic"');
  });

  it('omits empty sections', () => {
    const emptyDoc: IntentDoc = { ...DOC, goal: '', actor: '', constraints: [] };
    const prompt = buildDecomposePrompt(emptyDoc);
    expect(prompt).not.toContain('Goal:');
    expect(prompt).not.toContain('Actor:');
    expect(prompt).not.toContain('Constraints:');
  });
});
