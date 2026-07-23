/**
 * Transcript intake — ingests a raw product brain-dump and normalizes it into
 * a transcript artifact, the first artifact of the pipeline and the root of
 * the intent → story → acceptance-criterion traceability chain. No LLM
 * involvement; voice capture is out of scope.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_DIR } from '../workspace/init.js';

/** Name of the directory inside the workspace that holds transcript artifacts. */
export const TRANSCRIPTS_DIR = 'transcripts';

/** A normalized brain-dump transcript, the first artifact of the pipeline. */
export interface TranscriptArtifact {
  /** Content-derived id: first 12 hex chars of the sha256 of the normalized text. */
  readonly id: string;
  /** Where the text came from: the file path as given, or "stdin". */
  readonly source: string;
  /** ISO 8601 timestamp of when the artifact was created. */
  readonly createdAt: string;
  /** The original input, byte-for-byte as provided. */
  readonly raw: string;
  /** Normalized text: BOM stripped, line endings unified to \n, surrounding blank lines trimmed, single trailing newline. */
  readonly text: string;
}

export type IntakeResult =
  | {
      readonly ok: true;
      readonly artifact: TranscriptArtifact;
      /** Absolute path of the artifact JSON file that was written. */
      readonly artifactPath: string;
    }
  | { readonly ok: false; readonly error: string };

/** UTF-8 byte order mark, stripped from the start of input if present. */
const BOM = '\uFEFF';

function normalize(raw: string): string {
  const withoutBom = raw.startsWith(BOM) ? raw.slice(1) : raw;
  const withUnixEol = withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const withoutLeadingBlankLines = withUnixEol.replace(/^(?:[ \t]*\n)+/, '');
  const trimmed = withoutLeadingBlankLines.replace(/\s+$/, '');
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}

/**
 * Ingest a raw brain-dump and store it as a transcript artifact under
 * `<targetDir>/.pf/transcripts/`.
 *
 * The id is derived from the normalized text's content, so re-ingesting
 * identical text is idempotent: same id, artifact file overwritten in place.
 */
export function intakeTranscript(targetDir: string, raw: string, source: string): IntakeResult {
  const text = normalize(raw);
  if (text.trim().length === 0) {
    return { ok: false, error: 'brain-dump is empty' };
  }

  const id = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const createdAt = new Date().toISOString();
  const artifact: TranscriptArtifact = { id, source, createdAt, raw, text };

  const transcriptsDir = join(targetDir, WORKSPACE_DIR, TRANSCRIPTS_DIR);
  mkdirSync(transcriptsDir, { recursive: true });
  const artifactPath = join(transcriptsDir, `${id}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  return { ok: true, artifact, artifactPath };
}
