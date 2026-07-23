import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateClarifyingQuestions,
  analyzeGaps,
  buildPrompt,
  QUESTIONS_DIR,
  type QuestionModelCaller,
} from './questions.js';
import { intakeTranscript } from '../intake/intake.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const RICH_TEXT =
  'As a PM user I want exports. Success metric: adoption up 10%. Constraint: deadline is Q3, budget capped.\n';
const THIN_TEXT = 'Build a widget that syncs things.\n';
const PARTIAL_TEXT = 'The admin user needs a faster dashboard.\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-interview-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedTranscript(targetDir: string, text: string): string {
  const result = intakeTranscript(targetDir, text, 'test.txt');
  if (!result.ok) throw new Error('expected ok');
  return result.artifact.id;
}

function fakeCaller(payload: unknown): QuestionModelCaller {
  return async () => JSON.stringify(payload);
}

describe('analyzeGaps', () => {
  it('thin transcript returns all missing dimensions in order', () => {
    expect(analyzeGaps(THIN_TEXT)).toEqual(['actor', 'success-measure', 'constraints']);
  });

  it('rich transcript returns no missing dimensions', () => {
    expect(analyzeGaps(RICH_TEXT)).toEqual([]);
  });

  it('partial transcript reports success-measure and constraints, not actor', () => {
    const missing = analyzeGaps(PARTIAL_TEXT);
    expect(missing).toContain('success-measure');
    expect(missing).toContain('constraints');
    expect(missing).not.toContain('actor');
  });
});

describe('generateClarifyingQuestions', () => {
  it('happy path: generates and persists a questions artifact linked to the transcript', async () => {
    const transcriptId = seedTranscript(dir, RICH_TEXT);
    const caller = fakeCaller([
      { question: 'What happens on export failure?', gapType: 'unclear' },
      { question: 'Does this depend on the billing service?', gapType: 'dependency' },
    ]);

    const result = await generateClarifyingQuestions(dir, transcriptId, caller);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.artifactPath).toBe(
      join(dir, WORKSPACE_DIR, QUESTIONS_DIR, `${result.artifact.id}.json`),
    );
    expect(existsSync(result.artifactPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(result.artifactPath, 'utf8'));
    expect(parsed).toEqual(result.artifact);

    expect(result.artifact.transcriptId).toBe(transcriptId);
    for (const question of result.artifact.questions) {
      expect(['unclear', 'assumption', 'dependency', 'persona-concern']).toContain(
        question.gapType,
      );
    }
    expect(result.artifact.id).toMatch(/^[0-9a-f]{12}$/);
    expect(new Date(result.artifact.createdAt).toISOString()).toBe(result.artifact.createdAt);
  });

  it('thin brain-dump: fallback questions cover all missing dimensions', async () => {
    const transcriptId = seedTranscript(dir, THIN_TEXT);
    const caller = fakeCaller([{ question: 'What is the widget for?', gapType: 'unclear' }]);

    const result = await generateClarifyingQuestions(dir, transcriptId, caller);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    for (const dimension of ['actor', 'success-measure', 'constraints'] as const) {
      expect(result.artifact.questions.some((q) => q.dimension === dimension)).toBe(true);
    }
    expect(result.artifact.questions.length).toBeGreaterThanOrEqual(4);
  });

  it('model-covered dimensions are not duplicated with fallbacks', async () => {
    const transcriptId = seedTranscript(dir, THIN_TEXT);
    const caller = fakeCaller([
      { question: 'Who uses this?', gapType: 'unclear', dimension: 'actor' },
      { question: 'What metric moves?', gapType: 'unclear', dimension: 'success-measure' },
      { question: 'Any deadline?', gapType: 'assumption', dimension: 'constraints' },
    ]);

    const result = await generateClarifyingQuestions(dir, transcriptId, caller);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.questions.length).toBe(3);
  });

  it('tolerates fenced/prose model output', async () => {
    const transcriptId = seedTranscript(dir, RICH_TEXT);
    const caller: QuestionModelCaller = async () =>
      'Here you go:\n```json\n[{"question":"Who?","gapType":"unclear"}]\n```';

    const result = await generateClarifyingQuestions(dir, transcriptId, caller);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.questions.length).toBe(1);
  });

  it('rejects invalid model payloads without writing a questions artifact', async () => {
    const transcriptId = seedTranscript(dir, RICH_TEXT);
    const invalidPayloads: QuestionModelCaller[] = [
      async () => 'not json',
      async () => '[]',
      async () => JSON.stringify([{ question: 'x', gapType: 'bogus' }]),
    ];

    for (const caller of invalidPayloads) {
      const result = await generateClarifyingQuestions(dir, transcriptId, caller);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected not ok');
      expect(result.error.length).toBeGreaterThan(0);
    }

    const questionsDir = join(dir, WORKSPACE_DIR, QUESTIONS_DIR);
    expect(existsSync(questionsDir)).toBe(false);
  });

  it('missing transcript returns an error naming the id', async () => {
    const result = await generateClarifyingQuestions(dir, 'deadbeefcafe', fakeCaller([]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('deadbeefcafe');
  });

  it('corrupt transcript artifact returns an error', async () => {
    const transcriptsDir = join(dir, WORKSPACE_DIR, 'transcripts');
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, 'abc.json'), 'not valid json{', 'utf8');

    const result = await generateClarifyingQuestions(dir, 'abc', fakeCaller([]));
    expect(result.ok).toBe(false);
  });

  it('throwing caller returns an error containing the thrown message', async () => {
    const transcriptId = seedTranscript(dir, RICH_TEXT);
    const caller: QuestionModelCaller = async () => {
      throw new Error('boom');
    };

    const result = await generateClarifyingQuestions(dir, transcriptId, caller);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('boom');
  });

  it('buildPrompt embeds the transcript, gap types, and missing dimensions', () => {
    const prompt = buildPrompt(THIN_TEXT, ['actor']);
    expect(prompt).toContain(THIN_TEXT);
    expect(prompt).toContain('unclear');
    expect(prompt).toContain('assumption');
    expect(prompt).toContain('dependency');
    expect(prompt).toContain('persona-concern');
    expect(prompt).toContain('actor');
  });
});
