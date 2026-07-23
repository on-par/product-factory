/**
 * Generator/critic rework loop — re-judges a criteria set, has a generator
 * revise the stories that score below the readiness threshold, and repeats
 * under an explicit stopping rule (ADR 0001: every loop needs one) so it never
 * runs unbounded. Readiness-report aggregation and export are later stories.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import {
  checkStoryReadiness,
  criteriaSetId,
  loadCriteria,
  renderScenario,
  saveCriteria,
  type CriteriaSet,
  type GherkinScenario,
  type StoryCriteria,
} from '../criteria/criteria.js';
import { loadDecomposition, storySentence, type DecomposedStory } from '../decompose/decompose.js';
import { loadIntentDoc, type IntentDoc } from '../intent/build.js';
import { judgeStories, type JudgeModelCaller, type StoryVerdict } from '../judge/judge.js';

/** Name of the directory inside the workspace that holds rework session artifacts. */
export const REWORKS_DIR = 'reworks';

/** Why the loop stopped; 'in-progress' only ever appears mid-loop, never in a persisted session. */
export type ReworkStatus = 'in-progress' | 'threshold-met' | 'no-improvement' | 'budget-exhausted';

/** One story's score in one round, carrying its traceability forward. */
export interface StoryScore {
  readonly storyIndex: number;
  readonly storyTitle: string;
  readonly tracesTo: readonly string[];
  /** Mean of readinessScore and intentAlignmentScore, 0..1. */
  readonly score: number;
  /** Readiness + intent-alignment reasons concatenated; what the generator is told to fix. */
  readonly reasons: readonly string[];
}

/** One judged round of the loop. Iteration 0 is the un-reworked baseline. */
export interface ReworkRound {
  /** 0 for the baseline judge pass; 1..maxIterations for each rework iteration. */
  readonly iteration: number;
  /** The criteria set judged in this round (iteration 0 is the input set). */
  readonly criteriaId: string;
  readonly verdictId: string;
  /** The round's score: the MINIMUM story score — the weakest story gates the set. */
  readonly score: number;
  readonly stories: readonly StoryScore[];
}

/** A persisted rework session — every round, the stop reason, and the best result. */
export interface ReworkSession {
  /** Content-derived id: first 12 hex chars of sha256 of criteriaId + session body JSON (excludes createdAt). */
  readonly id: string;
  /** The criteria set the loop started from (traceability link). */
  readonly criteriaId: string;
  readonly decompositionId: string;
  readonly intentId: string;
  readonly createdAt: string; // ISO 8601
  readonly threshold: number;
  readonly maxIterations: number;
  /** Terminal status only — the loop never persists 'in-progress'. */
  readonly status: Exclude<ReworkStatus, 'in-progress'>;
  readonly rounds: readonly ReworkRound[];
  /** Iteration number of the highest-scoring round (earliest wins ties). */
  readonly bestIteration: number;
  /** Criteria set of the best round — what downstream stages should consume. */
  readonly bestCriteriaId: string;
  /** Verdict set of the best round. */
  readonly bestVerdictId: string;
}

/** The generator LLM seam (revises scenarios); injected so the engine stays UI-less and testable. */
export type ReworkModelCaller = (prompt: string) => Promise<string>;

/** The two seams the loop needs: a generator to revise, and the judge (critic) to re-score. */
export interface ReworkCallers {
  readonly generate: ReworkModelCaller;
  readonly judge: JudgeModelCaller;
}

export interface ReworkOptions {
  /** Story score at or above which a story is considered ready; default 0.8. */
  readonly threshold?: number;
  /** Maximum rework iterations after the baseline pass; default 3. */
  readonly maxIterations?: number;
}

export type ReworkResult =
  | { readonly ok: true; readonly session: ReworkSession; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

/** The loop's per-story yardstick: the mean of the two judge axes. */
export function combinedScore(verdict: StoryVerdict): number {
  return (verdict.readinessScore + verdict.intentAlignmentScore) / 2;
}

/**
 * The explicit stopping rule (pure). Precedence: threshold met beats
 * no-improvement, which beats budget exhausted — a clean pass is always
 * reported as such, and "we stopped learning" is more actionable than
 * "we ran out of rounds" when both are true.
 *
 * `rounds` must be non-empty and ordered by iteration.
 */
export function evaluateReworkStopping(
  rounds: readonly ReworkRound[],
  threshold: number,
  maxIterations: number,
): ReworkStatus {
  const last = rounds[rounds.length - 1];
  if (last.score >= threshold) {
    return 'threshold-met';
  }
  if (rounds.length >= 2 && last.score <= rounds[rounds.length - 2].score) {
    return 'no-improvement';
  }
  if (last.iteration >= maxIterations) {
    return 'budget-exhausted';
  }
  return 'in-progress';
}

/** Pure check that a revision covers exactly the requested story indices, once each. */
export function validateRevisionCoverage(
  entries: readonly { storyIndex: number }[],
  requested: readonly number[],
): string[] {
  const wanted = new Set(requested);
  const seen = new Set<number>();
  const problems: string[] = [];
  for (const entry of entries) {
    if (!wanted.has(entry.storyIndex)) {
      problems.push(
        `revision targets story index ${entry.storyIndex}, which was not asked for rework`,
      );
      continue;
    }
    if (seen.has(entry.storyIndex)) {
      problems.push(`story index ${entry.storyIndex} appears more than once`);
      continue;
    }
    seen.add(entry.storyIndex);
  }
  for (const index of requested) {
    if (!seen.has(index)) {
      problems.push(`story index ${index} has no revision`);
    }
  }
  return problems;
}

/** Index of the highest-scoring round; the earliest round wins ties. */
export function bestRound(rounds: readonly ReworkRound[]): ReworkRound {
  return rounds.reduce((best, round) => (round.score > best.score ? round : best));
}

/** Build the generator prompt: revise ONLY the flagged stories' scenarios to address the critic's reasons. */
export function buildReworkPrompt(
  doc: IntentDoc,
  stories: readonly DecomposedStory[],
  criteria: CriteriaSet,
  failing: readonly StoryScore[],
): string {
  const lines = [
    'You are the generator stage of a product refinement pipeline, reworking stories a critic scored below the readiness threshold.',
    'Rewrite the Gherkin scenarios for EACH story listed below so they address every critic reason given for that story.',
    '',
    'Return ONLY a JSON object (no prose, no code fences) of the form:',
    '{"stories": [{"storyIndex": number, "scenarios": [{"name": string, "given": [string], "when": [string], "then": [string]}]}]}',
    '',
    'Rules:',
    '- exactly one entry per story listed below, storyIndex copied EXACTLY; never revise a story that is not listed.',
    '- every scenario must have at least one given, one when, and one then step.',
    '- steps are plain sentences WITHOUT the Given/When/Then keyword prefix.',
    '- the revised scenarios must still deliver the intent statements the story traces to; never drift from them.',
    '- address every critic reason listed under the story.',
    '',
    'Intent statements:',
    ...doc.statements.map((statement) => `[${statement.id}] ${statement.text}`),
    '',
    'Stories to rework:',
  ];

  for (const entry of failing.slice().sort((a, b) => a.storyIndex - b.storyIndex)) {
    const story = stories[entry.storyIndex];
    lines.push(
      `[${entry.storyIndex}] ${entry.storyTitle} — ${storySentence(story)} (traces-to: ${entry.tracesTo.join(', ')}) score: ${entry.score.toFixed(2)}`,
    );
    const storyCriteria = criteria.stories.find((s) => s.storyIndex === entry.storyIndex);
    if (storyCriteria !== undefined) {
      for (const scenario of storyCriteria.scenarios) {
        lines.push(renderScenario(scenario));
      }
    }
    for (const reason of entry.reasons) {
      lines.push(`  critic: ${reason}`);
    }
  }

  return lines.join('\n');
}

const revisionScenarioSchema = z.object({
  name: z.string().min(1),
  given: z.array(z.string().min(1)).min(1),
  when: z.array(z.string().min(1)).min(1),
  then: z.array(z.string().min(1)).min(1),
});

const revisionResponseSchema = z.object({
  stories: z
    .array(
      z.object({
        storyIndex: z.number().int().min(0),
        scenarios: z.array(revisionScenarioSchema).min(1),
      }),
    )
    .min(1),
});

function stripFences(trimmed: string): string {
  if (trimmed.startsWith('```')) {
    const withoutOpenFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpenFence.replace(/```$/, '').trim();
  }
  return trimmed;
}

function parseRevision(
  raw: string,
): { stories: { storyIndex: number; scenarios: GherkinScenario[] }[] } | undefined {
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

  const result = revisionResponseSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

function toRound(
  iteration: number,
  criteriaId: string,
  verdicts: { id: string; stories: readonly StoryVerdict[] },
): ReworkRound {
  const stories: StoryScore[] = verdicts.stories
    .map((v) => ({
      storyIndex: v.storyIndex,
      storyTitle: v.storyTitle,
      tracesTo: v.tracesTo,
      score: combinedScore(v),
      reasons: [...v.readinessReasons, ...v.intentAlignmentReasons],
    }))
    .sort((a, b) => a.storyIndex - b.storyIndex);

  return {
    iteration,
    criteriaId,
    verdictId: verdicts.id,
    score: Math.min(...stories.map((s) => s.score)),
    stories,
  };
}

/**
 * Run the generator/critic rework loop over a persisted criteria set.
 *
 * Judges the baseline set, then repeatedly asks a generator to revise the
 * scenarios of every story scoring below `threshold` using the critic's own
 * reasons, re-judges, and stops once the explicit stopping rule fires:
 * threshold met, no improvement between rounds, or the iteration budget is
 * exhausted. Persists one `ReworkSession` artifact under
 * `<targetDir>/.pf/reworks/` recording every round.
 */
export async function reworkStories(
  targetDir: string,
  criteriaId: string,
  callers: ReworkCallers,
  options?: ReworkOptions,
): Promise<ReworkResult> {
  const thresholdOption = options?.threshold;
  if (
    thresholdOption !== undefined &&
    (!Number.isFinite(thresholdOption) || thresholdOption < 0 || thresholdOption > 1)
  ) {
    return { ok: false, error: 'threshold must be between 0 and 1' };
  }
  const maxIterationsOption = options?.maxIterations;
  if (
    maxIterationsOption !== undefined &&
    (!Number.isInteger(maxIterationsOption) || maxIterationsOption <= 0)
  ) {
    return { ok: false, error: 'maxIterations must be a positive integer' };
  }
  const threshold = thresholdOption ?? 0.8;
  const maxIterations = maxIterationsOption ?? 3;

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

  const baseline = await judgeStories(targetDir, criteriaId, callers.judge);
  if (!baseline.ok) {
    return { ok: false, error: baseline.error };
  }

  const rounds: ReworkRound[] = [toRound(0, criteriaId, baseline.verdicts)];
  let currentCriteria = criteria;

  while (evaluateReworkStopping(rounds, threshold, maxIterations) === 'in-progress') {
    const current = rounds[rounds.length - 1];
    const failing = current.stories.filter((s) => s.score < threshold);

    let generatorRaw: string;
    try {
      generatorRaw = await callers.generate(
        buildReworkPrompt(doc, decomposition.stories, currentCriteria, failing),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `model call failed: ${message}` };
    }

    const parsed = parseRevision(generatorRaw);
    if (parsed === undefined) {
      return { ok: false, error: 'model returned an invalid rework payload' };
    }

    const problems = validateRevisionCoverage(
      parsed.stories,
      failing.map((s) => s.storyIndex),
    );
    if (problems.length > 0) {
      return { ok: false, error: `rework revision has coverage problems: ${problems.join('; ')}` };
    }

    const revisedStories: StoryCriteria[] = currentCriteria.stories.map((story) => {
      const revision = parsed.stories.find((r) => r.storyIndex === story.storyIndex);
      if (revision === undefined) {
        return story;
      }
      return {
        ...story,
        scenarios: revision.scenarios,
        readinessFlags: checkStoryReadiness(
          decomposition.stories[story.storyIndex],
          revision.scenarios,
        ),
      };
    });
    const nextId = criteriaSetId(currentCriteria.decompositionId, revisedStories);
    const nextCriteria: CriteriaSet = {
      id: nextId,
      decompositionId: currentCriteria.decompositionId,
      intentId: currentCriteria.intentId,
      createdAt: new Date().toISOString(),
      stories: revisedStories,
    };
    saveCriteria(targetDir, nextCriteria);

    const reJudged = await judgeStories(targetDir, nextId, callers.judge);
    if (!reJudged.ok) {
      return { ok: false, error: reJudged.error };
    }
    rounds.push(toRound(current.iteration + 1, nextId, reJudged.verdicts));
    currentCriteria = nextCriteria;
  }

  const status = evaluateReworkStopping(rounds, threshold, maxIterations) as Exclude<
    ReworkStatus,
    'in-progress'
  >;
  const best = bestRound(rounds);

  const body = {
    threshold,
    maxIterations,
    status,
    rounds,
    bestIteration: best.iteration,
    bestCriteriaId: best.criteriaId,
    bestVerdictId: best.verdictId,
  };
  const id = createHash('sha256')
    .update(`${criteriaId}\n${JSON.stringify(body)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const session: ReworkSession = {
    id,
    criteriaId,
    decompositionId: criteria.decompositionId,
    intentId: criteria.intentId,
    createdAt: new Date().toISOString(),
    ...body,
  };

  const reworksDir = join(targetDir, WORKSPACE_DIR, REWORKS_DIR);
  mkdirSync(reworksDir, { recursive: true });
  const artifactPath = join(reworksDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  return { ok: true, session, artifactPath };
}
