/**
 * @on-par/product-factory public API.
 *
 * The engine is UI-less and packaged so the CLI (and, eventually, a server)
 * can consume it. Today it exposes the readiness rubric seed; the refinement
 * loop (interviewer → decomposer → judge → readiness → export) lands issue by
 * issue — see the open epics.
 */

export { scoreReadiness } from './readiness/score.js';
export type { Story, ReadinessCheck, ReadinessResult } from './readiness/score.js';

export { initWorkspace, WORKSPACE_DIR, STATE_FILE } from './workspace/init.js';
export type { InitWorkspaceResult } from './workspace/init.js';

export { loadConfig, CONFIG_FILE } from './config/config.js';
export type { ProductFactoryConfig, LoadConfigResult, ConfigIssue } from './config/config.js';

export { createLogger, EVENTS_FILE } from './log/logger.js';
export type { Logger, LogLevel, LogEvent } from './log/logger.js';

export { intakeTranscript, TRANSCRIPTS_DIR } from './intake/intake.js';
export type { TranscriptArtifact, IntakeResult } from './intake/intake.js';

export {
  generateClarifyingQuestions,
  analyzeGaps,
  buildPrompt,
  QUESTIONS_DIR,
} from './interview/questions.js';
export type {
  ClarifyingQuestion,
  QuestionsArtifact,
  GapType,
  GapDimension,
  QuestionModelCaller,
  GenerateQuestionsResult,
} from './interview/questions.js';
export { createAnthropicQuestionCaller } from './interview/anthropic.js';
export type { AnthropicCallerOptions } from './interview/anthropic.js';

export {
  recordAnswerRound,
  loadAnswerSession,
  evaluateStoppingRule,
  isBlockingQuestion,
  openBlockingQuestions,
  ANSWERS_DIR,
} from './interview/answers.js';
export type {
  AnswerSession,
  SessionQuestion,
  InterviewStatus,
  RecordAnswersResult,
  LoadAnswerSessionResult,
} from './interview/answers.js';

export { buildIntentDoc, loadIntentDoc, saveIntentDoc, INTENT_DIR } from './intent/build.js';
export type {
  IntentDoc,
  IntentStatement,
  IntentStatementSource,
  BuildIntentResult,
  LoadIntentResult,
} from './intent/build.js';

export {
  approveIntentDoc,
  loadIntentApproval,
  isIntentApproved,
  APPROVAL_SUFFIX,
} from './intent/approve.js';
export type { IntentApproval, ApproveIntentResult, LoadApprovalResult } from './intent/approve.js';

export {
  decomposeIntent,
  loadDecomposition,
  buildDecomposePrompt,
  validateTraceability,
  storySentence,
  DECOMPOSITIONS_DIR,
} from './decompose/decompose.js';
export type {
  Epic,
  DecomposedStory,
  Decomposition,
  DecomposeModelCaller,
  DecomposeResult,
  LoadDecompositionResult,
} from './decompose/decompose.js';

export {
  generateAcceptanceCriteria,
  loadCriteria,
  buildCriteriaPrompt,
  validateScenarioCoverage,
  renderScenario,
  checkStoryReadiness,
  criteriaSetId,
  saveCriteria,
  CRITERIA_DIR,
} from './criteria/criteria.js';
export type {
  GherkinScenario,
  StoryCriteria,
  CriteriaSet,
  CriteriaModelCaller,
  GenerateCriteriaResult,
  LoadCriteriaResult,
} from './criteria/criteria.js';

export {
  judgeStories,
  loadVerdicts,
  buildJudgePrompt,
  validateAlignmentReasons,
  VERDICTS_DIR,
} from './judge/judge.js';
export type {
  StoryVerdict,
  VerdictSet,
  JudgeModelCaller,
  JudgeResult,
  LoadVerdictsResult,
} from './judge/judge.js';

export {
  reworkStories,
  buildReworkPrompt,
  evaluateReworkStopping,
  validateRevisionCoverage,
  combinedScore,
  bestRound,
  REWORKS_DIR,
} from './rework/rework.js';
export type {
  StoryScore,
  ReworkRound,
  ReworkSession,
  ReworkStatus,
  ReworkModelCaller,
  ReworkCallers,
  ReworkOptions,
  ReworkResult,
} from './rework/rework.js';

export {
  buildReadinessReport,
  renderReadinessReport,
  collectOpenQuestions,
  REPORTS_DIR,
} from './report/report.js';
export type {
  ReportStory,
  ReportOpenQuestion,
  ReadinessReport,
  BuildReportResult,
} from './report/report.js';

export {
  approveReport,
  loadReportApproval,
  isReportApproved,
  REPORT_APPROVAL_SUFFIX,
} from './report/approve.js';
export type {
  ReportApproval,
  ApproveReportResult,
  LoadReportApprovalResult,
} from './report/approve.js';

export const VERSION = '0.1.0';
