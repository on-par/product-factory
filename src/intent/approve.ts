/**
 * Human gate #1 — approval marker for an intent doc. The marker is a sidecar
 * file (never a doc mutation) because the doc id is content-derived.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_DIR } from '../workspace/init.js';
import { INTENT_DIR, loadIntentDoc } from './build.js';

/** Suffix of the sidecar approval file stored next to the intent doc. */
export const APPROVAL_SUFFIX = '.approval.json';

/** The recorded approval of an intent doc (human gate #1). */
export interface IntentApproval {
  readonly intentId: string;
  readonly approvedBy: string;
  readonly approvedAt: string; // ISO 8601
}

export type ApproveIntentResult =
  | {
      readonly ok: true;
      readonly approval: IntentApproval;
      readonly approvalPath: string;
      /** True when the doc was already approved; existing marker is preserved. */
      readonly alreadyApproved: boolean;
    }
  | { readonly ok: false; readonly error: string };

export type LoadApprovalResult =
  | { readonly ok: true; readonly approval: IntentApproval; readonly approvalPath: string }
  | { readonly ok: false; readonly error: string };

const approvalSchema = z.object({
  intentId: z.string().regex(/^[0-9a-f]{12}$/),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
});

function approvalPath(targetDir: string, intentId: string): string {
  return join(targetDir, WORKSPACE_DIR, INTENT_DIR, `${intentId}${APPROVAL_SUFFIX}`);
}

/**
 * Record approval of an intent doc (human gate #1). Idempotent: re-approving
 * an already-approved doc preserves the original approver and timestamp.
 */
export function approveIntentDoc(
  targetDir: string,
  intentId: string,
  approvedBy: string,
): ApproveIntentResult {
  if (approvedBy.trim() === '') {
    return { ok: false, error: 'approver must not be empty' };
  }

  const docResult = loadIntentDoc(targetDir, intentId);
  if (!docResult.ok) {
    return { ok: false, error: docResult.error };
  }

  const approval: IntentApproval = {
    intentId,
    approvedBy: approvedBy.trim(),
    approvedAt: new Date().toISOString(),
  };
  const path = approvalPath(targetDir, intentId);

  // Exclusive create, not check-then-write: two concurrent approvers racing
  // loadIntentApproval would otherwise both see "unapproved" and the second
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
        error: `unable to write approval for intent doc ${intentId}: ${message}`,
      };
    }
  }

  const existing = loadIntentApproval(targetDir, intentId);
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

/** Load the approval marker for an intent doc, if one exists. */
export function loadIntentApproval(targetDir: string, intentId: string): LoadApprovalResult {
  if (!/^[0-9a-f]{12}$/.test(intentId)) {
    return { ok: false, error: `intent doc ${intentId} is not approved` };
  }

  const path = approvalPath(targetDir, intentId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `intent doc ${intentId} is not approved` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unable to read approval for intent doc ${intentId}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `approval for intent doc ${intentId} is not a valid approval marker`,
    };
  }

  const result = approvalSchema.safeParse(parsed);
  if (!result.success || result.data.intentId !== intentId) {
    return {
      ok: false,
      error: `approval for intent doc ${intentId} is not a valid approval marker`,
    };
  }

  return { ok: true, approval: result.data, approvalPath: path };
}

/** Whether an intent doc has a recorded approval marker (human gate #1). */
export function isIntentApproved(targetDir: string, intentId: string): boolean {
  return loadIntentApproval(targetDir, intentId).ok;
}
