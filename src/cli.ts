#!/usr/bin/env node
/**
 * product-factory CLI (`product-factory` / `pf`).
 *
 * Zero-dependency argv parsing for now — a real command framework arrives with
 * the CLI epic. This entrypoint exists so the walking skeleton is runnable end
 * to end and the verify gate has something to build a binary from.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VERSION,
  initWorkspace,
  scoreReadiness,
  loadConfig,
  createLogger,
  intakeTranscript,
  generateClarifyingQuestions,
  createAnthropicQuestionCaller,
  WORKSPACE_DIR,
  type Story,
} from './index.js';

function printUsage(): void {
  process.stdout.write(
    [
      'product-factory — agentic product delivery factory',
      '',
      'Usage:',
      '  product-factory <command>',
      '',
      'Commands:',
      '  init               Initialize a .pf/ workspace in the current directory',
      '  config             Print the resolved product-factory.json config as JSON',
      '  intake <file>      Ingest a brain-dump (use "-" to read stdin) into a transcript artifact',
      '  interview questions <transcriptId>   Generate gap-tagged clarifying questions for a transcript',
      '  version            Print the version',
      '  readiness-demo     Score a sample story against the readiness rubric v0',
      '  help               Show this help',
      '',
    ].join('\n') + '\n',
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[2] ?? 'help';

  switch (command) {
    case 'init': {
      const result = initWorkspace(process.cwd());
      const logger = createLogger(result.workspacePath);
      logger.info(result.created ? 'workspace initialized' : 'workspace already initialized', {
        workspacePath: result.workspacePath,
      });
      if (result.created) {
        process.stdout.write(`initialized Product Factory workspace at ${result.workspacePath}\n`);
      } else {
        process.stdout.write(`workspace already initialized at ${result.workspacePath}\n`);
      }
      return 0;
    }

    case 'config': {
      const result = loadConfig(process.cwd());
      if (result.ok) {
        process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
        return 0;
      }
      process.stderr.write('invalid product-factory.json:\n');
      for (const issue of result.issues) {
        process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
      }
      return 1;
    }

    case 'intake': {
      const target = argv[3];
      if (target === undefined) {
        process.stderr.write('usage: product-factory intake <file>  (use "-" for stdin)\n');
        return 1;
      }
      let raw: string;
      const source = target === '-' ? 'stdin' : target;
      try {
        // fd 0 reads stdin synchronously, keeping main() sync like every other command
        raw = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
      } catch {
        process.stderr.write(`cannot read ${source}\n`);
        return 1;
      }
      const result = intakeTranscript(process.cwd(), raw, source);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('transcript ingested', {
        id: result.artifact.id,
        source: result.artifact.source,
        artifactPath: result.artifactPath,
      });
      process.stdout.write(`${result.artifact.id}\n`);
      return 0;
    }

    case 'interview': {
      if (argv[3] !== 'questions' || argv[4] === undefined) {
        process.stderr.write('usage: product-factory interview questions <transcriptId>\n');
        return 1;
      }
      const configResult = loadConfig(process.cwd());
      if (!configResult.ok) {
        process.stderr.write('invalid product-factory.json:\n');
        for (const issue of configResult.issues) {
          process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
        }
        return 1;
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey === '') {
        process.stderr.write('ANTHROPIC_API_KEY is not set\n');
        return 1;
      }
      const callModel = createAnthropicQuestionCaller({
        apiKey,
        model: configResult.config.model.name,
      });
      const result = await generateClarifyingQuestions(process.cwd(), argv[4], callModel);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('clarifying questions generated', {
        transcriptId: result.artifact.transcriptId,
        questionsId: result.artifact.id,
        count: result.artifact.questions.length,
        artifactPath: result.artifactPath,
      });
      for (const question of result.artifact.questions) {
        process.stdout.write(`[${question.gapType}] ${question.question}\n`);
      }
      process.stdout.write(`${result.artifact.id}\n`);
      return 0;
    }

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case 'readiness-demo': {
      const sample: Story = {
        actor: 'As a PM',
        acceptanceCriteria: [
          'Given a brain-dump, When I submit it, Then the interviewer asks clarifying questions',
        ],
        openQuestions: [],
      };
      const result = scoreReadiness(sample);
      process.stdout.write(`readiness score: ${result.score.toFixed(2)}\n`);
      for (const check of result.checks) {
        process.stdout.write(`  ${check.passed ? '✓' : '✗'} ${check.description}\n`);
      }
      return 0;
    }

    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;

    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

process.exit(await main(process.argv));
