/**
 * Config load + validate — reads `product-factory.json` from a target
 * directory, validates it against a strict zod schema, and falls back to
 * defaults when the file is absent.
 *
 * Model routing behavior driven by this config is a later story; this module
 * only loads, validates, and returns the resolved values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Name of the config file read from the target directory. */
export const CONFIG_FILE = 'product-factory.json';

const configSchema = z
  .object({
    model: z
      .object({
        provider: z.string().default('anthropic'),
        name: z.string().default('claude-sonnet-4-5'),
      })
      .strict()
      .default({}),
    budget: z
      .object({
        maxUsdPerRun: z.number().nonnegative().default(5),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ProductFactoryConfig = z.infer<typeof configSchema>;

export interface ConfigIssue {
  /** Dot-joined path of the offending field, e.g. "budget.maxUsdPerRun"; "(root)" for file-level problems. */
  readonly path: string;
  readonly message: string;
}

export type LoadConfigResult =
  | {
      readonly ok: true;
      readonly config: ProductFactoryConfig;
      /** Absolute path of the file that was read, or undefined when defaults were used. */
      readonly configPath: string | undefined;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * Load and validate `<targetDir>/product-factory.json`.
 *
 * Returns fully-populated defaults when the file does not exist. When it
 * exists, parses it as JSON and validates it against a strict schema —
 * unknown fields and wrong types are reported as issues naming the offending
 * path, never thrown.
 */
export function loadConfig(targetDir: string): LoadConfigResult {
  const configPath = join(targetDir, CONFIG_FILE);

  if (!existsSync(configPath)) {
    return { ok: true, config: configSchema.parse({}), configPath: undefined };
  }

  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [{ path: '(root)', message: `invalid JSON: ${message}` }] };
  }

  const result = configSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, config: result.data, configPath };
  }

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
  return { ok: false, issues };
}
