/**
 * Structured event log — appends leveled NDJSON events to the workspace's
 * events.ndjson so runs are debuggable and auditable (mirrors
 * software-factory ADR-0002).
 *
 * One writer, append-only. Logging is best-effort: a failing sink must never
 * crash a pipeline stage, so write errors are swallowed. Log rotation and
 * remote sinks are out of scope.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the event log file created inside the workspace. */
export const EVENTS_FILE = 'events.ndjson';

/** Severity level of a logged event. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A single structured event as serialized to one NDJSON line. */
export interface LogEvent {
  /** ISO 8601 timestamp of when the event was logged. */
  readonly ts: string;
  /** Severity level of the event. */
  readonly level: LogLevel;
  /** Human-readable event message. */
  readonly message: string;
  /** Optional structured payload attached to the event. */
  readonly data?: Record<string, unknown>;
}

/** Leveled writer over the workspace event log. */
export interface Logger {
  /** Absolute path to the events.ndjson file this logger appends to. */
  readonly eventsPath: string;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Create a logger that appends NDJSON events to `<workspacePath>/events.ndjson`.
 *
 * `workspacePath` is the `.pf/` directory. Writes are best-effort: a missing
 * workspace directory or unserializable payload never throws.
 */
export function createLogger(workspacePath: string): Logger {
  const eventsPath = join(workspacePath, EVENTS_FILE);

  function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    try {
      const event: LogEvent =
        data === undefined
          ? { ts: new Date().toISOString(), level, message }
          : { ts: new Date().toISOString(), level, message, data };
      const line = `${JSON.stringify(event)}\n`;
      mkdirSync(workspacePath, { recursive: true });
      appendFileSync(eventsPath, line, 'utf8');
    } catch {
      // logging is best-effort; never crash a stage
    }
  }

  return {
    eventsPath,
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
