import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace, WORKSPACE_DIR, STATE_FILE } from './init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('initWorkspace', () => {
  it('creates the workspace in a fresh directory', () => {
    const result = initWorkspace(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, WORKSPACE_DIR))).toBe(true);
    expect(result.workspacePath).toBe(join(dir, WORKSPACE_DIR));
    expect(result.statePath).toBe(join(dir, WORKSPACE_DIR, STATE_FILE));
  });

  it('creates an empty state file', () => {
    const result = initWorkspace(dir);
    expect(existsSync(result.statePath)).toBe(true);
    const contents = readFileSync(result.statePath, 'utf8');
    expect(contents).toBe('{}\n');
    expect(JSON.parse(contents)).toEqual({});
  });

  it('returns created: false on re-init', () => {
    const first = initWorkspace(dir);
    const second = initWorkspace(dir);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.statePath).toBe(first.statePath);
  });

  it('leaves existing artifacts untouched on re-init', () => {
    const result = initWorkspace(dir);
    writeFileSync(result.statePath, '{"stage":"intent"}\n', 'utf8');
    const notesPath = join(result.workspacePath, 'notes.md');
    writeFileSync(notesPath, '# notes\n', 'utf8');

    initWorkspace(dir);

    expect(readFileSync(result.statePath, 'utf8')).toBe('{"stage":"intent"}\n');
    expect(existsSync(notesPath)).toBe(true);
  });

  it('does not create a state file for a pre-existing .pf/ directory', () => {
    mkdirSync(join(dir, WORKSPACE_DIR));

    const result = initWorkspace(dir);

    expect(result.created).toBe(false);
    expect(existsSync(result.statePath)).toBe(false);
  });
});
