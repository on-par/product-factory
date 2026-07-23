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

export const VERSION = '0.1.0';
