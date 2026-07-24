/**
 * Human gate #2 — approval marker for a readiness report. The marker is a
 * sidecar file (never a report mutation) because the report id is
 * content-derived.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { REPORTS_DIR } from './report.js';

/** Suffix of the sidecar approval file stored next to the report artifact. */
export const REPORT_APPROVAL_SUFFIX = '.approval.json';

/** The recorded approval of a readiness report (human gate #2). */
export interface ReportApproval {
  readonly reportId: string;
  readonly approvedBy: string;
  readonly approvedAt: string; // ISO 8601
}

export type ApproveReportResult =
  | {
      readonly ok: true;
      readonly approval: ReportApproval;
      readonly approvalPath: string;
      /** True when the report was already approved; existing marker is preserved. */
      readonly alreadyApproved: boolean;
    }
  | { readonly ok: false; readonly error: string };

export type LoadReportApprovalResult =
  | { readonly ok: true; readonly approval: ReportApproval; readonly approvalPath: string }
  | { readonly ok: false; readonly error: string };

const approvalSchema = z.object({
  reportId: z.string().regex(/^[0-9a-f]{12}$/),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
});

function approvalPath(targetDir: string, reportId: string): string {
  return join(targetDir, WORKSPACE_DIR, REPORTS_DIR, `${reportId}${REPORT_APPROVAL_SUFFIX}`);
}

/**
 * Record approval of a readiness report (human gate #2). Idempotent:
 * re-approving an already-approved report preserves the original approver
 * and timestamp.
 */
export function approveReport(
  targetDir: string,
  reportId: string,
  approvedBy: string,
): ApproveReportResult {
  if (approvedBy.trim() === '') {
    return { ok: false, error: 'approver must not be empty' };
  }

  if (
    !/^[0-9a-f]{12}$/.test(reportId) ||
    !existsSync(join(targetDir, WORKSPACE_DIR, REPORTS_DIR, `${reportId}.md`))
  ) {
    return { ok: false, error: `readiness report ${reportId} not found` };
  }

  const approval: ReportApproval = {
    reportId,
    approvedBy: approvedBy.trim(),
    approvedAt: new Date().toISOString(),
  };
  const path = approvalPath(targetDir, reportId);

  // Exclusive create, not check-then-write: two concurrent approvers racing
  // loadReportApproval would otherwise both see "unapproved" and the second
  // write would silently clobber the first, breaking "first approver wins".
  try {
    writeFileSync(path, `${JSON.stringify(approval, null, 2)}\n`, { flag: 'wx' });
    return { ok: true, approval, approvalPath: path, alreadyApproved: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `unable to write approval for readiness report ${reportId}: ${message}`,
      };
    }
  }

  const existing = loadReportApproval(targetDir, reportId);
  if (!existing.ok) {
    return existing;
  }
  return {
    ok: true,
    approval: existing.approval,
    approvalPath: existing.approvalPath,
    alreadyApproved: true,
  };
}

/** Load the approval marker for a readiness report, if one exists. */
export function loadReportApproval(targetDir: string, reportId: string): LoadReportApprovalResult {
  if (!/^[0-9a-f]{12}$/.test(reportId)) {
    return { ok: false, error: `readiness report ${reportId} is not approved` };
  }

  const path = approvalPath(targetDir, reportId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `readiness report ${reportId} is not approved` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `unable to read approval for readiness report ${reportId}: ${message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `approval for readiness report ${reportId} is not a valid approval marker`,
    };
  }

  const result = approvalSchema.safeParse(parsed);
  if (!result.success || result.data.reportId !== reportId) {
    return {
      ok: false,
      error: `approval for readiness report ${reportId} is not a valid approval marker`,
    };
  }

  return { ok: true, approval: result.data, approvalPath: path };
}

/** Whether a readiness report has a recorded approval marker (human gate #2). */
export function isReportApproved(targetDir: string, reportId: string): boolean {
  return loadReportApproval(targetDir, reportId).ok;
}
