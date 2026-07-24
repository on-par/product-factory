/**
 * Markdown export stage — writes one markdown file per work item (epic +
 * stories) from an approved readiness report. Refuses unapproved reports
 * before touching the filesystem (human gate #2). GitHub/Jira targets are
 * separate stories.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReport, type ReadinessReport } from '../report/report.js';
import { loadReportApproval } from '../report/approve.js';
import { loadCriteria, renderScenario, type StoryCriteria } from '../criteria/criteria.js';
import {
  loadDecomposition,
  storySentence,
  type DecomposedStory,
  type Epic,
} from '../decompose/decompose.js';

/** One file the markdown exporter wrote. */
export interface ExportedFile {
  readonly fileName: string;
  readonly path: string;
}

export type ExportMarkdownResult =
  | { readonly ok: true; readonly files: readonly ExportedFile[]; readonly outDir: string }
  | { readonly ok: false; readonly error: string };

/** Filesystem-safe slug of a title: lowercased, non-alphanumerics collapsed to single hyphens. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

/** Render the epic markdown file — pure. */
export function renderEpicFile(
  report: ReadinessReport,
  epic: Epic,
  storyFiles: readonly {
    storyIndex: number;
    storyTitle: string;
    fileName: string;
    tracesTo: readonly string[];
  }[],
): string {
  const stories = storyFiles.slice().sort((a, b) => a.storyIndex - b.storyIndex);

  const lines: string[] = [`# Epic: ${epic.title}`, '', epic.summary, '', '## Stories', ''];

  for (const story of stories) {
    lines.push(
      `- [${story.storyTitle}](./${story.fileName}) (traces-to: ${story.tracesTo.join(', ')})`,
    );
  }

  lines.push(
    '',
    '## Traceability',
    '',
    `- Report: \`${report.id}\``,
    `- Verdict set: \`${report.verdictId}\``,
    `- Criteria set: \`${report.criteriaId}\``,
    `- Decomposition: \`${report.decompositionId}\``,
    `- Intent doc: \`${report.intentId}\``,
  );

  return `${lines.join('\n')}\n`;
}

/** Render one story's markdown file — pure. */
export function renderStoryFile(
  report: ReadinessReport,
  story: DecomposedStory,
  criteria: StoryCriteria,
): string {
  const lines: string[] = [
    `# Story: ${criteria.storyTitle}`,
    '',
    '## User story',
    '',
    storySentence(story),
    '',
    '## Acceptance criteria',
    '',
  ];

  criteria.scenarios.forEach((scenario, index) => {
    if (index > 0) {
      lines.push('');
    }
    lines.push('```gherkin', renderScenario(scenario), '```');
  });

  lines.push(
    '',
    '## Traceability',
    '',
    `- Traces to: ${criteria.tracesTo.join(', ')}`,
    `- Report: \`${report.id}\``,
    `- Criteria set: \`${report.criteriaId}\``,
    `- Decomposition: \`${report.decompositionId}\``,
    `- Intent doc: \`${report.intentId}\``,
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Export an approved readiness report as one markdown file per work item.
 * Refuses (writing nothing) when the report has no approval marker.
 */
export function exportMarkdown(
  targetDir: string,
  reportId: string,
  outDir: string,
): ExportMarkdownResult {
  const approval = loadReportApproval(targetDir, reportId);
  if (!approval.ok) {
    return {
      ok: false,
      error: `export refused: readiness report ${reportId} is not approved — run "pf report approve ${reportId}" first (human gate #2)`,
    };
  }

  const reportResult = loadReport(targetDir, reportId);
  if (!reportResult.ok) {
    return { ok: false, error: reportResult.error };
  }
  const report = reportResult.report;

  const criteriaResult = loadCriteria(targetDir, report.criteriaId);
  if (!criteriaResult.ok) {
    return { ok: false, error: criteriaResult.error };
  }
  const criteria = criteriaResult.criteria;

  const decompositionResult = loadDecomposition(targetDir, report.decompositionId);
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decomposition = decompositionResult.decomposition;

  const storyEntries: {
    storyIndex: number;
    storyTitle: string;
    fileName: string;
    tracesTo: readonly string[];
    content: string;
  }[] = [];

  for (const storyCriteria of criteria.stories) {
    const story = decomposition.stories[storyCriteria.storyIndex];
    if (story === undefined) {
      return {
        ok: false,
        error: `criteria set ${report.criteriaId} references unknown story index ${storyCriteria.storyIndex}`,
      };
    }
    storyEntries.push({
      storyIndex: storyCriteria.storyIndex,
      storyTitle: storyCriteria.storyTitle,
      fileName: `story-${storyCriteria.storyIndex}-${slugify(storyCriteria.storyTitle)}.md`,
      tracesTo: storyCriteria.tracesTo,
      content: renderStoryFile(report, story, storyCriteria),
    });
  }

  storyEntries.sort((a, b) => a.storyIndex - b.storyIndex);

  const epicFileName = 'epic.md';
  const epicContent = renderEpicFile(report, decomposition.epic, storyEntries);

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, epicFileName), epicContent, 'utf8');
    for (const entry of storyEntries) {
      writeFileSync(join(outDir, entry.fileName), entry.content, 'utf8');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to write export to ${outDir}: ${message}` };
  }

  const files: ExportedFile[] = [
    { fileName: epicFileName, path: join(outDir, epicFileName) },
    ...storyEntries.map((entry) => ({
      fileName: entry.fileName,
      path: join(outDir, entry.fileName),
    })),
  ];

  return { ok: true, files, outDir };
}
