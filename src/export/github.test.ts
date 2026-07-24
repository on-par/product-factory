import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  storyMarker,
  renderIssueBody,
  exportGitHub,
  createGitHubIssueClient,
  type GitHubIssueClient,
  type ExistingIssue,
} from './github.js';
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

describe('storyMarker', () => {
  it('formats a machine-readable marker for a report + story index', () => {
    expect(storyMarker('ridridridrid', 0)).toBe('<!-- pf-story:ridridridrid:0 -->');
    expect(storyMarker('ridridridrid', 3)).toBe('<!-- pf-story:ridridridrid:3 -->');
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

describe('renderIssueBody', () => {
  it('renders the story sentence, gherkin fence, traces-to ids, lineage, and marker with no H1', () => {
    const story = {
      title: 'Export CSV',
      asA: 'PM',
      iWant: 'to export stories as CSV',
      soThat: 'I can share them',
      tracesTo: ['INT-001', 'INT-003'],
    };
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

    const body = renderIssueBody(BASE_REPORT, story, criteria);

    expect(body).not.toContain('# Story:');
    expect(body).toContain('As a PM, I want to export stories as CSV, so that I can share them.');
    expect(body).toContain('```gherkin');
    expect(body).toContain(renderScenario(criteria.scenarios[0]));
    expect(body).toContain('Traces to: INT-001, INT-003');
    expect(body).toContain(`Report: \`${BASE_REPORT.id}\``);
    expect(body).toContain(`Criteria set: \`${BASE_REPORT.criteriaId}\``);
    expect(body).toContain(`Decomposition: \`${BASE_REPORT.decompositionId}\``);
    expect(body).toContain(`Intent doc: \`${BASE_REPORT.intentId}\``);
    expect(body).toContain(storyMarker(BASE_REPORT.id, 0));
  });

  it('widens the code fence when scenario text contains a triple backtick', () => {
    const story = {
      title: 'Export CSV',
      asA: 'PM',
      iWant: 'to export stories as CSV',
      soThat: 'I can share them',
      tracesTo: ['INT-001'],
    };
    const criteria = {
      storyIndex: 0,
      storyTitle: 'Export CSV',
      tracesTo: ['INT-001'],
      scenarios: [
        {
          name: 'Quotes a code block',
          given: ['a step that quotes ```json { "a": 1 } ``` inline'],
          when: ['they export it'],
          then: ['the fence still wraps the whole scenario'],
        },
      ],
      readinessFlags: [],
    };

    const body = renderIssueBody(BASE_REPORT, story, criteria);

    expect(body).toContain('````gherkin');
    expect(body).not.toMatch(/^```gherkin$/m);
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

/** In-memory fake GitHubIssueClient — records createIssue calls, returns increasing issue numbers. */
function fakeClient(listIssuesResult: readonly ExistingIssue[] = []): GitHubIssueClient & {
  createCalls: { owner: string; repo: string; title: string; body: string }[];
} {
  let nextNumber = 100;
  const createCalls: { owner: string; repo: string; title: string; body: string }[] = [];
  return {
    createCalls,
    async listIssues() {
      return listIssuesResult;
    },
    async createIssue(owner, repo, title, body) {
      createCalls.push({ owner, repo, title, body });
      const number = nextNumber;
      nextNumber += 1;
      return { number, htmlUrl: `https://github.com/${owner}/${repo}/issues/${number}` };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-export-github-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('exportGitHub', () => {
  it('creates one issue per story for an approved report against an empty repo', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([]);

    const result = await exportGitHub(dir, report.id, 'acme/widgets', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.created.length).toBe(2);
    expect(result.created.map((c) => c.storyIndex)).toEqual([0, 1]);
    expect(result.created[0].storyTitle).toBe('Export CSV');
    expect(result.created[1].storyTitle).toBe('Export JSON');
    expect(result.skipped).toEqual([]);

    expect(client.createCalls.length).toBe(2);
    expect(client.createCalls[0].body).toContain('```gherkin');
    expect(client.createCalls[0].body).toContain('Traces to: INT-001, INT-003');
    expect(client.createCalls[0].body).toContain(storyMarker(report.id, 0));
    expect(client.createCalls[1].body).toContain(storyMarker(report.id, 1));
  });

  it('re-run: skips every story whose marker already exists, creating nothing', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      { number: 5, body: `something\n${storyMarker(report.id, 0)}\nmore` },
      { number: 6, body: `something\n${storyMarker(report.id, 1)}\nmore` },
    ]);

    const result = await exportGitHub(dir, report.id, 'acme/widgets', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped).toEqual([
      { storyIndex: 0, storyTitle: 'Export CSV', issueNumber: 5 },
      { storyIndex: 1, storyTitle: 'Export JSON', issueNumber: 6 },
    ]);
    expect(client.createCalls.length).toBe(0);
  });

  it('partial: creates only the story whose marker is missing', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      { number: 5, body: `something\n${storyMarker(report.id, 0)}\nmore` },
    ]);

    const result = await exportGitHub(dir, report.id, 'acme/widgets', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.skipped).toEqual([{ storyIndex: 0, storyTitle: 'Export CSV', issueNumber: 5 }]);
    expect(result.created.length).toBe(1);
    expect(result.created[0].storyIndex).toBe(1);
    expect(client.createCalls.length).toBe(1);
  });

  it('creates both stories when the only existing marker belongs to a different report id', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([
      { number: 5, body: `something\n${storyMarker('deadbeefdead', 0)}\nmore` },
    ]);

    const result = await exportGitHub(dir, report.id, 'acme/widgets', client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
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

    const result = await exportGitHub(dir, built.report.id, 'acme/widgets', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not approved');
    expect(result.error).toContain('human gate #2');
    expect(client.createCalls.length).toBe(0);
  });

  it('rejects an invalid owner/repo, making zero client calls', async () => {
    const { report } = await seedApprovedReport(dir);
    const client = fakeClient([]);

    const result = await exportGitHub(dir, report.id, 'no-slash', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('invalid repository');
    expect(client.createCalls.length).toBe(0);
  });

  it('wraps a listIssues throw as a github export failure, creating nothing', async () => {
    const { report } = await seedApprovedReport(dir);
    const client: GitHubIssueClient = {
      listIssues: async () => {
        throw new Error('network down');
      },
      createIssue: async () => {
        throw new Error('should not be called');
      },
    };

    const result = await exportGitHub(dir, report.id, 'acme/widgets', client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('github export');
    expect(result.error).toContain('network down');
  });

  it('rejects a garbage report id', async () => {
    const client = fakeClient([]);
    const result = await exportGitHub(dir, 'zzz', 'acme/widgets', client);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
  });

  it('rejects a well-formed but absent report id', async () => {
    const client = fakeClient([]);
    const result = await exportGitHub(dir, 'ffffffffffff', 'acme/widgets', client);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
  });
});

describe('createGitHubIssueClient', () => {
  it('listIssues sends auth headers, paginates, maps fields, and filters out PRs', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const page = new URL(String(url)).searchParams.get('page');
      if (page === '1') {
        const withPr = [
          ...Array.from({ length: 99 }, (_, i) => ({ number: i + 1, body: `body ${i + 1}` })),
          { number: 999, body: 'a pr', pull_request: {} },
        ];
        return new Response(JSON.stringify(withPr), { status: 200 });
      }
      return new Response(JSON.stringify([{ number: 200, body: null }]), { status: 200 });
    };

    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    const issues = await client.listIssues('acme', 'widgets');

    expect(calls[0].url).toBe(
      'https://api.github.com/repos/acme/widgets/issues?state=all&per_page=100&page=1',
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer gh-test');
    expect(headers['x-github-api-version']).toBe('2022-11-28');

    expect(calls.length).toBe(2);
    expect(calls[1].url).toContain('page=2');

    expect(issues.some((i) => i.number === 999)).toBe(false);
    expect(issues.find((i) => i.number === 1)?.body).toBe('body 1');
    expect(issues.find((i) => i.number === 200)?.body).toBeNull();
  });

  it('listIssues throws github API error on non-OK response', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 500 });
    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    await expect(client.listIssues('acme', 'widgets')).rejects.toThrow('github API error: 500');
  });

  it('listIssues throws on a malformed payload', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ not: 'an array' }), { status: 200 });
    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    await expect(client.listIssues('acme', 'widgets')).rejects.toThrow(
      'unexpected issue list payload',
    );
  });

  it('createIssue posts title/body JSON and returns number + htmlUrl', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/acme/widgets/issues/42' }),
        { status: 201 },
      );
    };

    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    const issue = await client.createIssue('acme', 'widgets', 'My Title', 'My Body');

    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/issues');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer gh-test');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({ title: 'My Title', body: 'My Body' });
    expect(issue).toEqual({ number: 42, htmlUrl: 'https://github.com/acme/widgets/issues/42' });
  });

  it('createIssue throws github API error on non-OK response', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 422 });
    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    await expect(client.createIssue('acme', 'widgets', 't', 'b')).rejects.toThrow(
      'github API error: 422',
    );
  });

  it('createIssue throws on a malformed payload', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 });
    const client = createGitHubIssueClient({ token: 'gh-test', fetchFn });
    await expect(client.createIssue('acme', 'widgets', 't', 'b')).rejects.toThrow(
      'unexpected created-issue payload',
    );
  });
});
