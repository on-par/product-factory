#!/usr/bin/env node
/**
 * product-factory CLI (`product-factory` / `pf`).
 *
 * Zero-dependency argv parsing for now — a real command framework arrives with
 * the CLI epic. This entrypoint exists so the walking skeleton is runnable end
 * to end and the verify gate has something to build a binary from.
 */

import { VERSION, initWorkspace, scoreReadiness, type Story } from './index.js';

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
      '  version            Print the version',
      '  readiness-demo     Score a sample story against the readiness rubric v0',
      '  help               Show this help',
      '',
    ].join('\n') + '\n',
  );
}

function main(argv: readonly string[]): number {
  const command = argv[2] ?? 'help';

  switch (command) {
    case 'init': {
      const result = initWorkspace(process.cwd());
      if (result.created) {
        process.stdout.write(`initialized Product Factory workspace at ${result.workspacePath}\n`);
      } else {
        process.stdout.write(`workspace already initialized at ${result.workspacePath}\n`);
      }
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

process.exit(main(process.argv));
