import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, CONFIG_FILE } from './config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns full defaults when no config file exists', () => {
    const result = loadConfig(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configPath).toBeUndefined();
    expect(result.config).toEqual({
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      budget: { maxUsdPerRun: 5 },
      interview: { maxRounds: 3 },
      rework: { threshold: 0.8, maxIterations: 3 },
    });
  });

  it('applies partial overrides from a valid file', () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify({ model: { provider: 'openai' } }),
      'utf8',
    );

    const result = loadConfig(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.model.provider).toBe('openai');
    expect(result.config.model.name).toBe('claude-sonnet-4-5');
    expect(result.config.budget.maxUsdPerRun).toBe(5);
    expect(result.config.interview.maxRounds).toBe(3);
    expect(result.configPath).toBe(join(dir, CONFIG_FILE));
  });

  it('echoes back a fully specified valid file', () => {
    const full = {
      model: { provider: 'openai', name: 'gpt-4o' },
      budget: { maxUsdPerRun: 12.5 },
      interview: { maxRounds: 4 },
      rework: { threshold: 0.9, maxIterations: 5 },
    };
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(full), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(full);
  });

  it('rejects an unknown top-level field', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ unknownField: true }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes('unknownField'))).toBe(true);
  });

  it('rejects an unknown nested field', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ budget: { maxTokens: 1 } }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.message.includes('maxTokens'));
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('budget');
  });

  it('rejects a wrong type with a path naming the field', () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify({ budget: { maxUsdPerRun: 'lots' } }),
      'utf8',
    );

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('budget.maxUsdPerRun');
  });

  it('rejects a non-positive interview.maxRounds', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ interview: { maxRounds: 0 } }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('interview.maxRounds');
  });

  it('rejects an out-of-range rework.threshold', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ rework: { threshold: 2 } }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('rework.threshold');
  });

  it('rejects a non-positive rework.maxIterations', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ rework: { maxIterations: 0 } }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('rework.maxIterations');
  });

  it('rejects an unknown rework field', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ rework: { unknown: 1 } }), 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.message.includes('unknown'));
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('rework');
  });

  it('rejects malformed JSON', () => {
    writeFileSync(join(dir, CONFIG_FILE), 'not json', 'utf8');

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('(root)');
    expect(result.issues[0]?.message).toContain('invalid JSON');
  });

  it('reports a read failure instead of throwing when the config path is unreadable', () => {
    mkdirSync(join(dir, CONFIG_FILE));

    const result = loadConfig(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('(root)');
    expect(result.issues[0]?.message).toContain('unable to read config file');
  });
});
