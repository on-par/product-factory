import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveReport, loadReportApproval, isReportApproved } from './approve.js';
import { REPORTS_DIR } from './report.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

const REPORT_ID = 'aaaaaaaaaaaa';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-report-approve-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedReport(targetDir: string, id: string = REPORT_ID): void {
  const reportsDir = join(targetDir, WORKSPACE_DIR, REPORTS_DIR);
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, `${id}.md`), '# Readiness report\n', 'utf8');
}

describe('approveReport', () => {
  it('approves an existing report', () => {
    seedReport(dir);

    const result = approveReport(dir, REPORT_ID, 'patrick');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.alreadyApproved).toBe(false);
    expect(result.approval.reportId).toBe(REPORT_ID);
    expect(result.approval.approvedBy).toBe('patrick');
    expect(result.approval.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const approvalPath = join(dir, WORKSPACE_DIR, REPORTS_DIR, `${REPORT_ID}.approval.json`);
    expect(result.approvalPath).toBe(approvalPath);
    expect(existsSync(approvalPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(approvalPath, 'utf8'));
    expect(parsed).toEqual(result.approval);
  });

  it('is idempotent and preserves the first approver', () => {
    seedReport(dir);

    const first = approveReport(dir, REPORT_ID, 'patrick');
    if (!first.ok) throw new Error('expected ok');

    const second = approveReport(dir, REPORT_ID, 'someone-else');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    expect(second.alreadyApproved).toBe(true);
    expect(second.approval.approvedBy).toBe('patrick');
    expect(second.approval.approvedAt).toBe(first.approval.approvedAt);
  });

  it('a concurrent winner is never clobbered by a racing approver (TOCTOU-safe write)', () => {
    seedReport(dir);

    // Simulate another process's approval landing between our existence
    // check and our write, by seeding the marker file before we ever call
    // approveReport.
    const reportsDir = join(dir, WORKSPACE_DIR, REPORTS_DIR);
    mkdirSync(reportsDir, { recursive: true });
    const winner = {
      reportId: REPORT_ID,
      approvedBy: 'first-approver',
      approvedAt: '2020-01-01T00:00:00.000Z',
    };
    writeFileSync(
      join(reportsDir, `${REPORT_ID}.approval.json`),
      JSON.stringify(winner, null, 2),
      'utf8',
    );

    const result = approveReport(dir, REPORT_ID, 'second-approver');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.alreadyApproved).toBe(true);
    expect(result.approval).toEqual(winner);
  });

  it('fails for a missing report', () => {
    const result = approveReport(dir, '0123456789ab', 'patrick');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('readiness report 0123456789ab not found');
  });

  it('fails for a malformed id', () => {
    const result = approveReport(dir, 'not-a-report-id', 'patrick');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toContain('not found');

    const reportsDir = join(dir, WORKSPACE_DIR, REPORTS_DIR);
    expect(existsSync(reportsDir)).toBe(false);
  });

  it('rejects an empty approver', () => {
    seedReport(dir);

    const result = approveReport(dir, REPORT_ID, '   ');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe('approver must not be empty');
  });
});

describe('loadReportApproval', () => {
  it('unapproved report returns not approved', () => {
    seedReport(dir);

    const result = loadReportApproval(dir, REPORT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(`readiness report ${REPORT_ID} is not approved`);
    expect(isReportApproved(dir, REPORT_ID)).toBe(false);
  });

  it('after approval round-trips the approval', () => {
    seedReport(dir);
    const approved = approveReport(dir, REPORT_ID, 'patrick');
    if (!approved.ok) throw new Error('expected ok');

    const result = loadReportApproval(dir, REPORT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.approval).toEqual(approved.approval);
    expect(result.approvalPath).toBe(approved.approvalPath);
    expect(isReportApproved(dir, REPORT_ID)).toBe(true);
  });

  it('rejects a corrupt marker', () => {
    seedReport(dir);
    const reportsDir = join(dir, WORKSPACE_DIR, REPORTS_DIR);
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, `${REPORT_ID}.approval.json`), 'not json', 'utf8');

    const result = loadReportApproval(dir, REPORT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(
      `approval for readiness report ${REPORT_ID} is not a valid approval marker`,
    );
  });

  it('rejects a marker whose reportId does not match the filename', () => {
    seedReport(dir);
    const otherReportId = 'bbbbbbbbbbbb';
    seedReport(dir, otherReportId);
    const reportsDir = join(dir, WORKSPACE_DIR, REPORTS_DIR);
    mkdirSync(reportsDir, { recursive: true });
    const mismatched = {
      reportId: otherReportId,
      approvedBy: 'patrick',
      approvedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(reportsDir, `${REPORT_ID}.approval.json`),
      JSON.stringify(mismatched, null, 2),
      'utf8',
    );

    const result = loadReportApproval(dir, REPORT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.error).toBe(
      `approval for readiness report ${REPORT_ID} is not a valid approval marker`,
    );
  });
});
