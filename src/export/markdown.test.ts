import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slugify, renderEpicFile, renderStoryFile, exportMarkdown } from './markdown.js';
import {
  renderScenario,
  generateAcceptanceCriteria,
  CRITERIA_DIR,
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
import { buildReadinessReport, REPORTS_DIR, type ReadinessReport } from '../report/report.js';
import { approveReport } from '../report/approve.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Export CSV')).toBe('export-csv');
  });

  it('collapses punctuation and spaces to single hyphens', () => {
    expect(slugify('A  B! C')).toBe('a-b-c');
  });

  it('falls back to "untitled" for an all-symbols title', () => {
    expect(slugify('!!!')).toBe('untitled');
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

describe('renderStoryFile', () => {
  it('renders the story title, sentence, gherkin fence, and traces-to ids', () => {
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

    const markdown = renderStoryFile(BASE_REPORT, story, criteria);

    expect(markdown).toContain('# Story: Export CSV');
    expect(markdown).toContain(
      'As a PM, I want to export stories as CSV, so that I can share them.',
    );
    expect(markdown).toContain('```gherkin');
    expect(markdown).toContain(renderScenario(criteria.scenarios[0]));
    expect(markdown).toContain('Scenario: Export as CSV');
    expect(markdown).toContain('Given a PM has stories to export');
    expect(markdown).toContain('When they request a CSV export');
    expect(markdown).toContain('Then a CSV file is produced');
    expect(markdown).toContain('Traces to: INT-001, INT-003');
  });
});

describe('renderEpicFile', () => {
  it('lists epic title, summary, story links, and lineage ids', () => {
    const epic = { title: 'Exports epic', summary: 'Ship exports end to end' };
    const storyFiles = [
      {
        storyIndex: 1,
        storyTitle: 'Export JSON',
        fileName: 'story-1-export-json.md',
        tracesTo: ['INT-002'],
      },
      {
        storyIndex: 0,
        storyTitle: 'Export CSV',
        fileName: 'story-0-export-csv.md',
        tracesTo: ['INT-001', 'INT-003'],
      },
    ];

    const markdown = renderEpicFile(BASE_REPORT, epic, storyFiles);

    expect(markdown).toContain('# Epic: Exports epic');
    expect(markdown).toContain('Ship exports end to end');
    expect(markdown).toContain(
      '[Export CSV](./story-0-export-csv.md) (traces-to: INT-001, INT-003)',
    );
    expect(markdown).toContain('[Export JSON](./story-1-export-json.md) (traces-to: INT-002)');
    expect(markdown).toContain(`Report: \`${BASE_REPORT.id}\``);
    expect(markdown).toContain(`Verdict set: \`${BASE_REPORT.verdictId}\``);
    expect(markdown).toContain(`Criteria set: \`${BASE_REPORT.criteriaId}\``);
    expect(markdown).toContain(`Decomposition: \`${BASE_REPORT.decompositionId}\``);
    expect(markdown).toContain(`Intent doc: \`${BASE_REPORT.intentId}\``);
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('exportMarkdown', () => {
  it('writes an epic file and one file per story for an approved report', async () => {
    const { report } = await seedApprovedReport(dir);
    const outDir = join(dir, 'out');

    const result = exportMarkdown(dir, report.id, outDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.files.length).toBe(3);
    expect(result.outDir).toBe(outDir);
    expect(existsSync(join(outDir, 'epic.md'))).toBe(true);
    expect(existsSync(join(outDir, 'story-0-export-csv.md'))).toBe(true);
    expect(existsSync(join(outDir, 'story-1-export-json.md'))).toBe(true);

    const storyContent = readFileSync(join(outDir, 'story-0-export-csv.md'), 'utf8');
    expect(storyContent).toContain(
      'As a PM, I want to export stories as CSV, so that I can share them.',
    );
    expect(storyContent).toContain('```gherkin');
    expect(storyContent).toContain('Traces to: INT-001, INT-003');
  });

  it('refuses when the report is not approved, and writes nothing', async () => {
    const { criteria } = await seedCriteria(dir);
    const judged = await judgeStories(dir, criteria.id, judgeFakeCaller(JUDGE_PAYLOAD));
    if (!judged.ok) throw new Error('expected ok');
    const built = buildReadinessReport(dir, judged.verdicts.id);
    if (!built.ok) throw new Error('expected ok');
    const outDir = join(dir, 'out');

    const result = exportMarkdown(dir, built.report.id, outDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not approved');
    expect(result.error).toContain('human gate #2');
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a garbage report id', () => {
    const result = exportMarkdown(dir, 'zzz', join(dir, 'out'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('rejects a well-formed but absent report id', () => {
    const result = exportMarkdown(dir, 'ffffffffffff', join(dir, 'out'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('fails with "not found" when the approved report JSON sidecar is missing', async () => {
    const { report } = await seedApprovedReport(dir);
    const sidecar = join(dir, WORKSPACE_DIR, REPORTS_DIR, `${report.id}.json`);
    rmSync(sidecar);
    const outDir = join(dir, 'out');

    const result = exportMarkdown(dir, report.id, outDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not found');
    expect(existsSync(outDir)).toBe(false);
  });

  it('fails when criteria reference an out-of-range story index, writing nothing', async () => {
    const { report, criteria } = await seedApprovedReport(dir);
    const tampered = {
      ...criteria,
      stories: criteria.stories.map((s) => (s.storyIndex === 0 ? { ...s, storyIndex: 99 } : s)),
    };
    writeFileSync(
      join(dir, WORKSPACE_DIR, CRITERIA_DIR, `${criteria.id}.json`),
      `${JSON.stringify(tampered, null, 2)}\n`,
      'utf8',
    );
    const outDir = join(dir, 'out');

    const result = exportMarkdown(dir, report.id, outDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('unknown story index 99');
    expect(existsSync(outDir)).toBe(false);
  });
});
