import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntentDoc, loadIntentDoc, saveIntentDoc, INTENT_DIR } from './build.js';
import { intakeTranscript } from '../intake/intake.js';
import { generateClarifyingQuestions, type QuestionModelCaller } from '../interview/questions.js';
import { recordAnswerRound } from '../interview/answers.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const TEXT = 'Line one of intent.\nLine two of intent.\n';

// Explicitly states all three intent dimensions so the deterministic gap
// analysis in generateClarifyingQuestions finds nothing missing, and no
// fallback blocking questions get added on top of the payload below.
const GAPLESS_TEXT =
  'As a PM user I want exports.\nSuccess metric: adoption up 10%, constraint: deadline is Q3.\n';

const DIMENSION_QUESTIONS = [
  { question: 'Who is the actor?', gapType: 'unclear', dimension: 'actor' },
  { question: 'What is the success measure?', gapType: 'unclear', dimension: 'success-measure' },
  { question: 'What are the constraints?', gapType: 'unclear', dimension: 'constraints' },
  { question: 'Nice-to-have: dark mode?', gapType: 'assumption' },
];

const NO_BLOCKING = [{ question: 'Nice-to-have: dark mode?', gapType: 'assumption' }];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-intent-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeCaller(payload: unknown): QuestionModelCaller {
  return async () => JSON.stringify(payload);
}

async function seedPinned(
  targetDir: string,
  payload: unknown,
  answers: Readonly<Record<string, string>>,
  transcriptText: string = TEXT,
): Promise<{ readonly interviewId: string; readonly transcriptId: string }> {
  const transcriptResult = intakeTranscript(targetDir, transcriptText, 'test.txt');
  if (!transcriptResult.ok) throw new Error('expected ok');
  const questionsResult = await generateClarifyingQuestions(
    targetDir,
    transcriptResult.artifact.id,
    fakeCaller(payload),
  );
  if (!questionsResult.ok) throw new Error('expected ok');
  const answerResult = recordAnswerRound(targetDir, questionsResult.artifact.id, answers);
  if (!answerResult.ok) throw new Error('expected ok');
  if (answerResult.session.status !== 'pinned') {
    throw new Error(`expected pinned, got ${answerResult.session.status}`);
  }
  return { interviewId: questionsResult.artifact.id, transcriptId: transcriptResult.artifact.id };
}

describe('buildIntentDoc', () => {
  it('builds a doc with stable sequential ids', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const result = buildIntentDoc(dir, interviewId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.doc.statements.map((s) => s.id)).toEqual([
      'INT-001',
      'INT-002',
      'INT-003',
      'INT-004',
      'INT-005',
    ]);
    expect(result.doc.statements[0]).toMatchObject({
      text: 'Line one of intent.',
      source: 'transcript',
    });
    expect(result.doc.statements[1]).toMatchObject({
      text: 'Line two of intent.',
      source: 'transcript',
    });
    expect(result.doc.statements[2]).toMatchObject({
      text: 'PMs',
      source: 'answer',
      questionIndex: 0,
      question: 'Who is the actor?',
    });
    expect(result.doc.statements[3]).toMatchObject({
      text: 'Adoption up 10%',
      source: 'answer',
      questionIndex: 1,
      question: 'What is the success measure?',
    });
    expect(result.doc.statements[4]).toMatchObject({
      text: 'Deadline is Q3',
      source: 'answer',
      questionIndex: 2,
      question: 'What are the constraints?',
    });
  });

  it('sections derive from dimension answers', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const result = buildIntentDoc(dir, interviewId);
    if (!result.ok) throw new Error('expected ok');

    expect(result.doc.actor).toBe('PMs');
    expect(result.doc.goal).toBe('Adoption up 10%');
    expect(result.doc.constraints).toEqual(['Deadline is Q3']);
  });

  it('doc file is written', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const result = buildIntentDoc(dir, interviewId);
    if (!result.ok) throw new Error('expected ok');

    const docPath = join(dir, WORKSPACE_DIR, INTENT_DIR, `${result.doc.id}.json`);
    expect(result.docPath).toBe(docPath);
    expect(existsSync(docPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(docPath, 'utf8'));
    expect(parsed).toEqual(result.doc);
  });

  it('ids stable across rebuild (AC 1)', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const first = buildIntentDoc(dir, interviewId);
    const second = buildIntentDoc(dir, interviewId);
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(second.doc.id).toBe(first.doc.id);
    expect(second.doc.statements).toEqual(first.doc.statements);
    expect(second.doc.createdAt >= first.doc.createdAt).toBe(true);
  });

  it('round-trip preserves content and ids (AC 2)', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const built = buildIntentDoc(dir, interviewId);
    if (!built.ok) throw new Error('expected ok');

    const originalBytes = readFileSync(built.docPath, 'utf8');

    const loaded = loadIntentDoc(dir, built.doc.id);
    if (!loaded.ok) throw new Error('expected ok');

    const savedPath = saveIntentDoc(dir, loaded.doc);
    const resavedBytes = readFileSync(savedPath, 'utf8');

    expect(loaded.doc.statements).toEqual(built.doc.statements);
    expect(loaded.doc.goal).toBe(built.doc.goal);
    expect(loaded.doc.actor).toBe(built.doc.actor);
    expect(loaded.doc.constraints).toEqual(built.doc.constraints);
    expect(loaded.doc.id).toBe(built.doc.id);
    expect(resavedBytes).toBe(originalBytes);
  });

  it('not pinned interview returns an error', async () => {
    const transcriptResult = intakeTranscript(dir, TEXT, 'test.txt');
    if (!transcriptResult.ok) throw new Error('expected ok');
    const questionsResult = await generateClarifyingQuestions(
      dir,
      transcriptResult.artifact.id,
      fakeCaller(DIMENSION_QUESTIONS),
    );
    if (!questionsResult.ok) throw new Error('expected ok');
    const answerResult = recordAnswerRound(dir, questionsResult.artifact.id, { '0': 'PMs' });
    if (!answerResult.ok) throw new Error('expected ok');
    expect(answerResult.session.status).toBe('in-progress');

    const result = buildIntentDoc(dir, questionsResult.artifact.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('is not pinned');
  });

  it('unknown interviewId returns an error', () => {
    const result = buildIntentDoc(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('interview ffffffffffff not found');
  });

  it('malformed interviewId returns the same not-found shape', () => {
    const result = buildIntentDoc(dir, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('interview nope not found');
  });

  it('corrupt session artifact returns an error', () => {
    const answersDir = join(dir, WORKSPACE_DIR, 'answers');
    mkdirSync(answersDir, { recursive: true });
    writeFileSync(join(answersDir, 'ffffffffffff.json'), '{', 'utf8');

    const result = buildIntentDoc(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('is not a valid interview artifact');
  });

  it('missing transcript returns an error', async () => {
    const { interviewId, transcriptId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    rmSync(join(dir, WORKSPACE_DIR, 'transcripts', `${transcriptId}.json`));

    const result = buildIntentDoc(dir, interviewId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not found');
    expect(result.error).toContain(transcriptId);
  });

  it('malformed transcriptId in the session artifact is rejected, not read as a path', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });

    const sessionPath = join(dir, WORKSPACE_DIR, 'answers', `${interviewId}.json`);
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    session.transcriptId = '../../../../etc/passwd';
    writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');

    const result = buildIntentDoc(dir, interviewId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('transcript ../../../../etc/passwd not found');
  });

  it('pinned with no blocking questions produces only transcript statements', async () => {
    const { interviewId } = await seedPinned(dir, NO_BLOCKING, {}, GAPLESS_TEXT);

    const result = buildIntentDoc(dir, interviewId);
    if (!result.ok) throw new Error('expected ok');

    expect(result.doc.statements.map((s) => s.source)).toEqual(['transcript', 'transcript']);
    expect(result.doc.goal).toBe('');
    expect(result.doc.actor).toBe('');
    expect(result.doc.constraints).toEqual([]);
  });
});

describe('loadIntentDoc', () => {
  it('nonexistent id returns not found', () => {
    const result = loadIntentDoc(dir, 'ffffffffffff');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc ffffffffffff not found');
  });

  it('malformed id returns the same not-found shape', () => {
    const result = loadIntentDoc(dir, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc nope not found');
  });

  it('rejects a doc with duplicate statement ids', () => {
    const intentDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    mkdirSync(intentDir, { recursive: true });
    const badDoc = {
      id: 'aaaaaaaaaaaa',
      interviewId: 'bbbbbbbbbbbb',
      transcriptId: 'cccccccccccc',
      createdAt: new Date(0).toISOString(),
      goal: '',
      actor: '',
      constraints: [],
      statements: [
        { id: 'INT-001', text: 'a', source: 'transcript' },
        { id: 'INT-001', text: 'b', source: 'transcript' },
      ],
    };
    writeFileSync(join(intentDir, 'aaaaaaaaaaaa.json'), JSON.stringify(badDoc, null, 2), 'utf8');

    const result = loadIntentDoc(dir, 'aaaaaaaaaaaa');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc aaaaaaaaaaaa is not a valid intent doc');
  });

  it('rejects a doc with a bad statement id format', () => {
    const intentDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    mkdirSync(intentDir, { recursive: true });
    const badDoc = {
      id: 'aaaaaaaaaaaa',
      interviewId: 'bbbbbbbbbbbb',
      transcriptId: 'cccccccccccc',
      createdAt: new Date(0).toISOString(),
      goal: '',
      actor: '',
      constraints: [],
      statements: [{ id: 'not-an-id', text: 'a', source: 'transcript' }],
    };
    writeFileSync(join(intentDir, 'aaaaaaaaaaaa.json'), JSON.stringify(badDoc, null, 2), 'utf8');

    const result = loadIntentDoc(dir, 'aaaaaaaaaaaa');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc aaaaaaaaaaaa is not a valid intent doc');
  });

  it('rejects corrupt JSON', () => {
    const intentDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, 'aaaaaaaaaaaa.json'), '{', 'utf8');

    const result = loadIntentDoc(dir, 'aaaaaaaaaaaa');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc aaaaaaaaaaaa is not a valid intent doc');
  });

  it('loads a doc built by buildIntentDoc', async () => {
    const { interviewId } = await seedPinned(dir, DIMENSION_QUESTIONS, {
      '0': 'PMs',
      '1': 'Adoption up 10%',
      '2': 'Deadline is Q3',
    });
    const built = buildIntentDoc(dir, interviewId);
    if (!built.ok) throw new Error('expected ok');

    const result = loadIntentDoc(dir, built.doc.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc).toEqual(built.doc);
    expect(result.docPath).toBe(built.docPath);
  });
});
