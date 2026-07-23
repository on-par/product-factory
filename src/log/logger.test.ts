import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, EVENTS_FILE } from './logger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(eventsPath: string): string[] {
  return readFileSync(eventsPath, 'utf8').trim().split('\n');
}

describe('createLogger', () => {
  it('appends a single valid JSON line per event', () => {
    const logger = createLogger(dir);
    logger.info('hello', { stage: 'init' });

    const lines = readLines(logger.eventsPath);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      ts: expect.any(String),
      level: 'info',
      message: 'hello',
      data: { stage: 'init' },
    });
  });

  it('includes level, message, and an ISO timestamp', () => {
    const logger = createLogger(dir);
    logger.info('hello');

    const parsed = JSON.parse(readLines(logger.eventsPath)[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it('creates the file on a fresh workspace and does not throw', () => {
    const logger = createLogger(dir);
    expect(existsSync(logger.eventsPath)).toBe(false);

    expect(() => logger.info('first event')).not.toThrow();

    expect(existsSync(logger.eventsPath)).toBe(true);
    expect(readLines(logger.eventsPath)).toHaveLength(1);
  });

  it('appends across multiple calls, preserving order', () => {
    const logger = createLogger(dir);
    logger.info('first');
    logger.error('second');

    const lines = readLines(logger.eventsPath);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('info');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });

  it('writes the correct level for all four level methods', () => {
    const logger = createLogger(dir);
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    const levels = readLines(logger.eventsPath).map((line) => JSON.parse(line).level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('omits the data key when no payload is given', () => {
    const logger = createLogger(dir);
    logger.info('no payload');

    const parsed = JSON.parse(readLines(logger.eventsPath)[0]);
    expect('data' in parsed).toBe(false);
  });

  it('never throws when the workspace directory is missing', () => {
    const missingDir = join(dir, 'missing', '.pf');
    const logger = createLogger(missingDir);

    expect(() => logger.info('x')).not.toThrow();

    expect(existsSync(logger.eventsPath)).toBe(true);
  });

  it('never throws on an unserializable payload', () => {
    const logger = createLogger(dir);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => logger.info('cycle', cyclic)).not.toThrow();
  });

  it('points eventsPath inside the workspace', () => {
    const logger = createLogger(dir);
    expect(logger.eventsPath).toBe(join(dir, EVENTS_FILE));
  });
});
