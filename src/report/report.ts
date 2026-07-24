/**
 * Readiness report stage — aggregates a persisted verdict set and its lineage
 * into the markdown report a PM reads at human gate #2. No LLM call: every
 * number here was produced by an earlier stage, so the report is deterministic.
 * Approval lives in ./approve.ts; export targets are a later epic (#8).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { loadVerdicts, type StoryVerdict } from '../judge/judge.js';
import { loadDecomposition } from '../decompose/decompose.js';
import { loadIntentDoc } from '../intent/build.js';
import { loadAnswerSession, type AnswerSession } from '../interview/answers.js';
import { combinedScore } from '../rework/rework.js';

/** Name of the directory inside the workspace that holds readiness-report artifacts. */
export const REPORTS_DIR = 'reports';

/** One story's line in the readiness report, carrying its traceability. */
export interface ReportStory {
  readonly storyIndex: number;
  readonly storyTitle: string;
  /** Intent statement ids this story traces to — the lineage the report must show. */
  readonly tracesTo: readonly string[];
  readonly readinessScore: number;
  readonly intentAlignmentScore: number;
  /** Mean of the two axes — the same yardstick the rework loop gates on. */
  readonly overallScore: number;
  readonly readinessReasons: readonly string[];
  readonly intentAlignmentReasons: readonly string[];
}

/** A clarifying question the PM never answered — what "move ambiguity left" still owes. */
export interface ReportOpenQuestion {
  readonly index: number;
  readonly question: string;
  readonly gapType: string;
  /** True when the question targets a missing intent dimension. */
  readonly blocking: boolean;
}

/** The structured readiness report; `renderReadinessReport` turns it into markdown. */
export interface ReadinessReport {
  /** Content-derived id: first 12 hex chars of sha256 of verdictId + report body JSON (excludes createdAt). */
  readonly id: string;
  readonly verdictId: string;
  readonly criteriaId: string;
  readonly decompositionId: string;
  readonly intentId: string;
  readonly createdAt: string; // ISO 8601
  readonly epicTitle: string;
  readonly epicSummary: string;
  readonly stories: readonly ReportStory[];
  readonly openQuestions: readonly ReportOpenQuestion[];
}

export type BuildReportResult =
  | {
      readonly ok: true;
      readonly report: ReadinessReport;
      readonly markdown: string;
      readonly artifactPath: string;
    }
  | { readonly ok: false; readonly error: string };

/** Unanswered questions from a session, sorted by original index — pure. */
export function collectOpenQuestions(session: AnswerSession): readonly ReportOpenQuestion[] {
  return session.questions
    .filter((q) => q.answer === undefined)
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((q) => ({
      index: q.index,
      question: q.question.question,
      gapType: q.question.gapType,
      blocking: q.blocking,
    }));
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Render a structured readiness report to markdown — the only presentation code in the engine. */
export function renderReadinessReport(report: ReadinessReport): string {
  const stories = report.stories.slice().sort((a, b) => a.storyIndex - b.storyIndex);

  const lines: string[] = [
    '# Readiness report',
    '',
    `- Report: \`${report.id}\``,
    `- Verdict set: \`${report.verdictId}\``,
    `- Criteria set: \`${report.criteriaId}\``,
    `- Decomposition: \`${report.decompositionId}\``,
    `- Intent doc: \`${report.intentId}\``,
    `- Generated: ${report.createdAt}`,
    '',
    `Epic: ${report.epicTitle} — ${report.epicSummary}`,
    '',
    '## Scores',
    '',
    '| Story | Readiness | Intent alignment | Overall | Traces to |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const story of stories) {
    lines.push(
      `| [${story.storyIndex}] ${escapeCell(story.storyTitle)} | ${story.readinessScore.toFixed(2)} | ${story.intentAlignmentScore.toFixed(2)} | ${story.overallScore.toFixed(2)} | ${story.tracesTo.join(', ')} |`,
    );
  }

  lines.push('', '## Stories');

  for (const story of stories) {
    lines.push(
      '',
      `### [${story.storyIndex}] ${story.storyTitle}`,
      '',
      `- Readiness: ${story.readinessScore.toFixed(2)}`,
      `- Intent alignment: ${story.intentAlignmentScore.toFixed(2)}`,
      `- Overall: ${story.overallScore.toFixed(2)}`,
      `- Traces to: ${story.tracesTo.join(', ')}`,
      '',
    );

    if (story.readinessReasons.length === 0 && story.intentAlignmentReasons.length === 0) {
      lines.push('Nothing missing — this story is ready.');
    } else {
      lines.push('Missing:', '');
      for (const reason of story.readinessReasons) {
        lines.push(`- readiness: ${reason}`);
      }
      for (const reason of story.intentAlignmentReasons) {
        lines.push(`- intent alignment: ${reason}`);
      }
    }
  }

  lines.push('', '## Open questions', '');

  if (report.openQuestions.length === 0) {
    lines.push('None — every clarifying question was answered.');
  } else {
    for (const question of report.openQuestions) {
      const tag = question.blocking ? `${question.gapType}, blocking` : question.gapType;
      lines.push(`- [${question.index}] (${tag}) ${question.question}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function toReportStory(verdict: StoryVerdict): ReportStory {
  return {
    storyIndex: verdict.storyIndex,
    storyTitle: verdict.storyTitle,
    tracesTo: verdict.tracesTo,
    readinessScore: verdict.readinessScore,
    intentAlignmentScore: verdict.intentAlignmentScore,
    overallScore: combinedScore(verdict),
    readinessReasons: verdict.readinessReasons,
    intentAlignmentReasons: verdict.intentAlignmentReasons,
  };
}

/**
 * Build the markdown readiness report for a judged story set.
 *
 * Reads `<targetDir>/.pf/verdicts/<verdictId>.json` and follows its lineage
 * (decomposition → intent doc → interview session) to render a summary table
 * plus a per-story section and the list of clarifying questions the PM never
 * answered, then persists the markdown under `<targetDir>/.pf/reports/`.
 * Synchronous — unlike every other stage, this one makes no LLM call.
 */
export function buildReadinessReport(targetDir: string, verdictId: string): BuildReportResult {
  const verdictsResult = loadVerdicts(targetDir, verdictId);
  if (!verdictsResult.ok) {
    return { ok: false, error: verdictsResult.error };
  }
  const verdicts = verdictsResult.verdicts;

  const decompositionResult = loadDecomposition(targetDir, verdicts.decompositionId);
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decomposition = decompositionResult.decomposition;

  const docResult = loadIntentDoc(targetDir, verdicts.intentId);
  if (!docResult.ok) {
    return { ok: false, error: docResult.error };
  }
  const doc = docResult.doc;

  // Soft failure: an intent doc can be hand-authored or its upstream session
  // pruned, and a read-only rendering command must not fail on an optional
  // upstream artifact.
  const sessionResult = loadAnswerSession(targetDir, doc.interviewId);
  const openQuestions = sessionResult.ok ? collectOpenQuestions(sessionResult.session) : [];

  const stories = verdicts.stories.map(toReportStory);

  const body = {
    verdictId,
    criteriaId: verdicts.criteriaId,
    decompositionId: verdicts.decompositionId,
    intentId: verdicts.intentId,
    epicTitle: decomposition.epic.title,
    epicSummary: decomposition.epic.summary,
    stories,
    openQuestions,
  };
  const id = createHash('sha256')
    .update(`${verdictId}\n${JSON.stringify(body)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);

  const report: ReadinessReport = {
    id,
    verdictId: body.verdictId,
    criteriaId: body.criteriaId,
    decompositionId: body.decompositionId,
    intentId: body.intentId,
    createdAt: new Date().toISOString(),
    epicTitle: body.epicTitle,
    epicSummary: body.epicSummary,
    stories: body.stories,
    openQuestions: body.openQuestions,
  };
  const markdown = renderReadinessReport(report);

  const reportsDir = join(targetDir, WORKSPACE_DIR, REPORTS_DIR);
  mkdirSync(reportsDir, { recursive: true });
  const artifactPath = join(reportsDir, `${id}.md`);
  writeFileSync(artifactPath, markdown, 'utf8');

  return { ok: true, report, markdown, artifactPath };
}
