/**
 * Judge stage — single pass combining the deterministic readiness rubric with
 * an LLM intent-alignment grade per story; the generator/critic rework loop
 * is a later story.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import {
  loadCriteria,
  renderScenario,
  validateScenarioCoverage,
  type CriteriaSet,
} from '../criteria/criteria.js';
import { loadDecomposition, storySentence, type DecomposedStory } from '../decompose/decompose.js';
import { loadIntentDoc, type IntentDoc } from '../intent/build.js';
import { scoreReadiness } from '../readiness/score.js';

/** Name of the directory inside the workspace that holds judge verdict artifacts. */
export const VERDICTS_DIR = 'verdicts';

/** One story's judge verdict: deterministic readiness + LLM intent alignment, with reasons. */
export interface StoryVerdict {
  readonly storyIndex: number;
  readonly storyTitle: string;
  readonly tracesTo: readonly string[];
  /** 0..1 fraction of readiness rubric checks passed (deterministic). */
  readonly readinessScore: number;
  /** Descriptions of the failed rubric checks; empty when fully ready. */
  readonly readinessReasons: readonly string[];
  /** 0..1 LLM-graded faithfulness to the intent statements the story traces to. */
  readonly intentAlignmentScore: number;
  /** Concrete reasons for any alignment deduction; empty only when the score is 1. */
  readonly intentAlignmentReasons: readonly string[];
}

/** A persisted single-pass verdict set covering every story in a criteria set. */
export interface VerdictSet {
  /** Content-derived id: first 12 hex chars of sha256 of criteriaId + stories JSON (excludes createdAt). */
  readonly id: string;
  readonly criteriaId: string;
  readonly decompositionId: string;
  readonly intentId: string;
  readonly createdAt: string; // ISO 8601
  readonly stories: readonly StoryVerdict[];
}

/** The single LLM call seam; injected so the engine stays UI-less and testable. */
export type JudgeModelCaller = (prompt: string) => Promise<string>;

export type JudgeResult =
  | { readonly ok: true; readonly verdicts: VerdictSet; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

export type LoadVerdictsResult =
  | { readonly ok: true; readonly verdicts: VerdictSet; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

const judgeResponseSchema = z.object({
  stories: z
    .array(
      z.object({
        storyIndex: z.number().int().min(0),
        intentAlignmentScore: z.number().min(0).max(1),
        reasons: z.array(z.string().min(1)),
      }),
    )
    .min(1),
});

const persistedVerdictsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  criteriaId: z.string().min(1),
  decompositionId: z.string().min(1),
  intentId: z.string().min(1),
  createdAt: z.string().min(1),
  stories: z
    .array(
      z.object({
        storyIndex: z.number().int().min(0),
        storyTitle: z.string().min(1),
        tracesTo: z.array(z.string().min(1)).min(1),
        readinessScore: z.number().min(0).max(1),
        readinessReasons: z.array(z.string()),
        intentAlignmentScore: z.number().min(0).max(1),
        intentAlignmentReasons: z.array(z.string()),
      }),
    )
    .min(1),
});

/** Build the judge prompt instructing the model to grade intent-alignment per story as JSON. */
export function buildJudgePrompt(
  doc: IntentDoc,
  stories: readonly DecomposedStory[],
  criteria: CriteriaSet,
): string {
  const lines = [
    'You are the judge stage of a product refinement pipeline.',
    'For EACH story below, grade how faithfully the story (its As a / I want / so that plus its Gherkin scenarios) delivers the intent statements it traces to.',
    '',
    'Return ONLY a JSON object (no prose, no code fences) of the form:',
    '{"stories": [{"storyIndex": number, "intentAlignmentScore": number, "reasons": [string]}]}',
    '',
    'Rules:',
    '- exactly one entry per story, storyIndex copied from the list below.',
    '- intentAlignmentScore is between 0 and 1; 1 means the story faithfully delivers every traced intent statement.',
    "- if a story's capability contradicts or drifts from a traced intent statement, score it LOW and include a reason that names the contradicted statement id and the contradiction.",
    '- every score below 1 must include at least one concrete reason; a score of 1 must have an empty reasons array.',
    '',
    'Intent statements:',
    ...doc.statements.map((statement) => `[${statement.id}] ${statement.text}`),
    '',
    'Stories:',
  ];

  for (const storyCriteria of criteria.stories) {
    const story = stories[storyCriteria.storyIndex];
    lines.push(
      `[${storyCriteria.storyIndex}] ${storyCriteria.storyTitle} — ${storySentence(story)} (traces-to: ${storyCriteria.tracesTo.join(', ')})`,
    );
    for (const scenario of storyCriteria.scenarios) {
      lines.push(renderScenario(scenario));
    }
  }

  return lines.join('\n');
}

/** Pure check that every alignment deduction carries a reason; a perfect score may have none. */
export function validateAlignmentReasons(
  entries: readonly {
    storyIndex: number;
    intentAlignmentScore: number;
    reasons: readonly string[];
  }[],
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.intentAlignmentScore < 1 && entry.reasons.length === 0) {
      problems.push(`story index ${entry.storyIndex} has an alignment deduction but no reasons`);
    }
  }
  return problems;
}

function stripFences(trimmed: string): string {
  if (trimmed.startsWith('```')) {
    const withoutOpenFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpenFence.replace(/```$/, '').trim();
  }
  return trimmed;
}

function parseJudgeVerdicts(
  raw: string,
):
  | { stories: { storyIndex: number; intentAlignmentScore: number; reasons: string[] }[] }
  | undefined {
  let candidate = stripFences(raw.trim());

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
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

  const result = judgeResponseSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

/**
 * Judge every story in a persisted criteria set: a deterministic readiness
 * score from the rubric plus an LLM-graded intent-alignment score, each with
 * concrete reasons for any deduction.
 *
 * Reads `<targetDir>/.pf/criteria/<criteriaId>.json`, follows the lineage to
 * the decomposition and intent doc, makes one LLM call via `callModel`,
 * rejects any response that doesn't cover every story exactly once or is
 * missing reasons for a deduction, then persists the result under
 * `<targetDir>/.pf/verdicts/`.
 */
export async function judgeStories(
  targetDir: string,
  criteriaId: string,
  callModel: JudgeModelCaller,
): Promise<JudgeResult> {
  const criteriaResult = loadCriteria(targetDir, criteriaId);
  if (!criteriaResult.ok) {
    return { ok: false, error: criteriaResult.error };
  }
  const criteria = criteriaResult.criteria;

  const decompositionResult = loadDecomposition(targetDir, criteria.decompositionId);
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decomposition = decompositionResult.decomposition;

  const docResult = loadIntentDoc(targetDir, criteria.intentId);
  if (!docResult.ok) {
    return { ok: false, error: docResult.error };
  }
  const doc = docResult.doc;

  let modelRaw: string;
  try {
    modelRaw = await callModel(buildJudgePrompt(doc, decomposition.stories, criteria));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `model call failed: ${message}` };
  }

  const parsed = parseJudgeVerdicts(modelRaw);
  if (parsed === undefined) {
    return { ok: false, error: 'model returned an invalid judge payload' };
  }

  const coverageProblems = validateScenarioCoverage(
    parsed.stories,
    criteria.stories.length,
    'verdict entry',
    'verdict',
  );
  if (coverageProblems.length > 0) {
    return {
      ok: false,
      error: `judge verdicts have coverage problems: ${coverageProblems.join('; ')}`,
    };
  }

  const reasonProblems = validateAlignmentReasons(parsed.stories);
  if (reasonProblems.length > 0) {
    return { ok: false, error: `judge verdicts are missing reasons: ${reasonProblems.join('; ')}` };
  }

  const stories: StoryVerdict[] = [];
  for (const entry of parsed.stories.slice().sort((a, b) => a.storyIndex - b.storyIndex)) {
    const storyCriteria = criteria.stories.find((s) => s.storyIndex === entry.storyIndex);
    if (storyCriteria === undefined) {
      return {
        ok: false,
        error: `criteria set ${criteriaId} has no story at index ${entry.storyIndex}`,
      };
    }
    const story = decomposition.stories[entry.storyIndex];
    const readiness = scoreReadiness({
      actor: story.asA,
      acceptanceCriteria: storyCriteria.scenarios.map(renderScenario),
      openQuestions: [],
    });

    stories.push({
      storyIndex: entry.storyIndex,
      storyTitle: storyCriteria.storyTitle,
      tracesTo: storyCriteria.tracesTo,
      readinessScore: readiness.score,
      readinessReasons: readiness.missing,
      intentAlignmentScore: entry.intentAlignmentScore,
      intentAlignmentReasons: entry.reasons,
    });
  }

  const id = createHash('sha256')
    .update(`${criteriaId}\n${JSON.stringify({ stories })}`, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const verdicts: VerdictSet = {
    id,
    criteriaId,
    decompositionId: criteria.decompositionId,
    intentId: criteria.intentId,
    createdAt: new Date().toISOString(),
    stories,
  };

  const verdictsDir = join(targetDir, WORKSPACE_DIR, VERDICTS_DIR);
  mkdirSync(verdictsDir, { recursive: true });
  const artifactPath = join(verdictsDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(verdicts, null, 2)}\n`, 'utf8');

  return { ok: true, verdicts, artifactPath };
}

/** Load a previously persisted verdict set from `<targetDir>/.pf/verdicts/<verdictId>.json`. */
export function loadVerdicts(targetDir: string, verdictId: string): LoadVerdictsResult {
  if (!/^[0-9a-f]{12}$/.test(verdictId)) {
    return { ok: false, error: `verdict set ${verdictId} not found` };
  }

  const artifactPath = join(targetDir, WORKSPACE_DIR, VERDICTS_DIR, `${verdictId}.json`);
  let raw: string;
  try {
    raw = readFileSync(artifactPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `verdict set ${verdictId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read verdict set ${verdictId}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `verdict set ${verdictId} is not a valid verdict set` };
  }

  const result = persistedVerdictsSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `verdict set ${verdictId} is not a valid verdict set` };
  }

  return { ok: true, verdicts: result.data as VerdictSet, artifactPath };
}
