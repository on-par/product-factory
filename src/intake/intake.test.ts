import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { intakeTranscript, TRANSCRIPTS_DIR } from './intake.js';
import { WORKSPACE_DIR } from '../workspace/init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-intake-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('intakeTranscript', () => {
  it('writes a transcript artifact into .pf/transcripts/', () => {
    const result = intakeTranscript(dir, 'We should build a widget\n', 'braindump.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(result.artifactPath).toBe(
      join(dir, WORKSPACE_DIR, TRANSCRIPTS_DIR, `${result.artifact.id}.json`),
    );
  });

  it('artifact preserves original text and records source + timestamp', () => {
    const input = 'We should build a widget\n';
    const result = intakeTranscript(dir, input, 'braindump.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const parsed = JSON.parse(readFileSync(result.artifactPath, 'utf8'));
    expect(parsed.raw).toBe(input);
    expect(parsed.source).toBe('braindump.txt');
    expect(new Date(parsed.createdAt).toISOString()).toBe(parsed.createdAt);
  });

  it('normalizes line endings and BOM', () => {
    const input = '﻿line one\r\nline two\r';
    const result = intakeTranscript(dir, input, 'braindump.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.text).toBe('line one\nline two\n');
    expect(result.artifact.raw).toBe(input);
    expect(result.artifact.raw).toContain('﻿');
    expect(result.artifact.raw).toContain('\r\n');
  });

  it('trims surrounding blank lines, keeps interior ones and indentation', () => {
    const result = intakeTranscript(dir, '\n  \nfirst\n\nsecond\n\n\n', 'braindump.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.text).toBe('first\n\nsecond\n');

    const indented = intakeTranscript(dir, '  indented first line\n', 'braindump2.txt');
    expect(indented.ok).toBe(true);
    if (!indented.ok) throw new Error('expected ok');
    expect(indented.artifact.text).toBe('  indented first line\n');
  });

  it('id is deterministic and content-derived', () => {
    const a = intakeTranscript(dir, 'a\nb\n', 'a.txt');
    const b = intakeTranscript(dir, 'a\r\nb', 'b.txt');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.artifact.id).toBe(b.artifact.id);
    expect(a.artifact.id).toMatch(/^[0-9a-f]{12}$/);

    const c = intakeTranscript(dir, 'completely different text\n', 'c.txt');
    expect(c.ok).toBe(true);
    if (!c.ok) throw new Error('expected ok');
    expect(c.artifact.id).not.toBe(a.artifact.id);
  });

  it('re-ingest of identical content is idempotent', () => {
    const first = intakeTranscript(dir, 'same text\n', 'a.txt');
    const second = intakeTranscript(dir, 'same text\n', 'a.txt');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.artifactPath).toBe(first.artifactPath);
    const files = readdirSync(join(dir, WORKSPACE_DIR, TRANSCRIPTS_DIR));
    expect(files.length).toBe(1);
  });

  it('rejects empty input', () => {
    for (const input of ['', '   \n\n', '﻿']) {
      const result = intakeTranscript(dir, input, 'braindump.txt');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected not ok');
      expect(result.error.length).toBeGreaterThan(0);
    }
    const transcriptsDir = join(dir, WORKSPACE_DIR, TRANSCRIPTS_DIR);
    expect(existsSync(transcriptsDir) ? readdirSync(transcriptsDir).length : 0).toBe(0);
  });

  it('stores the stdin source string as given', () => {
    const result = intakeTranscript(dir, 'x\n', 'stdin');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.source).toBe('stdin');
  });
});
