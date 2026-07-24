/**
 * GitHub export stage — creates one GitHub issue per story from an approved
 * readiness report. Refuses unapproved reports (human gate #2). Idempotent:
 * stories whose traceability marker already appears in an existing issue
 * body are skipped. Jira is a separate story.
 */

import { z } from 'zod';
import { loadReport, type ReadinessReport } from '../report/report.js';
import { loadReportApproval } from '../report/approve.js';
import { loadCriteria, renderScenario, type StoryCriteria } from '../criteria/criteria.js';
import { loadDecomposition, storySentence, type DecomposedStory } from '../decompose/decompose.js';
import { fenceFor } from './markdown.js';

/** Machine-readable marker embedded in each issue body; the idempotency key. */
export function storyMarker(reportId: string, storyIndex: number): string {
  return `<!-- pf-story:${reportId}:${storyIndex} -->`;
}

/** An existing issue in the target repo, as much as the exporter needs. */
export interface ExistingIssue {
  readonly number: number;
  readonly body: string | null;
}

export interface CreatedIssue {
  readonly number: number;
  readonly htmlUrl: string;
}

/** Narrow GitHub API surface, injectable so tests never hit the network. */
export interface GitHubIssueClient {
  /** Every issue in the repo (all states), for marker scanning. */
  listIssues(owner: string, repo: string): Promise<readonly ExistingIssue[]>;
  createIssue(owner: string, repo: string, title: string, body: string): Promise<CreatedIssue>;
}

export interface ExportedIssue {
  readonly storyIndex: number;
  readonly storyTitle: string;
  readonly issueNumber: number;
  readonly url: string;
}

export interface SkippedStory {
  readonly storyIndex: number;
  readonly storyTitle: string;
  /** Number of the pre-existing issue whose body carries this story's marker. */
  readonly issueNumber: number;
}

export type ExportGitHubResult =
  | {
      readonly ok: true;
      readonly created: readonly ExportedIssue[];
      readonly skipped: readonly SkippedStory[];
    }
  | { readonly ok: false; readonly error: string };

/** Render the GitHub issue body for one story — pure. */
export function renderIssueBody(
  report: ReadinessReport,
  story: DecomposedStory,
  criteria: StoryCriteria,
): string {
  const lines: string[] = [
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
    const rendered = renderScenario(scenario);
    const fence = fenceFor(rendered);
    lines.push(`${fence}gherkin`, rendered, fence);
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
    '',
    storyMarker(report.id, criteria.storyIndex),
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Export an approved readiness report as one GitHub issue per story.
 * Refuses when the report has no approval marker. Idempotent: re-running
 * skips any story whose marker already appears in an existing issue body in
 * the target repo.
 */
export async function exportGitHub(
  targetDir: string,
  reportId: string,
  ownerRepo: string,
  client: GitHubIssueClient,
): Promise<ExportGitHubResult> {
  const match = /^([^\s/]+)\/([^\s/]+)$/.exec(ownerRepo);
  if (match === null) {
    return { ok: false, error: `invalid repository ${ownerRepo}: expected owner/repo` };
  }
  const [, owner, repo] = match;

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

  const entries: {
    storyIndex: number;
    storyTitle: string;
    title: string;
    body: string;
  }[] = [];

  for (const storyCriteria of criteria.stories) {
    const story = decomposition.stories[storyCriteria.storyIndex];
    if (story === undefined) {
      return {
        ok: false,
        error: `criteria set ${report.criteriaId} references unknown story index ${storyCriteria.storyIndex}`,
      };
    }
    entries.push({
      storyIndex: storyCriteria.storyIndex,
      storyTitle: storyCriteria.storyTitle,
      title: storyCriteria.storyTitle,
      body: renderIssueBody(report, story, storyCriteria),
    });
  }

  entries.sort((a, b) => a.storyIndex - b.storyIndex);

  try {
    const existing = await client.listIssues(owner, repo);
    const markerToIssue = new Map<string, number>();
    for (const issue of existing) {
      if (issue.body === null) {
        continue;
      }
      for (const entry of entries) {
        const marker = storyMarker(report.id, entry.storyIndex);
        if (issue.body.includes(marker)) {
          markerToIssue.set(marker, issue.number);
        }
      }
    }

    const created: ExportedIssue[] = [];
    const skipped: SkippedStory[] = [];

    for (const entry of entries) {
      const marker = storyMarker(report.id, entry.storyIndex);
      const existingIssueNumber = markerToIssue.get(marker);
      if (existingIssueNumber !== undefined) {
        skipped.push({
          storyIndex: entry.storyIndex,
          storyTitle: entry.storyTitle,
          issueNumber: existingIssueNumber,
        });
        continue;
      }
      const issue = await client.createIssue(owner, repo, entry.title, entry.body);
      created.push({
        storyIndex: entry.storyIndex,
        storyTitle: entry.storyTitle,
        issueNumber: issue.number,
        url: issue.htmlUrl,
      });
    }

    return { ok: true, created, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `github export to ${ownerRepo} failed: ${message}` };
  }
}

export interface GitHubClientOptions {
  readonly token: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

const listIssuesItemSchema = z.object({
  number: z.number().int(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const listIssuesResponseSchema = z.array(listIssuesItemSchema);

const createIssueResponseSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
});

/** Zero-dependency `fetch` adapter for the GitHub Issues REST API. */
export function createGitHubIssueClient(options: GitHubClientOptions): GitHubIssueClient {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = 'https://api.github.com';
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'product-factory',
  };

  return {
    async listIssues(owner: string, repo: string): Promise<readonly ExistingIssue[]> {
      const issues: ExistingIssue[] = [];
      let page = 1;
      for (;;) {
        const response = await fetchFn(
          `${baseUrl}/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
          { method: 'GET', headers },
        );
        if (!response.ok) {
          throw new Error(`github API error: ${response.status}`);
        }
        const body: unknown = await response.json();
        const result = listIssuesResponseSchema.safeParse(body);
        if (!result.success) {
          throw new Error('github API returned an unexpected issue list payload');
        }
        const pageItems = result.data.filter((item) => item.pull_request === undefined);
        issues.push(...pageItems.map((item) => ({ number: item.number, body: item.body ?? null })));
        if (result.data.length < 100) {
          break;
        }
        page += 1;
      }
      return issues;
    },

    async createIssue(
      owner: string,
      repo: string,
      title: string,
      body: string,
    ): Promise<CreatedIssue> {
      const response = await fetchFn(`${baseUrl}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      if (!response.ok) {
        throw new Error(`github API error: ${response.status}`);
      }
      const responseBody: unknown = await response.json();
      const result = createIssueResponseSchema.safeParse(responseBody);
      if (!result.success) {
        throw new Error('github API returned an unexpected created-issue payload');
      }
      return { number: result.data.number, htmlUrl: result.data.html_url };
    },
  };
}
