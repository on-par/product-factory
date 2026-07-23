/**
 * Minimal Anthropic Messages API adapter over global `fetch` (Node >= 20).
 * Zero dependencies; `fetchFn` is injectable so tests never hit the network.
 */

import type { QuestionModelCaller } from './questions.js';

export interface AnthropicCallerOptions {
  readonly apiKey: string;
  /** Model name, e.g. from product-factory.json's model.name. */
  readonly model: string;
  /** Max tokens for the completion; defaults to 2048 (sized for short clarifying-question output). */
  readonly maxTokens?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface AnthropicMessagesResponse {
  readonly content: readonly AnthropicContentBlock[];
}

/** Build a `QuestionModelCaller` backed by the Anthropic Messages API. */
export function createAnthropicQuestionCaller(
  options: AnthropicCallerOptions,
): QuestionModelCaller {
  const fetchFn = options.fetchFn ?? fetch;
  const maxTokens = options.maxTokens ?? 2048;

  return async (prompt: string): Promise<string> => {
    const response = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`anthropic API error: ${response.status}`);
    }

    const body = (await response.json()) as AnthropicMessagesResponse;
    const textBlock = body.content.find((block) => block.type === 'text');
    if (textBlock?.text === undefined) {
      throw new Error('anthropic API returned no text content');
    }
    return textBlock.text;
  };
}
