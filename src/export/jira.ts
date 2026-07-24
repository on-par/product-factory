/**
 * Jira export stage — creates a Jira epic and one linked Jira story per
 * story from an approved readiness report. Refuses unapproved reports
 * (human gate #2). Idempotent: the epic and any story whose traceability
 * marker already appears in an existing issue's description are skipped
 * and reused rather than recreated. Field-level customization per Jira
 * instance is out of scope — stories link to the epic via the standard
 * `parent` field.
 */

import { z } from 'zod';
import { loadReport, type ReadinessReport } from '../report/report.js';
import { loadReportApproval } from '../report/approve.js';
import { loadCriteria, renderScenario, type StoryCriteria } from '../criteria/criteria.js';
import { loadDecomposition, storySentence, type Epic } from '../decompose/decompose.js';

/**
 * Jira project keys are short alphanumeric identifiers starting with a
 * letter. Enforced both by exportJira (a friendly refusal) and by the
 * client (a thrown error) so a project key can never reach the JQL string
 * `listIssues` builds, regardless of call path.
 */
const JIRA_PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** Machine-readable marker embedded in the epic description; the epic idempotency key. */
export function jiraEpicMarker(reportId: string): string {
  return `<!-- pf-epic:${reportId} -->`;
}

/** Machine-readable marker embedded in each story description; the story idempotency key. */
export function jiraStoryMarker(reportId: string, storyIndex: number): string {
  return `<!-- pf-story:${reportId}:${storyIndex} -->`;
}

/** A single node in an Atlassian Document Format tree — as much as this exporter needs. */
export interface JiraDocNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly JiraDocNode[];
}

/** Top-level Atlassian Document Format document, used for Jira `description` fields. */
export interface JiraDoc {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly JiraDocNode[];
}

function paragraph(text: string): JiraDocNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function heading(level: number, text: string): JiraDocNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function codeBlock(text: string): JiraDocNode {
  return { type: 'codeBlock', content: [{ type: 'text', text }] };
}

function bulletList(items: readonly string[]): JiraDocNode {
  return {
    type: 'bulletList',
    content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
  };
}

/** Flatten an ADF node tree (or any unknown payload) into plain text, for marker scanning. */
export function extractAdfText(node: unknown): string {
  if (node === null || typeof node !== 'object') {
    return '';
  }
  const record = node as Record<string, unknown>;
  let out = '';
  if (typeof record.text === 'string') {
    out += record.text;
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) {
      out += extractAdfText(child);
      out += '\n';
    }
  }
  return out;
}

/** Render the Jira epic description — pure. */
export function renderEpicDescription(report: ReadinessReport, epic: Epic): JiraDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(epic.summary),
      heading(2, 'Traceability'),
      bulletList([
        `Report: ${report.id}`,
        `Verdict set: ${report.verdictId}`,
        `Criteria set: ${report.criteriaId}`,
        `Decomposition: ${report.decompositionId}`,
        `Intent doc: ${report.intentId}`,
      ]),
      paragraph(jiraEpicMarker(report.id)),
    ],
  };
}

/** Render one story's Jira description — pure. */
export function renderStoryDescription(
  report: ReadinessReport,
  storySentenceText: string,
  criteria: StoryCriteria,
): JiraDoc {
  const content: JiraDocNode[] = [
    heading(2, 'User story'),
    paragraph(storySentenceText),
    heading(2, 'Acceptance criteria'),
  ];

  for (const scenario of criteria.scenarios) {
    content.push(codeBlock(renderScenario(scenario)));
  }

  content.push(
    heading(2, 'Traceability'),
    bulletList([
      `Traces to: ${criteria.tracesTo.join(', ')}`,
      `Report: ${report.id}`,
      `Criteria set: ${report.criteriaId}`,
      `Decomposition: ${report.decompositionId}`,
      `Intent doc: ${report.intentId}`,
    ]),
    paragraph(jiraStoryMarker(report.id, criteria.storyIndex)),
  );

  return { type: 'doc', version: 1, content };
}

/** An existing issue in the target Jira project, as much as the exporter needs. */
export interface ExistingJiraIssue {
  readonly key: string;
  readonly url: string;
  readonly descriptionText: string;
}

export interface CreateJiraIssueInput {
  readonly projectKey: string;
  readonly issueType: 'Epic' | 'Story';
  readonly summary: string;
  readonly description: JiraDoc;
  /** Links a story to its epic via the standard `parent` field. */
  readonly parentKey?: string;
}

export interface CreatedJiraIssue {
  readonly key: string;
  readonly url: string;
}

/** Narrow Jira API surface, injectable so tests never hit the network. */
export interface JiraIssueClient {
  /** Every issue in the project, for marker scanning. */
  listIssues(projectKey: string): Promise<readonly ExistingJiraIssue[]>;
  createIssue(input: CreateJiraIssueInput): Promise<CreatedJiraIssue>;
}

export interface JiraEpicResult {
  readonly issueKey: string;
  readonly url: string;
  /** False when an existing epic (matched by marker) was reused instead of created. */
  readonly created: boolean;
}

export interface CreatedJiraStory {
  readonly storyIndex: number;
  readonly storyTitle: string;
  readonly issueKey: string;
  readonly url: string;
}

export interface SkippedJiraStory {
  readonly storyIndex: number;
  readonly storyTitle: string;
  /** Key of the pre-existing issue whose description carries this story's marker. */
  readonly issueKey: string;
}

export type ExportJiraResult =
  | {
      readonly ok: true;
      readonly epic: JiraEpicResult;
      readonly created: readonly CreatedJiraStory[];
      readonly skipped: readonly SkippedJiraStory[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Export an approved readiness report as a Jira epic and one linked Jira
 * story per story. Refuses when the report has no approval marker.
 * Idempotent: re-running reuses the epic and skips any story whose marker
 * already appears in an existing issue's description in the target project.
 */
export async function exportJira(
  targetDir: string,
  reportId: string,
  projectKey: string,
  client: JiraIssueClient,
): Promise<ExportJiraResult> {
  if (!JIRA_PROJECT_KEY_PATTERN.test(projectKey)) {
    return {
      ok: false,
      error: `invalid project key ${projectKey}: expected a Jira project key like "PROJ"`,
    };
  }

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
    description: JiraDoc;
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
      description: renderStoryDescription(report, storySentence(story), storyCriteria),
    });
  }

  entries.sort((a, b) => a.storyIndex - b.storyIndex);

  try {
    const existing = await client.listIssues(projectKey);

    const epicMarker = jiraEpicMarker(report.id);
    const existingEpic = existing.find((issue) => issue.descriptionText.includes(epicMarker));

    let epic: JiraEpicResult;
    if (existingEpic !== undefined) {
      epic = { issueKey: existingEpic.key, url: existingEpic.url, created: false };
    } else {
      const created = await client.createIssue({
        projectKey,
        issueType: 'Epic',
        summary: decomposition.epic.title,
        description: renderEpicDescription(report, decomposition.epic),
      });
      epic = { issueKey: created.key, url: created.url, created: true };
    }

    const createdStories: CreatedJiraStory[] = [];
    const skipped: SkippedJiraStory[] = [];

    for (const entry of entries) {
      const marker = jiraStoryMarker(report.id, entry.storyIndex);
      const existingIssue = existing.find((issue) => issue.descriptionText.includes(marker));
      if (existingIssue !== undefined) {
        skipped.push({
          storyIndex: entry.storyIndex,
          storyTitle: entry.storyTitle,
          issueKey: existingIssue.key,
        });
        continue;
      }
      const issue = await client.createIssue({
        projectKey,
        issueType: 'Story',
        summary: entry.storyTitle,
        description: entry.description,
        parentKey: epic.issueKey,
      });
      createdStories.push({
        storyIndex: entry.storyIndex,
        storyTitle: entry.storyTitle,
        issueKey: issue.key,
        url: issue.url,
      });
    }

    return { ok: true, epic, created: createdStories, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `jira export to ${projectKey} failed: ${message}` };
  }
}

export interface JiraClientOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

const searchIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    description: z.unknown().nullable().optional(),
  }),
});
const searchResponseSchema = z.object({
  issues: z.array(searchIssueSchema),
  total: z.number().int(),
});

const createIssueResponseSchema = z.object({
  key: z.string(),
});

/** Zero-dependency `fetch` adapter for the Jira Cloud REST API (v3). */
export function createJiraIssueClient(options: JiraClientOptions): JiraIssueClient {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${options.email}:${options.apiToken}`).toString('base64');
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Basic ${auth}`,
  };

  return {
    async listIssues(projectKey: string): Promise<readonly ExistingJiraIssue[]> {
      if (!JIRA_PROJECT_KEY_PATTERN.test(projectKey)) {
        throw new Error(
          `invalid project key ${projectKey}: expected a Jira project key like "PROJ"`,
        );
      }
      const issues: ExistingJiraIssue[] = [];
      let startAt = 0;
      for (;;) {
        const response = await fetchFn(`${baseUrl}/rest/api/3/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jql: `project = "${projectKey}" ORDER BY created ASC`,
            fields: ['description'],
            startAt,
            maxResults: 100,
          }),
        });
        if (!response.ok) {
          throw new Error(`jira API error: ${response.status}`);
        }
        const body: unknown = await response.json();
        const result = searchResponseSchema.safeParse(body);
        if (!result.success) {
          throw new Error('jira API returned an unexpected search payload');
        }
        for (const issue of result.data.issues) {
          issues.push({
            key: issue.key,
            url: `${baseUrl}/browse/${issue.key}`,
            descriptionText: extractAdfText(issue.fields.description ?? null),
          });
        }
        startAt += result.data.issues.length;
        if (result.data.issues.length === 0 || startAt >= result.data.total) {
          break;
        }
      }
      return issues;
    },

    async createIssue(input: CreateJiraIssueInput): Promise<CreatedJiraIssue> {
      const fields: Record<string, unknown> = {
        project: { key: input.projectKey },
        issuetype: { name: input.issueType },
        summary: input.summary,
        description: input.description,
      };
      if (input.parentKey !== undefined) {
        fields.parent = { key: input.parentKey };
      }
      const response = await fetchFn(`${baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields }),
      });
      if (!response.ok) {
        throw new Error(`jira API error: ${response.status}`);
      }
      const responseBody: unknown = await response.json();
      const result = createIssueResponseSchema.safeParse(responseBody);
      if (!result.success) {
        throw new Error('jira API returned an unexpected created-issue payload');
      }
      return { key: result.data.key, url: `${baseUrl}/browse/${result.data.key}` };
    },
  };
}
