import { describe, expect, it } from 'vitest';
import {
  VERSION,
  scoreReadiness,
  initWorkspace,
  WORKSPACE_DIR,
  STATE_FILE,
  loadConfig,
  CONFIG_FILE,
  createLogger,
  EVENTS_FILE,
  intakeTranscript,
  TRANSCRIPTS_DIR,
} from './index.js';

describe('public API', () => {
  it('exports a version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('re-exports scoreReadiness', () => {
    const result = scoreReadiness({ acceptanceCriteria: [] });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('re-exports initWorkspace and workspace constants', () => {
    expect(typeof initWorkspace).toBe('function');
    expect(WORKSPACE_DIR).toBe('.pf');
    expect(STATE_FILE).toBe('state.json');
  });

  it('re-exports loadConfig and CONFIG_FILE', () => {
    expect(typeof loadConfig).toBe('function');
    expect(CONFIG_FILE).toBe('product-factory.json');
  });

  it('re-exports createLogger and EVENTS_FILE', () => {
    expect(typeof createLogger).toBe('function');
    expect(EVENTS_FILE).toBe('events.ndjson');
  });

  it('re-exports intakeTranscript and TRANSCRIPTS_DIR', () => {
    expect(typeof intakeTranscript).toBe('function');
    expect(TRANSCRIPTS_DIR).toBe('transcripts');
  });
});
