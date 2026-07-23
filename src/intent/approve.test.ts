import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveIntentDoc, loadIntentApproval, isIntentApproved } from './approve.js';
import { buildIntentDoc, INTENT_DIR } from './build.js';
import { intakeTranscript } from '../intake/intake.js';
import { generateClarifyingQuestions, type QuestionModelCaller } from '../interview/questions.js';
import { recordAnswerRound } from '../interview/answers.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const TEXT = 'Line one of intent.\nLine two of intent.\n';

const DIMENSION_QUESTIONS = [
  { question: 'Who is the actor?', gapType: 'unclear', dimension: 'actor' },
  { question: 'What is the success measure?', gapType: 'unclear', dimension: 'success-measure' },
  { question: 'What are the constraints?', gapType: 'unclear', dimension: 'constraints' },
  { question: 'Nice-to-have: dark mode?', gapType: 'assumption' },
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-intent-approve-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeCaller(payload: unknown): QuestionModelCaller {
  return async () => JSON.stringify(payload);
}

async function seedDoc(targetDir: string, text: string = TEXT): Promise<string> {
  const transcriptResult = intakeTranscript(targetDir, text, 'test.txt');
  if (!transcriptResult.ok) throw new Error('expected ok');
  const questionsResult = await generateClarifyingQuestions(
    targetDir,
    transcriptResult.artifact.id,
    fakeCaller(DIMENSION_QUESTIONS),
  );
  if (!questionsResult.ok) throw new Error('expected ok');
  const answerResult = recordAnswerRound(targetDir, questionsResult.artifact.id, {
    '0': 'PMs',
    '1': 'Adoption up 10%',
    '2': 'Deadline is Q3',
  });
  if (!answerResult.ok) throw new Error('expected ok');
  if (answerResult.session.status !== 'pinned') {
    throw new Error(`expected pinned, got ${answerResult.session.status}`);
  }
  const built = buildIntentDoc(targetDir, questionsResult.artifact.id);
  if (!built.ok) throw new Error('expected ok');
  return built.doc.id;
}

describe('approveIntentDoc', () => {
  it('approves an existing doc', async () => {
    const docId = await seedDoc(dir);

    const result = approveIntentDoc(dir, docId, 'patrick');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.alreadyApproved).toBe(false);
    expect(result.approval.intentId).toBe(docId);
    expect(result.approval.approvedBy).toBe('patrick');
    expect(result.approval.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const approvalPath = join(dir, WORKSPACE_DIR, INTENT_DIR, `${docId}.approval.json`);
    expect(result.approvalPath).toBe(approvalPath);
    expect(existsSync(approvalPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(approvalPath, 'utf8'));
    expect(parsed).toEqual(result.approval);
  });

  it('is idempotent and preserves the first approver', async () => {
    const docId = await seedDoc(dir);

    const first = approveIntentDoc(dir, docId, 'patrick');
    if (!first.ok) throw new Error('expected ok');

    const second = approveIntentDoc(dir, docId, 'someone-else');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    expect(second.alreadyApproved).toBe(true);
    expect(second.approval.approvedBy).toBe('patrick');
    expect(second.approval.approvedAt).toBe(first.approval.approvedAt);
  });

  it('fails for a missing doc', () => {
    const result = approveIntentDoc(dir, '0123456789ab', 'patrick');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('intent doc 0123456789ab not found');
  });

  it('fails for a malformed id', () => {
    const result = approveIntentDoc(dir, 'not-a-doc-id', 'patrick');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not found');

    const approvalDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    expect(existsSync(approvalDir)).toBe(false);
  });

  it('rejects an empty approver', async () => {
    const docId = await seedDoc(dir);

    const result = approveIntentDoc(dir, docId, '   ');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('approver must not be empty');
  });
});

describe('loadIntentApproval', () => {
  it('unapproved doc returns not approved', async () => {
    const docId = await seedDoc(dir);

    const result = loadIntentApproval(dir, docId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`intent doc ${docId} is not approved`);
    expect(isIntentApproved(dir, docId)).toBe(false);
  });

  it('after approval round-trips the approval', async () => {
    const docId = await seedDoc(dir);
    const approved = approveIntentDoc(dir, docId, 'patrick');
    if (!approved.ok) throw new Error('expected ok');

    const result = loadIntentApproval(dir, docId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.approval).toEqual(approved.approval);
    expect(result.approvalPath).toBe(approved.approvalPath);
    expect(isIntentApproved(dir, docId)).toBe(true);
  });

  it('rejects a corrupt marker', async () => {
    const docId = await seedDoc(dir);
    const intentDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, `${docId}.approval.json`), 'not json', 'utf8');

    const result = loadIntentApproval(dir, docId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`approval for intent doc ${docId} is not a valid approval marker`);
  });

  it('rejects a marker whose intentId does not match the filename', async () => {
    const docId = await seedDoc(dir);
    const otherDocId = await seedDoc(dir, 'A different line of intent.\nAnother line here.\n');
    const intentDir = join(dir, WORKSPACE_DIR, INTENT_DIR);
    mkdirSync(intentDir, { recursive: true });
    const mismatched = {
      intentId: otherDocId,
      approvedBy: 'patrick',
      approvedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(intentDir, `${docId}.approval.json`),
      JSON.stringify(mismatched, null, 2),
      'utf8',
    );

    const result = loadIntentApproval(dir, docId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`approval for intent doc ${docId} is not a valid approval marker`);
  });
});
