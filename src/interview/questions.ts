/**
 * Clarifying-question generation — the interviewer's first stage. One LLM
 * call over a stored transcript artifact produces a structured list of
 * gap-tagged clarifying questions, persisted as a new artifact linked back to
 * the transcript by id. Interactive answering and the stopping rule are
 * later stories; this stage is output only.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { TRANSCRIPTS_DIR } from '../intake/intake.js';

/** Name of the directory inside the workspace that holds clarifying-question artifacts. */
export const QUESTIONS_DIR = 'questions';

const GAP_TYPES = ['unclear', 'assumption', 'dependency', 'persona-concern'] as const;

/** The kind of gap a clarifying question targets. */
export type GapType = (typeof GAP_TYPES)[number];

/** Intent dimensions the gap analysis checks the transcript for. */
export type GapDimension = 'actor' | 'success-measure' | 'constraints';

/** A single clarifying question aimed at a gap in the transcript. */
export interface ClarifyingQuestion {
  readonly question: string;
  /** The kind of gap this question targets. */
  readonly gapType: GapType;
  /** The missing intent dimension this question targets, when it targets one. */
  readonly dimension?: GapDimension;
}

/** Clarifying questions for one transcript — the interviewer's first artifact. */
export interface QuestionsArtifact {
  /** Content-derived id: first 12 hex chars of the sha256 of transcriptId + questions JSON. */
  readonly id: string;
  /** Id of the transcript these questions were generated from (traceability link). */
  readonly transcriptId: string;
  /** ISO 8601 timestamp of when the artifact was created. */
  readonly createdAt: string;
  readonly questions: readonly ClarifyingQuestion[];
}

/**
 * The single LLM call seam: given the interviewer prompt, return the raw
 * model completion text. Injected so the engine stays UI-less and testable.
 */
export type QuestionModelCaller = (prompt: string) => Promise<string>;

export type GenerateQuestionsResult =
  | {
      readonly ok: true;
      readonly artifact: QuestionsArtifact;
      /** Absolute path of the artifact JSON file that was written. */
      readonly artifactPath: string;
    }
  | { readonly ok: false; readonly error: string };

const questionSchema = z.object({
  question: z.string().min(1),
  gapType: z.enum(GAP_TYPES),
  dimension: z.enum(['actor', 'success-measure', 'constraints']).optional(),
});
const questionsResponseSchema = z.array(questionSchema).min(1);

const transcriptShapeSchema = z.object({ id: z.string(), text: z.string() }).passthrough();

const DIMENSION_PATTERNS: Record<GapDimension, RegExp> = {
  actor:
    /\b(as an?|user|customer|admin|operator|developer|engineer|pm|persona|stakeholder|team)\b/i,
  'success-measure':
    /\b(success|metric|measure|kpi|goal|outcome|conversion|adoption|revenue|retention|target)\b/i,
  constraints:
    /\b(constraint|deadline|budget|compliance|deprecat|must not|cannot|can't|only if|limit|by q[1-4]|within)\b/i,
};

const DIMENSION_ORDER: readonly GapDimension[] = ['actor', 'success-measure', 'constraints'];

const FALLBACK_QUESTIONS: Record<GapDimension, ClarifyingQuestion> = {
  actor: {
    question: 'Who is the primary user or actor this is for?',
    gapType: 'unclear',
    dimension: 'actor',
  },
  'success-measure': {
    question: 'How will you know this succeeded — what outcome or metric should move?',
    gapType: 'unclear',
    dimension: 'success-measure',
  },
  constraints: {
    question:
      'Are there constraints (deadline, budget, compliance, technical limits) being assumed but not stated?',
    gapType: 'assumption',
    dimension: 'constraints',
  },
};

/** Deterministic keyword heuristic: which intent dimensions the transcript text appears to be missing. */
export function analyzeGaps(text: string): GapDimension[] {
  return DIMENSION_ORDER.filter((dimension) => !DIMENSION_PATTERNS[dimension].test(text));
}

/** Build the interviewer prompt instructing the model to return gap-tagged clarifying questions as JSON. */
export function buildPrompt(text: string, missing: readonly GapDimension[]): string {
  const lines = [
    'You are the interviewer stage of a product refinement pipeline.',
    'Read the brain-dump transcript below and produce clarifying questions that surface gaps and ambiguities before decomposition.',
    '',
    'Return ONLY a JSON array (no prose, no code fences) of objects of the form:',
    '{"question": string, "gapType": "unclear" | "assumption" | "dependency" | "persona-concern", "dimension"?: "actor" | "success-measure" | "constraints"}',
    '',
    'gapType meanings:',
    '- unclear: the transcript states something ambiguously and needs disambiguation.',
    '- assumption: the transcript implies something without stating it explicitly.',
    '- dependency: the work seems to depend on another system, team, or decision not mentioned.',
    '- persona-concern: a stakeholder or user persona may object to or be affected by this.',
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `The transcript appears to be missing these intent dimensions: ${missing.join(', ')}.`,
      'Include at least one question per missing dimension above, with its "dimension" field set to that dimension.',
    );
  }

  lines.push('', 'Transcript:', text);

  return lines.join('\n');
}

function stripFences(trimmed: string): string {
  if (trimmed.startsWith('```')) {
    const withoutOpenFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpenFence.replace(/```$/, '').trim();
  }
  return trimmed;
}

function parseQuestions(raw: string): ClarifyingQuestion[] | undefined {
  let candidate = stripFences(raw.trim());

  if (!candidate.startsWith('[')) {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) {
      return undefined;
    }
    candidate = candidate.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }

  const result = questionsResponseSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return result.data.map((q) =>
    q.dimension === undefined
      ? { question: q.question, gapType: q.gapType }
      : { question: q.question, gapType: q.gapType, dimension: q.dimension },
  );
}

function ensureCoverage(
  questions: ClarifyingQuestion[],
  missing: readonly GapDimension[],
): ClarifyingQuestion[] {
  const covered = new Set(
    questions.map((q) => q.dimension).filter((d): d is GapDimension => d !== undefined),
  );
  const fallbacks = missing.filter((d) => !covered.has(d)).map((d) => FALLBACK_QUESTIONS[d]);
  return [...questions, ...fallbacks];
}

/**
 * Generate gap-tagged clarifying questions for a stored transcript artifact.
 *
 * Reads `<targetDir>/.pf/transcripts/<transcriptId>.json`, runs the
 * deterministic gap analysis, makes one LLM call via `callModel`, then
 * guarantees at least one question per missing intent dimension before
 * persisting the result under `<targetDir>/.pf/questions/`.
 */
export async function generateClarifyingQuestions(
  targetDir: string,
  transcriptId: string,
  callModel: QuestionModelCaller,
): Promise<GenerateQuestionsResult> {
  if (!/^[0-9a-f]{12}$/.test(transcriptId)) {
    return { ok: false, error: `transcript ${transcriptId} not found` };
  }

  const transcriptsDir = join(targetDir, WORKSPACE_DIR, TRANSCRIPTS_DIR);
  const transcriptPath = join(transcriptsDir, `${transcriptId}.json`);

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `transcript ${transcriptId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read transcript ${transcriptId}: ${message}` };
  }

  let parsedTranscript: unknown;
  try {
    parsedTranscript = JSON.parse(raw);
  } catch {
    return { ok: false, error: `transcript ${transcriptId} is not a valid transcript artifact` };
  }

  const transcriptResult = transcriptShapeSchema.safeParse(parsedTranscript);
  if (!transcriptResult.success) {
    return { ok: false, error: `transcript ${transcriptId} is not a valid transcript artifact` };
  }
  const transcript = transcriptResult.data;

  const missing = analyzeGaps(transcript.text);

  let modelRaw: string;
  try {
    modelRaw = await callModel(buildPrompt(transcript.text, missing));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `model call failed: ${message}` };
  }

  const parsed = parseQuestions(modelRaw);
  if (parsed === undefined) {
    return { ok: false, error: 'model returned an invalid questions payload' };
  }

  const questions = ensureCoverage(parsed, missing);

  const id = createHash('sha256')
    .update(`${transcriptId}\n${JSON.stringify(questions)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const createdAt = new Date().toISOString();
  const artifact: QuestionsArtifact = { id, transcriptId, createdAt, questions };

  const questionsDir = join(targetDir, WORKSPACE_DIR, QUESTIONS_DIR);
  mkdirSync(questionsDir, { recursive: true });
  const artifactPath = join(questionsDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  return { ok: true, artifact, artifactPath };
}
