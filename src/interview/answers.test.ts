import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordAnswerRound,
  loadAnswerSession,
  evaluateStoppingRule,
  isBlockingQuestion,
  openBlockingQuestions,
  ANSWERS_DIR,
  type SessionQuestion,
} from './answers.js';
import { generateClarifyingQuestions, type QuestionModelCaller } from './questions.js';
import { intakeTranscript } from '../intake/intake.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const RICH_TEXT =
  'As a PM user I want exports. Success metric: adoption up 10%. Constraint: deadline is Q3, budget capped.\n';

const MIXED = [
  { question: 'Who uses this?', gapType: 'unclear', dimension: 'actor' },
  { question: 'What metric moves?', gapType: 'unclear', dimension: 'success-measure' },
  { question: 'Nice-to-have: dark mode?', gapType: 'assumption' },
];

const NO_BLOCKING = [{ question: 'Nice-to-have: dark mode?', gapType: 'assumption' }];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-answers-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeCaller(payload: unknown): QuestionModelCaller {
  return async () => JSON.stringify(payload);
}

async function seedQuestions(targetDir: string, payload: unknown): Promise<string> {
  const transcriptResult = intakeTranscript(targetDir, RICH_TEXT, 'test.txt');
  if (!transcriptResult.ok) throw new Error('expected ok');
  const questionsResult = await generateClarifyingQuestions(
    targetDir,
    transcriptResult.artifact.id,
    fakeCaller(payload),
  );
  if (!questionsResult.ok) throw new Error('expected ok');
  return questionsResult.artifact.id;
}

describe('isBlockingQuestion', () => {
  it('true when dimension is set', () => {
    expect(isBlockingQuestion({ question: 'q', gapType: 'unclear', dimension: 'actor' })).toBe(
      true,
    );
  });

  it('false when dimension is absent', () => {
    expect(isBlockingQuestion({ question: 'q', gapType: 'assumption' })).toBe(false);
  });
});

describe('evaluateStoppingRule', () => {
  const blocking: SessionQuestion = {
    index: 0,
    question: { question: 'q', gapType: 'unclear', dimension: 'actor' },
    blocking: true,
  };
  const nonBlocking: SessionQuestion = {
    index: 1,
    question: { question: 'q2', gapType: 'assumption' },
    blocking: false,
  };

  it('pinned when all blocking questions are answered', () => {
    const answered: SessionQuestion = { ...blocking, answer: 'a', answeredInRound: 1 };
    expect(evaluateStoppingRule([answered, nonBlocking], 1, 3)).toBe('pinned');
  });

  it('needs-more at budget with blocking still open', () => {
    expect(evaluateStoppingRule([blocking, nonBlocking], 3, 3)).toBe('needs-more');
  });

  it('needs-more over budget with blocking still open', () => {
    expect(evaluateStoppingRule([blocking, nonBlocking], 4, 3)).toBe('needs-more');
  });

  it('in-progress when under budget and blocking still open', () => {
    expect(evaluateStoppingRule([blocking, nonBlocking], 1, 3)).toBe('in-progress');
  });

  it('pinned when there are no blocking questions (vacuous)', () => {
    expect(evaluateStoppingRule([nonBlocking], 1, 3)).toBe('pinned');
  });
});

describe('recordAnswerRound', () => {
  it('pinned when all blocking answered (AC scenario 1)', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const result = recordAnswerRound(dir, questionsId, { '0': 'PMs', '1': 'Adoption up 10%' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('pinned');
    expect(result.session.roundsCompleted).toBe(1);
    expect(result.session.questions[0]?.answer).toBe('PMs');
    expect(result.session.questions[0]?.answeredInRound).toBe(1);
    expect(result.session.questions[1]?.answer).toBe('Adoption up 10%');
    expect(result.session.questions[1]?.answeredInRound).toBe(1);

    const sessionPath = join(dir, WORKSPACE_DIR, ANSWERS_DIR, `${questionsId}.json`);
    expect(result.sessionPath).toBe(sessionPath);
    expect(existsSync(sessionPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf8'));
    expect(parsed).toEqual(result.session);

    const transcriptId = result.session.transcriptId;
    expect(transcriptId.length).toBeGreaterThan(0);
  });

  it('pinned on the final round (rule 1 beats rule 2)', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    recordAnswerRound(dir, questionsId, {}, { maxRounds: 3 });
    recordAnswerRound(dir, questionsId, {}, { maxRounds: 3 });
    const result = recordAnswerRound(dir, questionsId, { '0': 'a', '1': 'b' }, { maxRounds: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('pinned');
    expect(result.session.roundsCompleted).toBe(3);
  });

  it('needs-more at the budget (AC scenario 2); a fourth round is rejected', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    recordAnswerRound(dir, questionsId, { '2': 'x' }, { maxRounds: 3 });
    recordAnswerRound(dir, questionsId, {}, { maxRounds: 3 });
    const third = recordAnswerRound(dir, questionsId, {}, { maxRounds: 3 });

    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('expected ok');
    expect(third.session.status).toBe('needs-more');
    const open = openBlockingQuestions(third.session);
    expect(open.map((q) => q.index)).toEqual([0, 1]);

    const fourth = recordAnswerRound(dir, questionsId, { '0': 'a' }, { maxRounds: 3 });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) throw new Error('expected not ok');
    expect(fourth.error).toContain('needs-more');
  });

  it('terminal pinned session rejects further rounds', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    recordAnswerRound(dir, questionsId, { '0': 'a', '1': 'b' });
    const result = recordAnswerRound(dir, questionsId, { '2': 'c' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('pinned');
  });

  it('in-progress when some blocking questions remain open', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const result = recordAnswerRound(dir, questionsId, { '0': 'a' }, { maxRounds: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('in-progress');
    const open = openBlockingQuestions(result.session);
    expect(open.map((q) => q.index)).toEqual([1]);
  });

  it('no blocking questions pins immediately on an empty round', async () => {
    const questionsId = await seedQuestions(dir, NO_BLOCKING);
    const result = recordAnswerRound(dir, questionsId, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.status).toBe('pinned');
  });

  it('re-answering a question overwrites the previous answer', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    recordAnswerRound(dir, questionsId, { '0': 'a' }, { maxRounds: 3 });
    const result = recordAnswerRound(dir, questionsId, { '0': 'b' }, { maxRounds: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.questions[0]?.answer).toBe('b');
    expect(result.session.questions[0]?.answeredInRound).toBe(2);
  });

  it('maxRounds is frozen at session creation', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    recordAnswerRound(dir, questionsId, {}, { maxRounds: 2 });
    const result = recordAnswerRound(dir, questionsId, {}, { maxRounds: 99 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.maxRounds).toBe(2);
    expect(result.session.status).toBe('needs-more');
  });

  it('rejects an out-of-range answer index', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const result = recordAnswerRound(dir, questionsId, { '9': 'x' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('9');
  });

  it('rejects an empty or whitespace-only answer', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const result = recordAnswerRound(dir, questionsId, { '0': '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('0');
  });

  it('rejects a non-string answer value instead of throwing', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const result = recordAnswerRound(dir, questionsId, { '0': 123 } as unknown as Record<
      string,
      string
    >);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('0');
  });

  it('rejects a non-positive-integer maxRounds', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const zero = recordAnswerRound(dir, questionsId, {}, { maxRounds: 0 });
    expect(zero.ok).toBe(false);

    const fractional = recordAnswerRound(dir, questionsId, {}, { maxRounds: 1.5 });
    expect(fractional.ok).toBe(false);
  });

  it('rejects a malformed questionsId (path traversal) without touching the filesystem', () => {
    const result = recordAnswerRound(dir, '../../../etc/passwd', {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not found');
    expect(existsSync(join(dir, WORKSPACE_DIR, ANSWERS_DIR))).toBe(false);
  });

  it('missing questions artifact returns an error naming the id', () => {
    const result = recordAnswerRound(dir, 'deadbeefcafe', {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('deadbeefcafe');
    expect(existsSync(join(dir, WORKSPACE_DIR, ANSWERS_DIR))).toBe(false);
  });

  it('corrupt questions artifact JSON returns an error', () => {
    const questionsDir = join(dir, WORKSPACE_DIR, 'questions');
    mkdirSync(questionsDir, { recursive: true });
    writeFileSync(join(questionsDir, 'abcabcabcabc.json'), 'not valid json{', 'utf8');

    const result = recordAnswerRound(dir, 'abcabcabcabc', {});
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, WORKSPACE_DIR, ANSWERS_DIR))).toBe(false);
  });

  it('shape-invalid questions artifact returns an error', () => {
    const questionsDir = join(dir, WORKSPACE_DIR, 'questions');
    mkdirSync(questionsDir, { recursive: true });
    writeFileSync(join(questionsDir, 'abcabcabcabc.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const result = recordAnswerRound(dir, 'abcabcabcabc', {});
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, WORKSPACE_DIR, ANSWERS_DIR))).toBe(false);
  });

  it('corrupt session file returns an error', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const answersDir = join(dir, WORKSPACE_DIR, ANSWERS_DIR);
    mkdirSync(answersDir, { recursive: true });
    writeFileSync(join(answersDir, `${questionsId}.json`), 'not valid json{', 'utf8');

    const result = recordAnswerRound(dir, questionsId, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('corrupt');
  });

  it('shape-invalid session file returns an error', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const answersDir = join(dir, WORKSPACE_DIR, ANSWERS_DIR);
    mkdirSync(answersDir, { recursive: true });
    writeFileSync(join(answersDir, `${questionsId}.json`), JSON.stringify({ foo: 'bar' }), 'utf8');

    const result = recordAnswerRound(dir, questionsId, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('corrupt');
  });
});

describe('loadAnswerSession', () => {
  it('round-trips a session written by recordAnswerRound', async () => {
    const questionsId = await seedQuestions(dir, MIXED);
    const written = recordAnswerRound(dir, questionsId, { '0': 'a', '1': 'b' });
    if (!written.ok) throw new Error('expected ok');

    const result = loadAnswerSession(dir, questionsId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.session).toEqual(written.session);
    expect(result.sessionPath).toBe(written.sessionPath);
  });

  it('malformed interview id returns not found', () => {
    const result = loadAnswerSession(dir, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('interview nope not found');
  });

  it('absent interview session returns not found', () => {
    const result = loadAnswerSession(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('interview ffffffffffff not found');
  });

  it('corrupt interview JSON returns "is not a valid interview artifact"', () => {
    const answersDir = join(dir, WORKSPACE_DIR, ANSWERS_DIR);
    mkdirSync(answersDir, { recursive: true });
    writeFileSync(join(answersDir, 'abcabcabcabc.json'), 'not valid json{', 'utf8');

    const result = loadAnswerSession(dir, 'abcabcabcabc');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('interview abcabcabcabc is not a valid interview artifact');
  });
});
