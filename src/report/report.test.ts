import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReadinessReport,
  renderReadinessReport,
  collectOpenQuestions,
  REPORTS_DIR,
  type ReadinessReport,
} from './report.js';
import {
  generateAcceptanceCriteria,
  type CriteriaModelCaller,
  type CriteriaSet,
} from '../criteria/criteria.js';
import {
  decomposeIntent,
  type Decomposition,
  type DecomposeModelCaller,
} from '../decompose/decompose.js';
import { saveIntentDoc, type IntentDoc } from '../intent/build.js';
import { approveIntentDoc } from '../intent/approve.js';
import { judgeStories, type JudgeModelCaller } from '../judge/judge.js';
import { ANSWERS_DIR, type AnswerSession } from '../interview/answers.js';
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

const REPORT_JUDGE_PAYLOAD = {
  stories: [
    { storyIndex: 0, intentAlignmentScore: 0.8, reasons: ['does not deliver INT-003'] },
    { storyIndex: 1, intentAlignmentScore: 1, reasons: [] },
  ],
};

function seedInterviewSession(
  dir: string,
  questions: AnswerSession['questions'],
  status: AnswerSession['status'],
): void {
  const session: AnswerSession = {
    questionsId: 'dddddddddddd',
    transcriptId: DOC.transcriptId,
    maxRounds: 3,
    roundsCompleted: 1,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    questions,
  };
  const answersDir = join(dir, WORKSPACE_DIR, ANSWERS_DIR);
  mkdirSync(answersDir, { recursive: true });
  writeFileSync(join(answersDir, `${DOC.interviewId}.json`), JSON.stringify(session), 'utf8');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-report-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildReadinessReport', () => {
  it('lists every story with its score and traces-to ids (AC 1 + AC 2)', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.markdown).toContain('### [0] Export CSV');
    expect(result.markdown).toContain('### [1] Export JSON');
    expect(result.markdown).toContain('- Overall: ');
    expect(result.markdown).toContain('- Traces to: INT-001, INT-003');
    expect(result.markdown).toContain('- Traces to: INT-002');
    expect(result.report.epicTitle).toBe('Exports epic');
    expect(result.report.verdictId).toBe(judged.verdicts.id);
    expect(result.report.criteriaId).toBe(criteria.id);
  });

  it('lists unresolved open questions in their own section, marks blocking ones, excludes answered ones (AC 3)', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    seedInterviewSession(
      dir,
      [
        {
          index: 0,
          question: { question: 'Already answered — should not appear', gapType: 'unclear' },
          blocking: false,
          answer: 'yes',
          answeredInRound: 1,
        },
        {
          index: 1,
          question: { question: 'Which export formats matter most?', gapType: 'assumption' },
          blocking: false,
        },
        {
          index: 3,
          question: {
            question: 'Who is the primary actor?',
            gapType: 'missing-dimension',
            dimension: 'actor',
          },
          blocking: true,
        },
      ],
      'needs-more',
    );

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.markdown).toContain('## Open questions');
    expect(result.markdown).toContain('- [1] (assumption) Which export formats matter most?');
    expect(result.markdown).toContain(
      '- [3] (missing-dimension, blocking) Who is the primary actor?',
    );
    expect(result.markdown).not.toContain('Already answered — should not appear');
    expect(result.report.openQuestions).toEqual([
      {
        index: 1,
        question: 'Which export formats matter most?',
        gapType: 'assumption',
        blocking: false,
      },
      {
        index: 3,
        question: 'Who is the primary actor?',
        gapType: 'missing-dimension',
        blocking: true,
      },
    ]);
  });

  it('every clarifying question answered renders the "none open" message', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    seedInterviewSession(
      dir,
      [
        {
          index: 0,
          question: {
            question: 'Who uses this?',
            gapType: 'missing-dimension',
            dimension: 'actor',
          },
          blocking: true,
          answer: 'PMs',
          answeredInRound: 1,
        },
      ],
      'pinned',
    );

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.markdown).toContain('## Open questions');
    expect(result.markdown).toContain('None — every clarifying question was answered.');
    expect(result.report.openQuestions).toEqual([]);
  });

  it('a missing answer-session file still succeeds with empty openQuestions (soft failure)', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.openQuestions).toEqual([]);
    expect(result.markdown).toContain('None — every clarifying question was answered.');
  });

  it('persists the report and yields a stable content-derived id across rebuilds', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');

    const first = buildReadinessReport(dir, judged.verdicts.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');

    const artifactPath = join(dir, WORKSPACE_DIR, REPORTS_DIR, `${first.report.id}.md`);
    expect(first.artifactPath).toBe(artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf8')).toBe(first.markdown);

    const second = buildReadinessReport(dir, judged.verdicts.id);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');

    expect(first.report.id).toMatch(/^[0-9a-f]{12}$/);
    expect(second.report.id).toBe(first.report.id);
  });
});

describe('buildReadinessReport error paths', () => {
  it('unknown verdict id returns not found', () => {
    const result = buildReadinessReport(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set ffffffffffff not found');
  });

  it('malformed verdict id returns the same not-found shape', () => {
    const result = buildReadinessReport(dir, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set nope not found');
  });

  it('corrupt verdict JSON on disk returns "is not a valid verdict set"', () => {
    const verdictsDir = join(dir, WORKSPACE_DIR, 'verdicts');
    mkdirSync(verdictsDir, { recursive: true });
    writeFileSync(join(verdictsDir, 'abcabcabcabc.json'), JSON.stringify({ nope: true }), 'utf8');

    const result = buildReadinessReport(dir, 'abcabcabcabc');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('verdict set abcabcabcabc is not a valid verdict set');
  });

  it('a verdict set pointing at a missing decomposition surfaces the decomposition loader error', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    const verdictsDir = join(dir, WORKSPACE_DIR, 'verdicts');
    const corrupted = { ...judged.verdicts, decompositionId: 'ffffffffffff' };
    writeFileSync(join(verdictsDir, `${judged.verdicts.id}.json`), JSON.stringify(corrupted));

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('decomposition ffffffffffff not found');
  });

  it('a verdict set pointing at a missing intent doc surfaces the intent-doc loader error', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(REPORT_JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    const verdictsDir = join(dir, WORKSPACE_DIR, 'verdicts');
    const corrupted = { ...judged.verdicts, intentId: 'ffffffffffff' };
    writeFileSync(join(verdictsDir, `${judged.verdicts.id}.json`), JSON.stringify(corrupted));

    const result = buildReadinessReport(dir, judged.verdicts.id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc ffffffffffff not found');
  });
});

const BASE_REPORT: ReadinessReport = {
  id: 'ridridridrid',
  verdictId: 'vidvidvidvid',
  criteriaId: 'cidcidcidcid',
  decompositionId: 'didcompdidco',
  intentId: 'intidintidid',
  createdAt: '2026-01-01T00:00:00.000Z',
  epicTitle: 'Exports epic',
  epicSummary: 'Ship exports end to end',
  stories: [],
  openQuestions: [],
};

describe('renderReadinessReport', () => {
  it('renders "Nothing missing" for a story with no reasons, and both prefixes for a story with reasons', () => {
    const report: ReadinessReport = {
      ...BASE_REPORT,
      stories: [
        {
          storyIndex: 0,
          storyTitle: 'Clean story',
          tracesTo: ['INT-001'],
          readinessScore: 1,
          intentAlignmentScore: 1,
          overallScore: 1,
          readinessReasons: [],
          intentAlignmentReasons: [],
        },
        {
          storyIndex: 1,
          storyTitle: 'Messy story',
          tracesTo: ['INT-002'],
          readinessScore: 0.75,
          intentAlignmentScore: 0.5,
          overallScore: 0.625,
          readinessReasons: ['Story names a single clear actor'],
          intentAlignmentReasons: ['does not deliver INT-002'],
        },
      ],
    };

    const markdown = renderReadinessReport(report);

    expect(markdown).toContain('Nothing missing — this story is ready.');
    expect(markdown).toContain('- readiness: Story names a single clear actor');
    expect(markdown).toContain('- intent alignment: does not deliver INT-002');
  });

  it('escapes a pipe character in a story title so the summary table stays valid', () => {
    const report: ReadinessReport = {
      ...BASE_REPORT,
      stories: [
        {
          storyIndex: 0,
          storyTitle: 'Export | CSV',
          tracesTo: ['INT-001'],
          readinessScore: 1,
          intentAlignmentScore: 1,
          overallScore: 1,
          readinessReasons: [],
          intentAlignmentReasons: [],
        },
      ],
    };

    const markdown = renderReadinessReport(report);

    expect(markdown).toContain('| [0] Export \\| CSV |');
    expect(markdown).not.toContain('| [0] Export | CSV |');
  });
});

describe('collectOpenQuestions', () => {
  it('filters answered questions and sorts the remainder by index — pure', () => {
    const session: AnswerSession = {
      questionsId: 'qqqqqqqqqqqq',
      transcriptId: 'tttttttttttt',
      maxRounds: 3,
      roundsCompleted: 1,
      status: 'needs-more',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      questions: [
        { index: 2, question: { question: 'B?', gapType: 'assumption' }, blocking: false },
        {
          index: 0,
          question: { question: 'Answered?', gapType: 'unclear' },
          blocking: false,
          answer: 'yes',
          answeredInRound: 1,
        },
        {
          index: 1,
          question: { question: 'A?', gapType: 'missing-dimension', dimension: 'actor' },
          blocking: true,
        },
      ],
    };

    const result = collectOpenQuestions(session);

    expect(result).toEqual([
      { index: 1, question: 'A?', gapType: 'missing-dimension', blocking: true },
      { index: 2, question: 'B?', gapType: 'assumption', blocking: false },
    ]);
    // purity: the input session is untouched
    expect(session.questions.length).toBe(3);
  });
});
