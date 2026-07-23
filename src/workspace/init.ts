/**
 * Workspace initialization — creates the .pf/ directory that later pipeline
 * stages (intent doc, decomposer, judge, export) write their artifacts into.
 *
 * Deliberately minimal: a directory and an empty state file. The config
 * schema is a separate story; nothing here knows about engine stages.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the workspace directory created inside the target directory. */
export const WORKSPACE_DIR = '.pf';

/** Name of the state file created inside the workspace. */
export const STATE_FILE = 'state.json';

export interface InitWorkspaceResult {
  /** Absolute path to the .pf/ workspace directory. */
  readonly workspacePath: string;
  /** Absolute path to the state file inside the workspace. */
  readonly statePath: string;
  /** True if this call created the workspace; false if it already existed. */
  readonly created: boolean;
}

/**
 * Initialize a Product Factory workspace in `targetDir`.
 *
 * Creates `<targetDir>/.pf/` containing an empty state file (`state.json`
 * holding an empty JSON object). If the workspace directory already exists,
 * nothing is written — existing artifacts are left untouched and `created`
 * is false.
 */
export function initWorkspace(targetDir: string): InitWorkspaceResult {
  const workspacePath = join(targetDir, WORKSPACE_DIR);
  const statePath = join(workspacePath, STATE_FILE);

  if (existsSync(workspacePath)) {
    return { workspacePath, statePath, created: false };
  }

  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(statePath, '{}\n', 'utf8');
  return { workspacePath, statePath, created: true };
}
