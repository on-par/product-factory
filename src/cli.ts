#!/usr/bin/env node
/**
 * product-factory CLI (`product-factory` / `pf`).
 *
 * Zero-dependency argv parsing for now — a real command framework arrives with
 * the CLI epic. This entrypoint exists so the walking skeleton is runnable end
 * to end and the verify gate has something to build a binary from.
 */

import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
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
  recordAnswerRound,
  openBlockingQuestions,
  buildIntentDoc,
  approveIntentDoc,
  loadIntentApproval,
  decomposeIntent,
  storySentence,
  generateAcceptanceCriteria,
  renderScenario,
  judgeStories,
  reworkStories,
  buildReadinessReport,
  approveReport,
  exportMarkdown,
  WORKSPACE_DIR,
  type Story,
  type ConfigIssue,
} from './index.js';

function printConfigIssues(issues: readonly ConfigIssue[]): void {
  process.stderr.write('invalid product-factory.json:\n');
  for (const issue of issues) {
    process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  }
}

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
      '  interview answer <questionsId> <file>      Record a round of answers (use "-" for stdin) and apply the stopping rule',
      '  intent build <interviewId>   Build the intent doc from a pinned interview',
      '  intent approve <intentId>    Approve the intent doc (human gate #1)',
      '  decompose <intentId>         Decompose an approved intent doc into an epic and traceable stories',
      '  criteria <decompositionId>   Generate Gherkin acceptance criteria for every story in a decomposition',
      '  judge <criteriaId>           Judge every story: readiness rubric + intent-alignment scores with reasons',
      '  rework <criteriaId>          Rework low-scoring stories until they clear the threshold or the budget is spent',
      '  report <verdictId>           Render the markdown readiness report for a judged story set',
      '  report approve <reportId>    Approve the readiness report (human gate #2)',
      '  export markdown <reportId> <dir>   Export an approved report as one markdown file per work item',
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
      printConfigIssues(result.issues);
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
      const usage =
        'usage: product-factory interview questions <transcriptId> | interview answer <questionsId> <answersFile>\n';

      if (argv[3] === 'questions') {
        if (argv[4] === undefined) {
          process.stderr.write(usage);
          return 1;
        }
        const configResult = loadConfig(process.cwd());
        if (!configResult.ok) {
          printConfigIssues(configResult.issues);
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
        result.artifact.questions.forEach((question, index) => {
          process.stdout.write(`[${index}] [${question.gapType}] ${question.question}\n`);
        });
        process.stdout.write(`${result.artifact.id}\n`);
        return 0;
      }

      if (argv[3] === 'answer') {
        const questionsId = argv[4];
        const file = argv[5];
        if (questionsId === undefined || file === undefined) {
          process.stderr.write(usage);
          return 1;
        }
        let raw: string;
        const source = file === '-' ? 'stdin' : file;
        try {
          raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
        } catch {
          process.stderr.write(`cannot read ${source}\n`);
          return 1;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          process.stderr.write('invalid answers JSON\n');
          return 1;
        }
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((value) => typeof value !== 'string')
        ) {
          process.stderr.write('invalid answers JSON\n');
          return 1;
        }
        const answers = parsed as Record<string, string>;

        const configResult = loadConfig(process.cwd());
        if (!configResult.ok) {
          printConfigIssues(configResult.issues);
          return 1;
        }

        const result = recordAnswerRound(process.cwd(), questionsId, answers, {
          maxRounds: configResult.config.interview.maxRounds,
        });
        if (!result.ok) {
          process.stderr.write(`${result.error}\n`);
          return 1;
        }
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        const open = openBlockingQuestions(result.session);
        logger.info('answers recorded', {
          questionsId,
          status: result.session.status,
          round: result.session.roundsCompleted,
          maxRounds: result.session.maxRounds,
          open: open.length,
          sessionPath: result.sessionPath,
        });
        process.stdout.write(`status: ${result.session.status}\n`);
        if (result.session.status !== 'pinned') {
          process.stdout.write('open questions:\n');
          for (const question of open) {
            process.stdout.write(`  [${question.index}] ${question.question.question}\n`);
          }
        }
        return 0;
      }

      process.stderr.write(usage);
      return 1;
    }

    case 'intent': {
      const usage =
        'usage: product-factory intent build <interviewId> | intent approve <intentId>\n';

      if (argv[3] === 'build' && argv[4] !== undefined) {
        const result = buildIntentDoc(process.cwd(), argv[4]);
        if (!result.ok) {
          process.stderr.write(`${result.error}\n`);
          return 1;
        }
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        logger.info('intent doc built', {
          interviewId: argv[4],
          intentId: result.doc.id,
          statements: result.doc.statements.length,
          docPath: result.docPath,
        });
        for (const statement of result.doc.statements) {
          process.stdout.write(`[${statement.id}] ${statement.text}\n`);
        }
        process.stdout.write(`${result.doc.id}\n`);
        return 0;
      }

      if (argv[3] === 'approve' && argv[4] !== undefined) {
        const approver = process.env.PF_APPROVER ?? userInfo().username;
        const result = approveIntentDoc(process.cwd(), argv[4], approver);
        if (!result.ok) {
          process.stderr.write(`${result.error}\n`);
          return 1;
        }
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        logger.info('intent doc approved', {
          intentId: argv[4],
          approvedBy: result.approval.approvedBy,
          approvedAt: result.approval.approvedAt,
          alreadyApproved: result.alreadyApproved,
          approvalPath: result.approvalPath,
        });
        process.stdout.write(
          result.alreadyApproved
            ? `intent doc ${argv[4]} already approved by ${result.approval.approvedBy} at ${result.approval.approvedAt}\n`
            : `intent doc ${argv[4]} approved by ${result.approval.approvedBy} at ${result.approval.approvedAt}\n`,
        );
        return 0;
      }

      process.stderr.write(usage);
      return 1;
    }

    case 'decompose': {
      const intentId = argv[3];
      if (intentId === undefined) {
        process.stderr.write('usage: product-factory decompose <intentId>\n');
        return 1;
      }
      const approval = loadIntentApproval(process.cwd(), intentId);
      if (!approval.ok) {
        process.stderr.write(
          `intent doc not approved: run "pf intent approve ${intentId}" first (human gate #1)\n`,
        );
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        logger.warn('decomposition refused: intent doc not approved', { intentId });
        return 1;
      }

      const configResult = loadConfig(process.cwd());
      if (!configResult.ok) {
        printConfigIssues(configResult.issues);
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
        // An epic plus multiple stories is a larger payload than the
        // clarifying-questions default (2048) comfortably fits.
        maxTokens: 4096,
      });
      const result = await decomposeIntent(process.cwd(), intentId, callModel);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('intent decomposed', {
        intentId,
        decompositionId: result.decomposition.id,
        stories: result.decomposition.stories.length,
        artifactPath: result.artifactPath,
      });
      process.stdout.write(`epic: ${result.decomposition.epic.title}\n`);
      result.decomposition.stories.forEach((story, index) => {
        process.stdout.write(
          `[${index}] ${story.title} — ${storySentence(story)} (traces-to: ${story.tracesTo.join(', ')})\n`,
        );
      });
      process.stdout.write(`${result.decomposition.id}\n`);
      return 0;
    }

    case 'criteria': {
      const decompositionId = argv[3];
      if (decompositionId === undefined) {
        process.stderr.write('usage: product-factory criteria <decompositionId>\n');
        return 1;
      }

      const configResult = loadConfig(process.cwd());
      if (!configResult.ok) {
        printConfigIssues(configResult.issues);
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
        // Multi-story Gherkin output outgrows the 2048 default.
        maxTokens: 4096,
      });
      const result = await generateAcceptanceCriteria(process.cwd(), decompositionId, callModel);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      const scenarioCount = result.criteria.stories.reduce(
        (total, story) => total + story.scenarios.length,
        0,
      );
      logger.info('acceptance criteria generated', {
        decompositionId,
        criteriaId: result.criteria.id,
        stories: result.criteria.stories.length,
        scenarios: scenarioCount,
        flaggedStories: result.criteria.stories.filter((s) => s.readinessFlags.length > 0).length,
        artifactPath: result.artifactPath,
      });
      for (const storyCriteria of result.criteria.stories) {
        process.stdout.write(
          `[${storyCriteria.storyIndex}] ${storyCriteria.storyTitle} (traces-to: ${storyCriteria.tracesTo.join(', ')})\n`,
        );
        for (const scenario of storyCriteria.scenarios) {
          process.stdout.write(`${renderScenario(scenario)}\n`);
        }
        for (const flag of storyCriteria.readinessFlags) {
          process.stdout.write(`  FLAG: ${flag}\n`);
        }
      }
      process.stdout.write(`${result.criteria.id}\n`);
      return 0;
    }

    case 'judge': {
      const criteriaId = argv[3];
      if (criteriaId === undefined) {
        process.stderr.write('usage: product-factory judge <criteriaId>\n');
        return 1;
      }

      const configResult = loadConfig(process.cwd());
      if (!configResult.ok) {
        printConfigIssues(configResult.issues);
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
        // Multi-story verdict JSON outgrows the 2048 default.
        maxTokens: 4096,
      });
      const result = await judgeStories(process.cwd(), criteriaId, callModel);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('stories judged', {
        criteriaId,
        verdictId: result.verdicts.id,
        stories: result.verdicts.stories.length,
        artifactPath: result.artifactPath,
      });
      for (const verdict of result.verdicts.stories) {
        process.stdout.write(
          `[${verdict.storyIndex}] ${verdict.storyTitle} (traces-to: ${verdict.tracesTo.join(', ')}) readiness: ${verdict.readinessScore.toFixed(2)} intent-alignment: ${verdict.intentAlignmentScore.toFixed(2)}\n`,
        );
        for (const reason of verdict.readinessReasons) {
          process.stdout.write(`  readiness: ${reason}\n`);
        }
        for (const reason of verdict.intentAlignmentReasons) {
          process.stdout.write(`  intent: ${reason}\n`);
        }
      }
      process.stdout.write(`${result.verdicts.id}\n`);
      return 0;
    }

    case 'rework': {
      const criteriaId = argv[3];
      if (criteriaId === undefined) {
        process.stderr.write('usage: product-factory rework <criteriaId>\n');
        return 1;
      }

      const configResult = loadConfig(process.cwd());
      if (!configResult.ok) {
        printConfigIssues(configResult.issues);
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
        // Multi-story revision and verdict JSON outgrow the 2048 default.
        maxTokens: 4096,
      });
      const result = await reworkStories(
        process.cwd(),
        criteriaId,
        { generate: callModel, judge: callModel },
        {
          threshold: configResult.config.rework.threshold,
          maxIterations: configResult.config.rework.maxIterations,
        },
      );
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('rework loop finished', {
        criteriaId,
        reworkId: result.session.id,
        status: result.session.status,
        iterations: result.session.rounds.length - 1,
        maxIterations: result.session.maxIterations,
        threshold: result.session.threshold,
        bestIteration: result.session.bestIteration,
        bestCriteriaId: result.session.bestCriteriaId,
        artifactPath: result.artifactPath,
      });
      for (const round of result.session.rounds) {
        process.stdout.write(
          `round ${round.iteration}: score ${round.score.toFixed(2)} (criteria ${round.criteriaId}, verdict ${round.verdictId})\n`,
        );
        for (const story of round.stories.filter((s) => s.score < result.session.threshold)) {
          process.stdout.write(
            `  [${story.storyIndex}] ${story.storyTitle} ${story.score.toFixed(2)}\n`,
          );
        }
      }
      process.stdout.write(`status: ${result.session.status}\n`);
      process.stdout.write(
        `best: round ${result.session.bestIteration} (criteria ${result.session.bestCriteriaId}, score ${result.session.rounds[result.session.bestIteration].score.toFixed(2)})\n`,
      );
      process.stdout.write(`${result.session.id}\n`);
      return 0;
    }

    case 'report': {
      const usage = 'usage: product-factory report <verdictId> | report approve <reportId>\n';

      if (argv[3] === 'approve') {
        if (argv[4] === undefined) {
          process.stderr.write(usage);
          return 1;
        }
        const approver = process.env.PF_APPROVER ?? userInfo().username;
        const result = approveReport(process.cwd(), argv[4], approver);
        if (!result.ok) {
          process.stderr.write(`${result.error}\n`);
          return 1;
        }
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        logger.info('readiness report approved', {
          reportId: argv[4],
          approvedBy: result.approval.approvedBy,
          approvedAt: result.approval.approvedAt,
          alreadyApproved: result.alreadyApproved,
          approvalPath: result.approvalPath,
        });
        process.stdout.write(
          result.alreadyApproved
            ? `readiness report ${argv[4]} already approved by ${result.approval.approvedBy} at ${result.approval.approvedAt}\n`
            : `readiness report ${argv[4]} approved by ${result.approval.approvedBy} at ${result.approval.approvedAt}\n`,
        );
        return 0;
      }

      const verdictId = argv[3];
      if (verdictId === undefined) {
        process.stderr.write(usage);
        return 1;
      }
      // No config or API key: the report is pure aggregation over persisted artifacts.
      const result = buildReadinessReport(process.cwd(), verdictId);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('readiness report rendered', {
        verdictId,
        reportId: result.report.id,
        stories: result.report.stories.length,
        openQuestions: result.report.openQuestions.length,
        artifactPath: result.artifactPath,
      });
      process.stdout.write(result.markdown);
      return 0;
    }

    case 'export': {
      const target = argv[3];
      const reportId = argv[4];
      const dir = argv[5];
      if (target !== 'markdown' || reportId === undefined || dir === undefined) {
        process.stderr.write('usage: product-factory export markdown <reportId> <dir>\n');
        if (target !== undefined && target !== 'markdown') {
          process.stderr.write(
            'export targets other than markdown land with epic #8 (GitHub/Jira are separate stories)\n',
          );
        }
        return 1;
      }
      const result = exportMarkdown(process.cwd(), reportId, dir);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
        logger.warn('export refused', { reportId, error: result.error });
        return 1;
      }
      const logger = createLogger(join(process.cwd(), WORKSPACE_DIR));
      logger.info('markdown export written', {
        reportId,
        outDir: result.outDir,
        files: result.files.length,
      });
      for (const file of result.files) {
        process.stdout.write(`${file.path}\n`);
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

process.exit(await main(process.argv));
