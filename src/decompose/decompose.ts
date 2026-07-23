/**
 * Decomposer stage — one LLM call over an approved intent doc produces an
 * epic + traceable stories; acceptance criteria and scoring are later
 * stories.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { loadIntentDoc, type IntentDoc } from '../intent/build.js';
import { isIntentApproved } from '../intent/approve.js';

/** Name of the directory inside the workspace that holds decomposition artifacts. */
export const DECOMPOSITIONS_DIR = 'decompositions';

/** The single epic a decomposition produces. */
export interface Epic {
  readonly title: string;
  readonly summary: string;
}

/** One INVEST story drafted by the decomposer (acceptance criteria arrive in a later story). */
export interface DecomposedStory {
  readonly title: string;
  /** Actor — the "As a ..." clause. */
  readonly asA: string;
  /** Capability — the "I want ..." clause. */
  readonly iWant: string;
  /** Value — the "so that ..." clause. */
  readonly soThat: string;
  /** Intent statement ids this story traces back to; every id must exist in the intent doc. */
  readonly tracesTo: readonly string[];
}

/** A persisted decomposition — one epic plus traceable stories for one intent doc. */
export interface Decomposition {
  /** Content-derived id: first 12 hex chars of sha256 of intentId + epic/stories JSON (excludes createdAt). */
  readonly id: string;
  /** Id of the intent doc this decomposition was produced from (traceability link). */
  readonly intentId: string;
  readonly createdAt: string; // ISO 8601
  readonly epic: Epic;
  readonly stories: readonly DecomposedStory[];
}

/** The single LLM call seam; injected so the engine stays UI-less and testable. */
export type DecomposeModelCaller = (prompt: string) => Promise<string>;

export type DecomposeResult =
  | { readonly ok: true; readonly decomposition: Decomposition; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

const storySchema = z.object({
  title: z.string().min(1),
  asA: z.string().min(1),
  iWant: z.string().min(1),
  soThat: z.string().min(1),
  tracesTo: z.array(z.string().regex(/^INT-\d{3,}$/)).min(1),
});
const decompositionResponseSchema = z.object({
  epic: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
  stories: z.array(storySchema).min(1),
});

const persistedDecompositionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  intentId: z.string().min(1),
  createdAt: z.string().min(1),
  epic: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
  stories: z.array(storySchema).min(1),
});

export type LoadDecompositionResult =
  | { readonly ok: true; readonly decomposition: Decomposition; readonly artifactPath: string }
  | { readonly ok: false; readonly error: string };

/** Build the decomposer prompt instructing the model to return an epic + traceable stories as JSON. */
export function buildDecomposePrompt(doc: IntentDoc): string {
  const lines = [
    'You are the decomposer stage of a product refinement pipeline.',
    'Read the approved intent doc below and decompose it into ONE epic and a set of INVEST stories — the smallest deliverable vertical slices of value.',
    '',
    'Return ONLY a JSON object (no prose, no code fences) of the form:',
    '{"epic": {"title": string, "summary": string}, "stories": [{"title": string, "asA": string, "iWant": string, "soThat": string, "tracesTo": [string]}]}',
    '',
    'Rules:',
    '- every story must have an actor (asA), a capability (iWant), and a value (soThat).',
    "- every story's tracesTo must list one or more intent statement ids copied EXACTLY from the doc below — never invent ids.",
    '- do not write acceptance criteria.',
  ];

  if (doc.goal !== '') {
    lines.push(`Goal: ${doc.goal}`);
  }
  if (doc.actor !== '') {
    lines.push(`Actor: ${doc.actor}`);
  }
  if (doc.constraints.length > 0) {
    lines.push('Constraints:', ...doc.constraints.map((constraint) => `- ${constraint}`));
  }

  lines.push('', 'Intent statements:');
  for (const statement of doc.statements) {
    lines.push(`[${statement.id}] ${statement.text}`);
  }

  return lines.join('\n');
}

/** Pure check for orphan traces: every id in a story's tracesTo must exist in the intent doc. */
export function validateTraceability(
  stories: readonly DecomposedStory[],
  doc: IntentDoc,
): string[] {
  const known = new Set(doc.statements.map((s) => s.id));
  const problems: string[] = [];
  for (const story of stories) {
    for (const id of story.tracesTo) {
      if (!known.has(id)) {
        problems.push(`story "${story.title}" references unknown intent id ${id}`);
      }
    }
  }
  return problems;
}

/** Compose the "As a / I want / so that" sentence for a story. */
export function storySentence(story: DecomposedStory): string {
  return `As a ${story.asA.trim()}, I want ${story.iWant.trim()}, so that ${story.soThat.trim()}.`;
}

function stripFences(trimmed: string): string {
  if (trimmed.startsWith('```')) {
    const withoutOpenFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
    return withoutOpenFence.replace(/```$/, '').trim();
  }
  return trimmed;
}

function parseDecomposition(raw: string): { epic: Epic; stories: DecomposedStory[] } | undefined {
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

  const result = decompositionResponseSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

/**
 * Decompose an approved intent doc into one epic plus traceable stories.
 *
 * Reads `<targetDir>/.pf/intent/<intentId>.json` (must be approved — human
 * gate #1), makes one LLM call via `callModel`, rejects any story whose
 * `tracesTo` references an intent statement id that doesn't exist in the
 * doc, then persists the result under `<targetDir>/.pf/decompositions/`.
 */
export async function decomposeIntent(
  targetDir: string,
  intentId: string,
  callModel: DecomposeModelCaller,
): Promise<DecomposeResult> {
  const docResult = loadIntentDoc(targetDir, intentId);
  if (!docResult.ok) {
    return { ok: false, error: docResult.error };
  }
  const doc = docResult.doc;

  if (!isIntentApproved(targetDir, intentId)) {
    return { ok: false, error: `intent doc ${intentId} is not approved` };
  }

  let modelRaw: string;
  try {
    modelRaw = await callModel(buildDecomposePrompt(doc));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `model call failed: ${message}` };
  }

  const parsed = parseDecomposition(modelRaw);
  if (parsed === undefined) {
    return { ok: false, error: 'model returned an invalid decomposition payload' };
  }

  const problems = validateTraceability(parsed.stories, doc);
  if (problems.length > 0) {
    return { ok: false, error: `decomposition has orphan traces: ${problems.join('; ')}` };
  }

  const { epic, stories } = parsed;
  const id = createHash('sha256')
    .update(`${intentId}\n${JSON.stringify({ epic, stories })}`, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const decomposition: Decomposition = {
    id,
    intentId,
    createdAt: new Date().toISOString(),
    epic,
    stories,
  };

  const decompositionsDir = join(targetDir, WORKSPACE_DIR, DECOMPOSITIONS_DIR);
  mkdirSync(decompositionsDir, { recursive: true });
  const artifactPath = join(decompositionsDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(decomposition, null, 2)}\n`, 'utf8');

  return { ok: true, decomposition, artifactPath };
}

/** Load a previously persisted decomposition from `<targetDir>/.pf/decompositions/<decompositionId>.json`. */
export function loadDecomposition(
  targetDir: string,
  decompositionId: string,
): LoadDecompositionResult {
  if (!/^[0-9a-f]{12}$/.test(decompositionId)) {
    return { ok: false, error: `decomposition ${decompositionId} not found` };
  }

  const artifactPath = join(
    targetDir,
    WORKSPACE_DIR,
    DECOMPOSITIONS_DIR,
    `${decompositionId}.json`,
  );
  let raw: string;
  try {
    raw = readFileSync(artifactPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `decomposition ${decompositionId} not found` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read decomposition ${decompositionId}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `decomposition ${decompositionId} is not a valid decomposition` };
  }

  const result = persistedDecompositionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `decomposition ${decompositionId} is not a valid decomposition` };
  }

  return { ok: true, decomposition: result.data as Decomposition, artifactPath };
}
