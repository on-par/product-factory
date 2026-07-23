/**
 * Intent-doc build stage — turns a pinned interview into the canonical
 * intent doc with stable statement ids; approval gate and decomposition are
 * later stories.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { ANSWERS_DIR } from '../interview/answers.js';
import { TRANSCRIPTS_DIR } from '../intake/intake.js';

/** Name of the directory inside the workspace that holds intent-doc artifacts. */
export const INTENT_DIR = 'intent';

/** Where a statement came from: a transcript line, or a recorded interview answer. */
export type IntentStatementSource = 'transcript' | 'answer';

/** One statement of intent with its stable, citable id. */
export interface IntentStatement {
  /** Stable id, e.g. "INT-001" — later stages cite this. Never renumbered once assigned. */
  readonly id: string;
  readonly text: string;
  readonly source: IntentStatementSource;
  /** Index of the source question in the interview session (source === 'answer' only). */
  readonly questionIndex?: number;
  /** The clarifying question the answer responded to (source === 'answer' only). */
  readonly question?: string;
}

/** The canonical intent doc — the source of truth later stages grade against. */
export interface IntentDoc {
  /** Content-derived id: first 12 hex chars of sha256 of interviewId + doc content (excludes createdAt). */
  readonly id: string;
  /** Id of the pinned answer session this doc was built from (traceability link). */
  readonly interviewId: string;
  /** Id of the transcript at the root of the lineage (traceability link). */
  readonly transcriptId: string;
  readonly createdAt: string;
  /** Derived from answers to success-measure questions; '' when none. */
  readonly goal: string;
  /** Derived from answers to actor questions; '' when none. */
  readonly actor: string;
  /** Derived from answers to constraints questions; empty when none. */
  readonly constraints: readonly string[];
  readonly statements: readonly IntentStatement[];
}

export type BuildIntentResult =
  | { readonly ok: true; readonly doc: IntentDoc; readonly docPath: string }
  | { readonly ok: false; readonly error: string };

export type LoadIntentResult =
  | { readonly ok: true; readonly doc: IntentDoc; readonly docPath: string }
  | { readonly ok: false; readonly error: string };

const sessionShapeSchema = z
  .object({
    questionsId: z.string(),
    transcriptId: z.string(),
    status: z.enum(['in-progress', 'pinned', 'needs-more']),
    questions: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        question: z.object({
          question: z.string(),
          gapType: z.string(),
          dimension: z.string().optional(),
        }),
        blocking: z.boolean(),
        answer: z.string().optional(),
        answeredInRound: z.number().int().positive().optional(),
      }),
    ),
  })
  .passthrough();

const transcriptShapeSchema = z.object({ id: z.string(), text: z.string() }).passthrough();

const statementSchema = z.object({
  id: z.string().regex(/^INT-\d{3,}$/),
  text: z.string().min(1),
  source: z.enum(['transcript', 'answer']),
  questionIndex: z.number().int().nonnegative().optional(),
  question: z.string().optional(),
});

const intentDocSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    interviewId: z.string(),
    transcriptId: z.string(),
    createdAt: z.string(),
    goal: z.string(),
    actor: z.string(),
    constraints: z.array(z.string()),
    statements: z.array(statementSchema).min(1),
  })
  .refine((doc) => new Set(doc.statements.map((s) => s.id)).size === doc.statements.length, {
    message: 'statement ids must be unique',
  });

function toStatement(
  id: string,
  text: string,
  source: IntentStatementSource,
  questionIndex?: number,
  question?: string,
): IntentStatement {
  return {
    id,
    text,
    source,
    ...(questionIndex === undefined ? {} : { questionIndex }),
    ...(question === undefined ? {} : { question }),
  };
}

/**
 * Build the canonical intent doc from a pinned interview session.
 *
 * Reads `<targetDir>/.pf/answers/<interviewId>.json` (must have
 * `status: "pinned"`) and the transcript it traces back to, then produces
 * one intent statement per transcript line followed by one per answered
 * question, each with a stable `INT-nnn` id. The doc id is derived from
 * content only (excludes `createdAt`), so rebuilding from the same pinned
 * session always yields the same doc id and the same statement ids.
 */
export function buildIntentDoc(targetDir: string, interviewId: string): BuildIntentResult {
  if (!/^[0-9a-f]{12}$/.test(interviewId)) {
    return { ok: false, error: `interview ${interviewId} not found` };
  }

  const sessionPath = join(targetDir, WORKSPACE_DIR, ANSWERS_DIR, `${interviewId}.json`);
  let rawSession: string;
  try {
    rawSession = readFileSync(sessionPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `interview ${interviewId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read interview ${interviewId}: ${message}` };
  }

  let parsedSession: unknown;
  try {
    parsedSession = JSON.parse(rawSession);
  } catch {
    return { ok: false, error: `interview ${interviewId} is not a valid interview artifact` };
  }

  const sessionResult = sessionShapeSchema.safeParse(parsedSession);
  if (!sessionResult.success) {
    return { ok: false, error: `interview ${interviewId} is not a valid interview artifact` };
  }
  const session = sessionResult.data;

  if (session.status !== 'pinned') {
    return {
      ok: false,
      error: `interview ${interviewId} is not pinned (status: "${session.status}")`,
    };
  }

  if (!/^[0-9a-f]{12}$/.test(session.transcriptId)) {
    return { ok: false, error: `transcript ${session.transcriptId} not found` };
  }

  const transcriptPath = join(
    targetDir,
    WORKSPACE_DIR,
    TRANSCRIPTS_DIR,
    `${session.transcriptId}.json`,
  );
  let rawTranscript: string;
  try {
    rawTranscript = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `transcript ${session.transcriptId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read transcript ${session.transcriptId}: ${message}` };
  }

  let parsedTranscript: unknown;
  try {
    parsedTranscript = JSON.parse(rawTranscript);
  } catch {
    return {
      ok: false,
      error: `transcript ${session.transcriptId} is not a valid transcript artifact`,
    };
  }

  const transcriptResult = transcriptShapeSchema.safeParse(parsedTranscript);
  if (!transcriptResult.success) {
    return {
      ok: false,
      error: `transcript ${session.transcriptId} is not a valid transcript artifact`,
    };
  }
  const transcript = transcriptResult.data;

  const transcriptLines = transcript.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const answeredQuestions = session.questions
    .filter((q) => q.answer !== undefined)
    .slice()
    .sort((a, b) => a.index - b.index);

  const statements: IntentStatement[] = [
    ...transcriptLines.map((line, position) =>
      toStatement(`INT-${String(position + 1).padStart(3, '0')}`, line, 'transcript'),
    ),
    ...answeredQuestions.map((q, offset) =>
      toStatement(
        `INT-${String(transcriptLines.length + offset + 1).padStart(3, '0')}`,
        q.answer as string,
        'answer',
        q.index,
        q.question.question,
      ),
    ),
  ];

  const actor = answeredQuestions
    .filter((q) => q.question.dimension === 'actor')
    .map((q) => q.answer as string)
    .join('\n');
  const goal = answeredQuestions
    .filter((q) => q.question.dimension === 'success-measure')
    .map((q) => q.answer as string)
    .join('\n');
  const constraints = answeredQuestions
    .filter((q) => q.question.dimension === 'constraints')
    .map((q) => q.answer as string);

  const id = createHash('sha256')
    .update(`${interviewId}\n${JSON.stringify({ goal, actor, constraints, statements })}`, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const doc: IntentDoc = {
    id,
    interviewId,
    transcriptId: session.transcriptId,
    createdAt: new Date().toISOString(),
    goal,
    actor,
    constraints,
    statements,
  };

  const docPath = saveIntentDoc(targetDir, doc);
  return { ok: true, doc, docPath };
}

/** Load a previously built intent doc from `<targetDir>/.pf/intent/<intentId>.json`. */
export function loadIntentDoc(targetDir: string, intentId: string): LoadIntentResult {
  if (!/^[0-9a-f]{12}$/.test(intentId)) {
    return { ok: false, error: `intent doc ${intentId} not found` };
  }

  const docPath = join(targetDir, WORKSPACE_DIR, INTENT_DIR, `${intentId}.json`);
  let raw: string;
  try {
    raw = readFileSync(docPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `intent doc ${intentId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read intent doc ${intentId}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `intent doc ${intentId} is not a valid intent doc` };
  }

  const result = intentDocSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `intent doc ${intentId} is not a valid intent doc` };
  }

  return { ok: true, doc: result.data as IntentDoc, docPath };
}

/**
 * Persist an intent doc verbatim — no re-derivation, no renumbering — which
 * is exactly what makes load then save preserve every id and text.
 */
export function saveIntentDoc(targetDir: string, doc: IntentDoc): string {
  const intentDir = join(targetDir, WORKSPACE_DIR, INTENT_DIR);
  mkdirSync(intentDir, { recursive: true });
  const docPath = join(intentDir, `${doc.id}.json`);
  writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return docPath;
}
