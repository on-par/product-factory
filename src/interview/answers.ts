/**
 * The interviewer's answer loop — records a PM's answers against a stored
 * clarifying-questions artifact and applies an explicit, deterministic
 * stopping rule (ADR 0001: every loop needs one) so the interview never runs
 * unbounded. Pure state-machine + persistence, no LLM call. Building the
 * intent doc from a pinned session is a later story.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import {
  QUESTIONS_DIR,
  type ClarifyingQuestion,
  type GapType,
  type GapDimension,
} from './questions.js';

/** Name of the directory inside the workspace that holds answer-session artifacts. */
export const ANSWERS_DIR = 'answers';

/** Where the interview loop stands after the stopping rule is applied. */
export type InterviewStatus = 'in-progress' | 'pinned' | 'needs-more';

/** One question tracked by the session, with its answer once recorded. */
export interface SessionQuestion {
  /** Position of the question in the source questions artifact. */
  readonly index: number;
  readonly question: ClarifyingQuestion;
  /** True when the question targets a missing intent dimension — these gate "pinned". */
  readonly blocking: boolean;
  readonly answer?: string;
  /** 1-based round in which the answer was recorded. */
  readonly answeredInRound?: number;
}

/** The interviewer's answer loop state — one session per questions artifact. */
export interface AnswerSession {
  /** Id of the questions artifact this session answers (traceability link). */
  readonly questionsId: string;
  /** Id of the transcript the questions came from (traceability link). */
  readonly transcriptId: string;
  readonly maxRounds: number;
  readonly roundsCompleted: number;
  readonly status: InterviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly questions: readonly SessionQuestion[];
}

export type RecordAnswersResult =
  | { readonly ok: true; readonly session: AnswerSession; readonly sessionPath: string }
  | { readonly ok: false; readonly error: string };

export type LoadAnswerSessionResult =
  | { readonly ok: true; readonly session: AnswerSession; readonly sessionPath: string }
  | { readonly ok: false; readonly error: string };

const questionsArtifactShapeSchema = z
  .object({
    id: z.string(),
    transcriptId: z.string(),
    questions: z
      .array(
        z.object({
          question: z.string(),
          gapType: z.string(),
          dimension: z.string().optional(),
        }),
      )
      .min(1),
  })
  .passthrough();

const sessionQuestionSchema = z.object({
  index: z.number().int().nonnegative(),
  question: z.object({
    question: z.string(),
    gapType: z.string(),
    dimension: z.string().optional(),
  }),
  blocking: z.boolean(),
  answer: z.string().optional(),
  answeredInRound: z.number().int().positive().optional(),
});

const sessionSchema = z.object({
  questionsId: z.string(),
  transcriptId: z.string(),
  maxRounds: z.number().int().positive(),
  roundsCompleted: z.number().int().nonnegative(),
  status: z.enum(['in-progress', 'pinned', 'needs-more']),
  createdAt: z.string(),
  updatedAt: z.string(),
  questions: z.array(sessionQuestionSchema),
});

function toClarifyingQuestion(q: {
  readonly question: string;
  readonly gapType: string;
  readonly dimension?: string | undefined;
}): ClarifyingQuestion {
  return q.dimension === undefined
    ? { question: q.question, gapType: q.gapType as GapType }
    : {
        question: q.question,
        gapType: q.gapType as GapType,
        dimension: q.dimension as GapDimension,
      };
}

/** A question is blocking when it targets a missing intent dimension. */
export function isBlockingQuestion(question: ClarifyingQuestion): boolean {
  return question.dimension !== undefined;
}

/** Blocking questions still unanswered — what "needs-more" reports as open. */
export function openBlockingQuestions(session: AnswerSession): readonly SessionQuestion[] {
  return session.questions.filter((q) => q.blocking && q.answer === undefined);
}

/** The explicit stopping rule (pure): pinned beats budget; budget beats in-progress. */
export function evaluateStoppingRule(
  questions: readonly SessionQuestion[],
  roundsCompleted: number,
  maxRounds: number,
): InterviewStatus {
  const allBlockingAnswered = questions
    .filter((q) => q.blocking)
    .every((q) => q.answer !== undefined);
  if (allBlockingAnswered) {
    return 'pinned';
  }
  if (roundsCompleted >= maxRounds) {
    return 'needs-more';
  }
  return 'in-progress';
}

/**
 * Record one round of answers for a questions artifact and apply the
 * stopping rule.
 *
 * Reads `<targetDir>/.pf/questions/<questionsId>.json`, creates or loads the
 * matching answer session at `<targetDir>/.pf/answers/<questionsId>.json`,
 * records the given answers as one round, and persists the updated session.
 * A session whose status is already terminal (`pinned` or `needs-more`)
 * rejects further rounds — this is what guarantees the round budget is never
 * exceeded.
 */
export function recordAnswerRound(
  targetDir: string,
  questionsId: string,
  answers: Readonly<Record<string, string>>,
  options?: { readonly maxRounds?: number },
): RecordAnswersResult {
  if (!/^[0-9a-f]{12}$/.test(questionsId)) {
    return { ok: false, error: `questions ${questionsId} not found` };
  }

  const questionsPath = join(targetDir, WORKSPACE_DIR, QUESTIONS_DIR, `${questionsId}.json`);

  let rawQuestions: string;
  try {
    rawQuestions = readFileSync(questionsPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `questions ${questionsId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read questions ${questionsId}: ${message}` };
  }

  let parsedQuestions: unknown;
  try {
    parsedQuestions = JSON.parse(rawQuestions);
  } catch {
    return { ok: false, error: `questions ${questionsId} is not a valid questions artifact` };
  }

  const questionsArtifactResult = questionsArtifactShapeSchema.safeParse(parsedQuestions);
  if (!questionsArtifactResult.success) {
    return { ok: false, error: `questions ${questionsId} is not a valid questions artifact` };
  }
  const questionsArtifact = questionsArtifactResult.data;

  const maxRoundsOption = options?.maxRounds;
  if (
    maxRoundsOption !== undefined &&
    (!Number.isInteger(maxRoundsOption) || maxRoundsOption <= 0)
  ) {
    return { ok: false, error: 'maxRounds must be a positive integer' };
  }
  const maxRounds = maxRoundsOption ?? 3;

  const answersDir = join(targetDir, WORKSPACE_DIR, ANSWERS_DIR);
  const sessionPath = join(answersDir, `${questionsId}.json`);

  let session: AnswerSession;
  if (existsSync(sessionPath)) {
    let parsedSession: unknown;
    try {
      parsedSession = JSON.parse(readFileSync(sessionPath, 'utf8'));
    } catch {
      return { ok: false, error: `answer session for ${questionsId} is corrupt` };
    }
    const sessionResult = sessionSchema.safeParse(parsedSession);
    if (!sessionResult.success) {
      return { ok: false, error: `answer session for ${questionsId} is corrupt` };
    }
    session = sessionResult.data as AnswerSession;
    if (session.status !== 'in-progress') {
      return { ok: false, error: `interview already ended with status "${session.status}"` };
    }
  } else {
    const now = new Date().toISOString();
    session = {
      questionsId,
      transcriptId: questionsArtifact.transcriptId,
      maxRounds,
      roundsCompleted: 0,
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      questions: questionsArtifact.questions.map((q, index) => ({
        index,
        question: toClarifyingQuestion(q),
        blocking: q.dimension !== undefined,
      })),
    };
  }

  const validatedAnswers: Array<{ readonly index: number; readonly value: string }> = [];
  for (const [key, value] of Object.entries(answers)) {
    if (!/^\d+$/.test(key)) {
      return { ok: false, error: `no question at index ${key}` };
    }
    const index = Number.parseInt(key, 10);
    if (index >= session.questions.length) {
      return { ok: false, error: `no question at index ${key}` };
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, error: `answer for question ${key} is empty` };
    }
    validatedAnswers.push({ index, value });
  }

  const newRound = session.roundsCompleted + 1;
  const updatedQuestions = session.questions.map((q) => {
    const found = validatedAnswers.find((a) => a.index === q.index);
    if (found === undefined) {
      return q;
    }
    return { ...q, answer: found.value, answeredInRound: newRound };
  });
  const status = evaluateStoppingRule(updatedQuestions, newRound, session.maxRounds);
  const updatedSession: AnswerSession = {
    ...session,
    roundsCompleted: newRound,
    status,
    updatedAt: new Date().toISOString(),
    questions: updatedQuestions,
  };

  mkdirSync(answersDir, { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify(updatedSession, null, 2)}\n`, 'utf8');

  return { ok: true, session: updatedSession, sessionPath };
}

/** Load a persisted answer session from `<targetDir>/.pf/answers/<interviewId>.json`. */
export function loadAnswerSession(targetDir: string, interviewId: string): LoadAnswerSessionResult {
  if (!/^[0-9a-f]{12}$/.test(interviewId)) {
    return { ok: false, error: `interview ${interviewId} not found` };
  }

  const sessionPath = join(targetDir, WORKSPACE_DIR, ANSWERS_DIR, `${interviewId}.json`);
  let raw: string;
  try {
    raw = readFileSync(sessionPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `interview ${interviewId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read interview ${interviewId}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `interview ${interviewId} is not a valid interview artifact` };
  }

  const result = sessionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `interview ${interviewId} is not a valid interview artifact` };
  }

  return { ok: true, session: result.data as AnswerSession, sessionPath };
}
