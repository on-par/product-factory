import { describe, expect, it } from 'vitest';
import { createAnthropicQuestionCaller } from './anthropic.js';

describe('createAnthropicQuestionCaller', () => {
  it('resolves with the model text and sends the expected request', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[{"question":"q","gapType":"unclear"}]' }],
        }),
        { status: 200 },
      );
    };

    const caller = createAnthropicQuestionCaller({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchFn,
    });

    const result = await caller('describe the transcript');
    expect(result).toBe('[{"question":"q","gapType":"unclear"}]');

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.messages[0].content).toBe('describe the transcript');
  });

  it('rejects with the status code on a non-2xx response', async () => {
    const fetchFn: typeof fetch = async () => new Response('server error', { status: 500 });
    const caller = createAnthropicQuestionCaller({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchFn,
    });

    await expect(caller('prompt')).rejects.toThrow('500');
  });

  it('rejects when no text content block is present', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ content: [] }), { status: 200 });
    const caller = createAnthropicQuestionCaller({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchFn,
    });

    await expect(caller('prompt')).rejects.toThrow('no text content');
  });
});
