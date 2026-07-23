import { describe, expect, it } from 'vitest';
import { scoreReadiness, type Story } from './score.js';

const readyStory: Story = {
  actor: 'As a PM',
  acceptanceCriteria: [
    'Given a brain-dump, When I submit it, Then the interviewer asks clarifying questions',
  ],
  dependencies: ['intake service'],
  openQuestions: [],
};

describe('scoreReadiness', () => {
  it('scores a fully ready story at 1.0 with nothing missing', () => {
    const result = scoreReadiness(readyStory);
    expect(result.score).toBe(1);
    expect(result.missing).toHaveLength(0);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('flags a missing actor', () => {
    const result = scoreReadiness({ ...readyStory, actor: '   ' });
    expect(result.score).toBeLessThan(1);
    expect(result.missing).toContain('Story names a single clear actor');
  });

  it('flags acceptance criteria that are not in Given/When/Then form', () => {
    const result = scoreReadiness({
      ...readyStory,
      acceptanceCriteria: ['it should work'],
    });
    expect(result.missing).toContain('At least one acceptance criterion uses Given/When/Then');
  });

  it('flags a story with no acceptance criteria', () => {
    const result = scoreReadiness({ ...readyStory, acceptanceCriteria: [] });
    expect(result.missing).toContain('Story has at least one acceptance criterion');
  });

  it('flags unresolved open questions', () => {
    const result = scoreReadiness({
      ...readyStory,
      openQuestions: ['What happens on empty input?'],
    });
    expect(result.missing).toContain('No unresolved open questions remain');
  });

  it('treats an undefined actor and undefined open-questions field as unfilled', () => {
    // Exercises the optional-field branches: no actor key, no openQuestions key.
    const result = scoreReadiness({ acceptanceCriteria: ['it should work'] });
    expect(result.missing).toContain('Story names a single clear actor');
    // openQuestions absent => the no-open-questions check passes.
    expect(result.missing).not.toContain('No unresolved open questions remain');
  });

  it('reports a proportional score when some checks fail', () => {
    const result = scoreReadiness({
      actor: '',
      acceptanceCriteria: ['it should work'],
      openQuestions: ['unresolved'],
    });
    // 4 checks: has-acceptance-criteria passes, the other three fail => 1/4.
    expect(result.score).toBeCloseTo(0.25);
  });
});
