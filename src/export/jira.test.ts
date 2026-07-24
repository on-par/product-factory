import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  jiraEpicMarker,
  jiraStoryMarker,
  renderEpicDescription,
  renderStoryDescription,
  extractAdfText,
  exportJira,
  createJiraIssueClient,
  type JiraIssueClient,
  type ExistingJiraIssue,
  type CreateJiraIssueInput,
} from './jira.js';
import {
  renderScenario,
  generateAcceptanceCriteria,
  type CriteriaModelCaller,
  type CriteriaSet,
} from '../criteria/criteria.js';
import {
  decomposeIntent,
  type Decomposition,
  type DecomposeModelCaller,
} from '../decompose/decompose.js';
import { saveIntentDoc, type IntentDoc } from '../intent/build.js';
import { approveIntentDoc } from '../intent/approve.js';
import { judgeStories, type JudgeModelCaller } from '../judge/judge.js';
import { buildReadinessReport, type ReadinessReport } from '../report/report.js';
import { approveReport } from '../report/approve.js';

describe('jiraEpicMarker', () => {
  it('formats a machine-readable marker for a report id', () => {
    expect(jiraEpicMarker('ridridridrid')).toBe('<!-- pf-epic:ridridridrid -->');
  });
});

describe('jiraStoryMarker', () => {
  it('formats a machine-readable marker for a report + story index', () => {
    expect(jiraStoryMarker('ridridridrid', 0)).toBe('<!-- pf-story:ridridridrid:0 -->');
    expect(jiraStoryMarker('ridridridrid', 3)).toBe('<!-- pf-story:ridridridrid:3 -->');
  });
});

const BASE_REPORT: ReadinessReport = {
  id: 'ridridridrid',
  verdictId: 'vidvidvidvid',
  criteriaId: 'cidcidcidcid',
  decompositionId: 'didcompdidco',
  intentId: 'intidintidid',
  createdAt: '2026-01-01T00:00:00.000Z',
  epicTitle: 'Exports epic',
  epicSummary: 'Ship exports end to end',
  stories: [],
  openQuestions: [],
};

describe('renderEpicDescription', () => {
  it('renders the epic summary, traceability, and marker as ADF', () => {
    const doc = renderEpicDescription(BASE_REPORT, {
      title: 'Exports epic',
      summary: 'Ship exports end to end',
    });

    expect(doc.type).toBe('doc');
    const text = extractAdfText(doc);
    expect(text).toContain('Ship exports end to end');
    expect(text).toContain(`Report: ${BASE_REPORT.id}`);
    expect(text).toContain(`Verdict set: ${BASE_REPORT.verdictId}`);
    expect(text).toContain(`Criteria set: ${BASE_REPORT.criteriaId}`);
    expect(text).toContain(`Decomposition: ${BASE_REPORT.decompositionId}`);
    expect(text).toContain(`Intent doc: ${BASE_REPORT.intentId}`);
    expect(text).toContain(jiraEpicMarker(BASE_REPORT.id));
  });
});

describe('renderStoryDescription', () => {
  it('renders the story sentence, gherkin scenario, traces-to ids, lineage, and marker as ADF', () => {
    const criteria = {
      storyIndex: 0,
      storyTitle: 'Export CSV',
      tracesTo: ['INT-001', 'INT-003'],
      scenarios: [
        {
          name: 'Export as CSV',
          given: ['a PM has stories to export'],
          when: ['they request a CSV export'],
          then: ['a CSV file is produced'],
        },
      ],
      readinessFlags: [],
    };

    const doc = renderStoryDescription(
      BASE_REPORT,
      'As a PM, I want to export stories as CSV, so that I can share them.',
      criteria,
    );

    const text = extractAdfText(doc);
    expect(text).toContain('As a PM, I want to export stories as CSV, so that I can share them.');
    expect(text).toContain(renderScenario(criteria.scenarios[0]));
    expect(text).toContain('Traces to: INT-001, INT-003');
    expect(text).toContain(`Report: ${BASE_REPORT.id}`);
    expect(text).toContain(`Criteria set: ${BASE_REPORT.criteriaId}`);
    expect(text).toContain(`Decomposition: ${BASE_REPORT.decompositionId}`);
    expect(text).toContain(`Intent doc: ${BASE_REPORT.intentId}`);
    expect(text).toContain(jiraStoryMarker(BASE_REPORT.id, 0));
  });
});

describe('extractAdfText', () => {
  it('returns empty string for null/non-object input', () => {
    expect(extractAdfText(null)).toBe('');
    expect(extractAdfText('not a node')).toBe('');
    expect(extractAdfText(undefined)).toBe('');
  });
});

const DOC: IntentDoc = {
  id: 'aaaaaaaaaaaa',
  interviewId: 'bbbbbbbbbbbb',
  transcriptId: 'cccccccccccc',
  createdAt: '2026-01-01T00:00:00.000Z',
  goal: 'Ship exports',
  actor: 'PM',
  constraints: ['deadline Q3'],
  statements: [
    { id: 'INT-001', text: 'Line one.', source: 'transcript' },
    { id: 'INT-002', text: 'Line two.', source: 'transcript' },
    { id: 'INT-003', text: 'Answer one.', source: 'answer', questionIndex: 0, question: 'Q?' },
  ],
};

const DECOMPOSE_PAYLOAD = {
  epic: { title: 'Exports epic', summary: 'Ship exports end to end' },
  stories: [
    {
      title: 'Export CSV',
      asA: 'PM',
      iWant: 'to export stories as CSV',
      soThat: 'I can share them',
      tracesTo: ['INT-001', 'INT-003'],
    },
    {
      title: 'Export JSON',
      asA: 'PM',
      iWant: 'to export as JSON',
      soThat: 'tools can ingest it',
      tracesTo: ['INT-002'],
    },
  ],
};

function seedApprovedDoc(dir: string): void {
  saveIntentDoc(dir, DOC);
  const r = approveIntentDoc(dir, DOC.id, 'tester');
  if (!r.ok) throw new Error('expected ok');
}

const decomposeFakeCaller = (payload: unknown): DecomposeModelCaller => {
  return async () => JSON.stringify(payload);
};

async function seedDecomposition(dir: string): Promise<Decomposition> {
  seedApprovedDoc(dir);
  const result = await decomposeIntent(dir, DOC.id, decomposeFakeCaller(DECOMPOSE_PAYLOAD));
  if (!result.ok) throw new Error('expected ok');
  return result.decomposition;
}

const criteriaFakeCaller = (payload: unknown): CriteriaModelCaller => {
  return async () => JSON.stringify(payload);
};

function goodCriteriaPayload() {
  return {
    stories: [
      {
        storyIndex: 0,
        scenarios: [
          {
            name: 'Export as CSV',
            given: ['a PM has stories to export'],
            when: ['they request a CSV export'],
            then: ['a CSV file is produced'],
          },
        ],
      },
      {
        storyIndex: 1,
        scenarios: [
          {
            name: 'Export as JSON',
            given: ['a PM has stories to export'],
            when: ['they request a JSON export'],
            then: ['a JSON file is produced'],
          },
        ],
      },
    ],
  };
}

async function seedCriteria(
  dir: string,
): Promise<{ decomposition: Decomposition; criteria: CriteriaSet }> {
  const decomposition = await seedDecomposition(dir);
  const result = await generateAcceptanceCriteria(
    dir,
    decomposition.id,
    criteriaFakeCaller(goodCriteriaPayload()),
  );
  if (!result.ok) throw new Error('expected ok');
  return { decomposition, criteria: result.criteria };
}

const judgeFakeCaller = (payload: unknown): JudgeModelCaller => {
  return async () => JSON.stringify(payload);
};

const JUDGE_PAYLOAD = {
  stories: [
    { storyIndex: 0, intentAlignmentScore: 0.8, reasons: ['does not deliver INT-003'] },
    { storyIndex: 1, intentAlignmentScore: 1, reasons: [] },
  ],
};

async function seedApprovedReport(
  dir: string,
): Promise<{ report: ReadinessReport; criteria: CriteriaSet; decomposition: Decomposition }> {
  const { decomposition, criteria } = await seedCriteria(dir);
  const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(JUDGE_PAYLOAD));
  if (!judged.ok) throw new Error('expected ok');
  const built = buildReadinessReport(dir, judged.verdicts.id);
  if (!built.ok) throw new Error('expected ok');
  const approved = approveReport(dir, built.report.id, 'tester');
  if (!approved.ok) throw new Error('expected ok');
  return { report: built.report, criteria, decomposition };
}

/** In-memory fake JiraIssueClient — records createIssue calls, returns increasing issue keys. */
function fakeClient(listIssuesResult: readonly ExistingJiraIssue[] = []): JiraIssueClient & {
  createCalls: CreateJiraIssueInput[];
} {
  let nextNumber = 100;
  const createCalls: CreateJiraIssueInput[] = [];
  return {
    createCalls,
    async listIssues() {
      return listIssuesResult;
    },
    async createIssue(input) {
      createCalls.push(input);
      const key = `PROJ-${nextNumber}`;
      nextNumber += 1;
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-export-jira-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('exportJira', () => {
  it('creates an epic and one story per story for an approved report against an empty project', async () => {
    const { report, decomposition } = await seedApprovedReport(dir);
    const client = fakeClient([]);

    const result = await exportJira(dir, report.id, 'PROJ', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.epic.created).toBe(true);
    expect(result.epic.issueKey).toBe('PROJ-100');
    expect(result.created.length).toBe(2);
    expect(result.created.map((c) => c.storyIndex)).toEqual([0, 1]);
    expect(result.created[0].storyTitle).toBe('Export CSV');
    expect(result.created[1].storyTitle).toBe('Export JSON');
    expect(result.skipped).toEqual([]);

    expect(client.createCalls.length).toBe(3);
    expect(client.createCalls[0].issueType).toBe('Epic');
    expect(client.createCalls[0].summary).toBe(decomposition.epic.title);
    expect(client.createCalls[0].parentKey).toBeUndefined();
    expect(extractAdfText(client.createCalls[0].description)).toContain(jiraEpicMarker(report.id));

    expect(client.createCalls[1].issueType).toBe('Story');
    expect(client.createCalls[1].parentKey).toBe('PROJ-100');
    expect(extractAdfText(client.createCalls[1].description)).toContain(
      jiraStoryMarker(report.id, 0),
    );
    expect(client.createCalls[2].parentKey).toBe('PROJ-100');
    expect(extractAdfText(client.createCalls[2].description)).toContain(
      jiraStoryMarker(report.id, 1),
    );
  });

  it('re-run: reuses the epic and skips every story whose marker already exists, creating nothing', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      {
        key: 'PROJ-1',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        descriptionText: jiraEpicMarker(report.id),
      },
      {
        key: 'PROJ-2',
        url: 'https://acme.atlassian.net/browse/PROJ-2',
        descriptionText: `x ${jiraStoryMarker(report.id, 0)} y`,
      },
      {
        key: 'PROJ-3',
        url: 'https://acme.atlassian.net/browse/PROJ-3',
        descriptionText: `x ${jiraStoryMarker(report.id, 1)} y`,
      },
    ]);

    const result = await exportJira(dir, report.id, 'PROJ', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.epic.created).toBe(false);
    expect(result.epic.issueKey).toBe('PROJ-1');
    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped).toEqual([
      { storyIndex: 0, storyTitle: 'Export CSV', issueKey: 'PROJ-2' },
      { storyIndex: 1, storyTitle: 'Export JSON', issueKey: 'PROJ-3' },
    ]);
    expect(client.createCalls.length).toBe(0);
  });

  it('partial: creates only the story whose marker is missing, reusing the existing epic', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      {
        key: 'PROJ-1',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        descriptionText: jiraEpicMarker(report.id),
      },
      {
        key: 'PROJ-2',
        url: 'https://acme.atlassian.net/browse/PROJ-2',
        descriptionText: jiraStoryMarker(report.id, 0),
      },
    ]);

    const result = await exportJira(dir, report.id, 'PROJ', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.epic.created).toBe(false);
    expect(result.skipped).toEqual([
      { storyIndex: 0, storyTitle: 'Export CSV', issueKey: 'PROJ-2' },
    ]);
    expect(result.created.length).toBe(1);
    expect(result.created[0].storyIndex).toBe(1);
    expect(client.createCalls.length).toBe(1);
    expect(client.createCalls[0].parentKey).toBe('PROJ-1');
  });

  it('creates a new epic and both stories when the only existing marker belongs to a different report id', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      {
        key: 'PROJ-1',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        descriptionText: jiraEpicMarker('deadbeefdead'),
      },
    ]);

    const result = await exportJira(dir, report.id, 'PROJ', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.epic.created).toBe(true);
    expect(result.created.length).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('refuses an unapproved report, making zero client calls', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    const built = buildReadinessReport(dir, judged.verdicts.id);
    if (!built.ok) throw new Error('expected ok');
    const client = fakeClient([]);

    const result = await exportJira(dir, built.report.id, 'PROJ', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not approved');
    expect(result.error).toContain('human gate #2');
    expect(client.createCalls.length).toBe(0);
  });

  it('rejects an invalid project key, making zero client calls', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([]);

    const result = await exportJira(dir, report.id, 'not a key!', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('invalid project key');
    expect(client.createCalls.length).toBe(0);
  });

  it('wraps a listIssues throw as a jira export failure, creating nothing', async () => {
    const { report } = await seedApprovedReport(dir);
    const client: JiraIssueClient = {
      listIssues: async () => {
        throw new Error('network down');
      },
      createIssue: async () => {
        throw new Error('should not be called');
      },
    };

    const result = await exportJira(dir, report.id, 'PROJ', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('jira export');
    expect(result.error).toContain('network down');
  });

  it('rejects a garbage report id', async () => {
    const client = fakeClient([]);
    const result = await exportJira(dir, 'zzz', 'PROJ', client);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
  });

  it('rejects a well-formed but absent report id', async () => {
    const client = fakeClient([]);
    const result = await exportJira(dir, 'ffffffffffff', 'PROJ', client);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
  });
});

describe('createJiraIssueClient', () => {
  it('listIssues rejects an invalid project key without making a network call, so a JQL-breaking key can never reach the search body', async () => {
    let called = false;
    const fetchFn: typeof fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 });
    };
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await expect(client.listIssues('PROJ" OR project is not EMPTY --')).rejects.toThrow(
      'invalid project key',
    );
    expect(called).toBe(false);
  });

  it('listIssues sends basic auth headers, paginates, and extracts description text', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {};
      if (body.startAt === 0) {
        const issues = Array.from({ length: 100 }, (_, i) => ({
          key: `PROJ-${i + 1}`,
          fields: {
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `body ${i + 1}` }] }],
            },
          },
        }));
        return new Response(JSON.stringify({ issues, total: 101 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          issues: [{ key: 'PROJ-101', fields: { description: null } }],
          total: 101,
        }),
        { status: 200 },
      );
    };

    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    const issues = await client.listIssues('PROJ');

    expect(calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/search');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('pm@acme.com:jira-test').toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/json');
    const firstBody = JSON.parse(String(calls[0].init?.body));
    expect(firstBody.jql).toBe('project = "PROJ" ORDER BY created ASC');

    expect(calls.length).toBe(2);
    const secondBody = JSON.parse(String(calls[1].init?.body));
    expect(secondBody.startAt).toBe(100);

    expect(issues.length).toBe(101);
    expect(issues.find((i) => i.key === 'PROJ-1')?.descriptionText).toContain('body 1');
    expect(issues.find((i) => i.key === 'PROJ-1')?.url).toBe(
      'https://acme.atlassian.net/browse/PROJ-1',
    );
    expect(issues.find((i) => i.key === 'PROJ-101')?.descriptionText).toBe('');
  });

  it('listIssues strips trailing slashes from baseUrl', async () => {
    const fetchFn: typeof fetch = async (url) => {
      expect(String(url)).toBe('https://acme.atlassian.net/rest/api/3/search');
      return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 });
    };
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net/',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await client.listIssues('PROJ');
  });

  it('listIssues throws jira API error on non-OK response', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 500 });
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await expect(client.listIssues('PROJ')).rejects.toThrow('jira API error: 500');
  });

  it('listIssues throws on a malformed payload', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ not: 'the shape' }), { status: 200 });
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await expect(client.listIssues('PROJ')).rejects.toThrow('unexpected search payload');
  });

  it('createIssue posts project/issuetype/summary/description/parent JSON and returns key + url', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ key: 'PROJ-42' }), { status: 201 });
    };

    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    const description = { type: 'doc' as const, version: 1 as const, content: [] };
    const issue = await client.createIssue({
      projectKey: 'PROJ',
      issueType: 'Story',
      summary: 'My Story',
      description,
      parentKey: 'PROJ-1',
    });

    expect(capturedUrl).toBe('https://acme.atlassian.net/rest/api/3/issue');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('pm@acme.com:jira-test').toString('base64')}`,
    );
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      fields: {
        project: { key: 'PROJ' },
        issuetype: { name: 'Story' },
        summary: 'My Story',
        description,
        parent: { key: 'PROJ-1' },
      },
    });
    expect(issue).toEqual({ key: 'PROJ-42', url: 'https://acme.atlassian.net/browse/PROJ-42' });
  });

  it('createIssue omits parent when parentKey is absent', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ key: 'PROJ-1' }), { status: 201 });
    };
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await client.createIssue({
      projectKey: 'PROJ',
      issueType: 'Epic',
      summary: 'My Epic',
      description: { type: 'doc', version: 1, content: [] },
    });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.fields.parent).toBeUndefined();
  });

  it('createIssue throws jira API error on non-OK response', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 422 });
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await expect(
      client.createIssue({
        projectKey: 'PROJ',
        issueType: 'Story',
        summary: 't',
        description: { type: 'doc', version: 1, content: [] },
      }),
    ).rejects.toThrow('jira API error: 422');
  });

  it('createIssue throws on a malformed payload', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 });
    const client = createJiraIssueClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'jira-test',
      fetchFn,
    });
    await expect(
      client.createIssue({
        projectKey: 'PROJ',
        issueType: 'Story',
        summary: 't',
        description: { type: 'doc', version: 1, content: [] },
      }),
    ).rejects.toThrow('unexpected created-issue payload');
  });
});
