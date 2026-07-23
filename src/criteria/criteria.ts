/**
 * Acceptance-criteria stage — one LLM call over a persisted decomposition
 * produces structured Gherkin scenarios per story; judging quality is a
 * later epic.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import {
  loadDecomposition,
  storySentence,
  type Decomposition,
  type DecomposedStory,
} from '../decompose/decompose.js';
import { scoreReadiness } from '../readiness/score.js';

/** Name of the directory inside the workspace that holds acceptance-criteria artifacts. */
export const CRITERIA_DIR = 'criteria';

/** One structured Gherkin scenario; steps beyond the first in each group render as "And". */
export interface GherkinScenario {
  readonly name: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
}

/** Scenarios attached to exactly one story, inheriting its traceability. */
export interface StoryCriteria {
  readonly storyIndex: number;
  readonly storyTitle: string;
  readonly tracesTo: readonly string[];
  readonly scenarios: readonly GherkinScenario[];
  /** Readiness-rubric failures for this story; empty when the story passes the structural pre-check. */
  readonly readinessFlags: readonly string[];
}

/** A persisted acceptance-criteria set — Gherkin scenarios for every story in a decomposition. */
export interface CriteriaSet {
  /** Content-derived id: first 12 hex chars of sha256 of decompositionId + stories JSON (excludes createdAt). */
  readonly id: string;
  readonly decompositionId: string;
  /** Copied from the decomposition for lineage. */
  readonly intentId: string;
  readonly createdAt: string; // ISO 8601
  readonly stories: readonly StoryCriteria[];
}

/** The single LLM call seam; injected so the engine stays UI-less and testable. */
export type CriteriaModelCaller = (prompt: string) => Promise<string>;

export type GenerateCriteriaResult =
  | { readonly ok: true; readonly criteria: CriteriaSet; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

const scenarioSchema = z.object({
  name: z.string().min(1),
  given: z.array(z.string().min(1)).min(1),
  when: z.array(z.string().min(1)).min(1),
  then: z.array(z.string().min(1)).min(1),
});

const criteriaResponseSchema = z.object({
  stories: z
    .array(
      z.object({
        storyIndex: z.number().int().min(0),
        scenarios: z.array(scenarioSchema).min(1),
      }),
    )
    .min(1),
});

/** Build the acceptance-criteria prompt instructing the model to return Gherkin scenarios per story as JSON. */
export function buildCriteriaPrompt(decomposition: Decomposition): string {
  const lines = [
    'You are the acceptance-criteria stage of a product refinement pipeline.',
    'For EACH story below, write one or more Gherkin scenarios that make "done" testable.',
    '',
    'Return ONLY a JSON object (no prose, no code fences) of the form:',
    '{"stories": [{"storyIndex": number, "scenarios": [{"name": string, "given": [string], "when": [string], "then": [string]}]}]}',
    '',
    'Rules:',
    '- exactly one entry per story, storyIndex copied from the list below.',
    '- every scenario must have at least one given, one when, and one then step.',
    '- steps are plain sentences WITHOUT the Given/When/Then keyword prefix.',
    '',
    `Epic: ${decomposition.epic.title} — ${decomposition.epic.summary}`,
    'Stories:',
    ...decomposition.stories.map(
      (story, index) =>
        `[${index}] ${story.title} — ${storySentence(story)} (traces-to: ${story.tracesTo.join(', ')})`,
    ),
  ];

  return lines.join('\n');
}

/** Pure check for scenario coverage: every story index in range, no duplicates, no gaps. */
export function validateScenarioCoverage(
  entries: readonly { storyIndex: number }[],
  storyCount: number,
): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.storyIndex >= storyCount) {
      problems.push(`scenario group references unknown story index ${entry.storyIndex}`);
      continue;
    }
    if (seen.has(entry.storyIndex)) {
      problems.push(`story index ${entry.storyIndex} appears more than once`);
      continue;
    }
    seen.add(entry.storyIndex);
  }
  for (let index = 0; index < storyCount; index += 1) {
    if (!seen.has(index)) {
      problems.push(`story index ${index} has no scenarios`);
    }
  }
  return problems;
}

/** Run the readiness rubric over one story's structural shape; returns the descriptions of failed checks. */
export function checkStoryReadiness(
  story: DecomposedStory,
  scenarios: readonly GherkinScenario[],
): readonly string[] {
  return scoreReadiness({
    actor: story.asA,
    acceptanceCriteria: scenarios.map(renderScenario),
    openQuestions: [],
  }).missing;
}

/** Render a structured scenario to canonical Gherkin text for display/export. */
export function renderScenario(scenario: GherkinScenario): string {
  const lines = [`Scenario: ${scenario.name}`];
  const renderGroup = (keyword: string, steps: readonly string[]): void => {
    steps.forEach((step, index) => {
      lines.push(`  ${index === 0 ? keyword : 'And'} ${step}`);
    });
  };
  renderGroup('Given', scenario.given);
  renderGroup('When', scenario.when);
  renderGroup('Then', scenario.then);
  return lines.join('\n');
}

function stripFences(trimmed: string): string {
  if (trimmed.startsWith('```')) {
    const withoutOpenFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpenFence.replace(/```$/, '').trim();
  }
  return trimmed;
}

function parseCriteria(
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

  const result = criteriaResponseSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

/**
 * Generate Gherkin acceptance criteria for every story in a persisted
 * decomposition.
 *
 * Reads `<targetDir>/.pf/decompositions/<decompositionId>.json`, makes one
 * LLM call via `callModel`, rejects any response that doesn't cover every
 * story exactly once, then persists the result under
 * `<targetDir>/.pf/criteria/`.
 */
export async function generateAcceptanceCriteria(
  targetDir: string,
  decompositionId: string,
  callModel: CriteriaModelCaller,
): Promise<GenerateCriteriaResult> {
  const decompositionResult = loadDecomposition(targetDir, decompositionId);
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decomposition = decompositionResult.decomposition;

  let modelRaw: string;
  try {
    modelRaw = await callModel(buildCriteriaPrompt(decomposition));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `model call failed: ${message}` };
  }

  const parsed = parseCriteria(modelRaw);
  if (parsed === undefined) {
    return { ok: false, error: 'model returned an invalid criteria payload' };
  }

  const problems = validateScenarioCoverage(parsed.stories, decomposition.stories.length);
  if (problems.length > 0) {
    return { ok: false, error: `criteria have coverage problems: ${problems.join('; ')}` };
  }

  const stories: StoryCriteria[] = parsed.stories
    .slice()
    .sort((a, b) => a.storyIndex - b.storyIndex)
    .map((entry) => {
      const story = decomposition.stories[entry.storyIndex];
      return {
        storyIndex: entry.storyIndex,
        storyTitle: story.title,
        tracesTo: story.tracesTo,
        scenarios: entry.scenarios,
        readinessFlags: checkStoryReadiness(story, entry.scenarios),
      };
    });

  const id = createHash('sha256')
    .update(`${decompositionId}\n${JSON.stringify({ stories })}`, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const criteria: CriteriaSet = {
    id,
    decompositionId,
    intentId: decomposition.intentId,
    createdAt: new Date().toISOString(),
    stories,
  };

  const criteriaDir = join(targetDir, WORKSPACE_DIR, CRITERIA_DIR);
  mkdirSync(criteriaDir, { recursive: true });
  const artifactPath = join(criteriaDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(criteria, null, 2)}\n`, 'utf8');

  return { ok: true, criteria, artifactPath };
}
