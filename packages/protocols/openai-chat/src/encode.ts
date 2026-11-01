import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalResponse,
  CanonicalUsage,
  FinishReason,
} from '@openferry/canonical';

export interface ChatCompletionWire {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] };
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage?: Record<string, number | Record<string, number>>;
}

export function encodeFinishReason(reason: FinishReason): string | null {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    // 不知道就说不知道：null 比伪造一个 "stop" 更诚实。
    case 'error':
    case 'unknown':
      return null;
  }
}

export function encodeUsage(
  usage: CanonicalUsage | undefined,
): Record<string, number | Record<string, number>> | undefined {
  if (usage === undefined) return undefined;
  const out: Record<string, number | Record<string, number>> = {};
  if (usage.inputTokens !== undefined) out['prompt_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== undefined) out['completion_tokens'] = usage.outputTokens;
  if (usage.totalTokens !== undefined) {
    out['total_tokens'] = usage.totalTokens;
  } else if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    out['total_tokens'] = usage.inputTokens + usage.outputTokens;
  }
  if (usage.cachedInputTokens !== undefined) {
    out['prompt_tokens_details'] = { cached_tokens: usage.cachedInputTokens };
  }
  if (usage.reasoningTokens !== undefined) {
    out['completion_tokens_details'] = { reasoning_tokens: usage.reasoningTokens };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function splitContent(blocks: CanonicalContentBlock[]): {
  text: string | null;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
} {
  let text = '';
  let sawText = false;
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text;
        sawText = true;
        break;
      case 'tool_call':
        toolCalls.push({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: block.argumentsJson },
        });
        break;
      case 'tool_result':
      case 'image':
        // 响应方向的图像/工具结果不属于 assistant 输出，忽略（不是静默丢用户输入）。
        break;
    }
  }

  return { text: sawText ? text : null, toolCalls };
}

export function encodeChatResponse(response: CanonicalResponse): ChatCompletionWire {
  const { text, toolCalls } = splitContent(response.message.content);
  const usage = encodeUsage(response.usage);

  return {
    id: response.id,
    object: 'chat.completion',
    created: response.createdAt,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: encodeFinishReason(response.finishReason),
        logprobs: null,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

export function encodeChatMessage(message: CanonicalMessage): {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
} {
  const { text, toolCalls } = splitContent(message.content);
  return {
    role: message.role,
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}
