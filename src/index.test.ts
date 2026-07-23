import { describe, expect, it } from 'vitest';
import { VERSION, scoreReadiness } from './index.js';

describe('public API', () => {
  it('exports a version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('re-exports scoreReadiness', () => {
    const result = scoreReadiness({ acceptanceCriteria: [] });
    expect(result.checks.length).toBeGreaterThan(0);
  });
});
