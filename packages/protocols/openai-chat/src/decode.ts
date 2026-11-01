import { ProtocolError } from '@openferry/core';
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalResponseFormat,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalWarning,
  FinishReason,
  CanonicalUsage,
} from '@openferry/canonical';
import { chatRequestSchema, chatResponseWireSchema, messageWireSchema } from './wire.js';

export interface DecodeRequestResult {
  request: CanonicalRequest;
  warnings: CanonicalWarning[];
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ProtocolError('invalid_request', message, { details });
}

/** data: URL → Canonical base64 图像；普通 URL 原样保留。 */
function decodeImageUrl(url: string, detail?: string): CanonicalContentBlock {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl?.[1] && dataUrl[2]) {
    return { type: 'image', source: { kind: 'base64', mediaType: dataUrl[1], data: dataUrl[2] } };
  }
  if (!/^https?:\/\//i.test(url)) {
    invalid('image_url.url must be an http(s) URL or a base64 data URL');
  }
  return {
    type: 'image',
    source: { kind: 'url', url },
    ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}),
  };
}

function decodeContent(raw: unknown, messageIndex: number): CanonicalContentBlock[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') return raw.length > 0 ? [{ type: 'text', text: raw }] : [];

  if (!Array.isArray(raw)) {
    invalid(`messages[${messageIndex}].content must be a string, an array, or null`);
  }

  const blocks: CanonicalContentBlock[] = [];
  for (const part of raw) {
    if (typeof part !== 'object' || part === null) {
      invalid(`messages[${messageIndex}].content[] must be an object`);
    }
    const record = part as Record<string, unknown>;
    switch (record['type']) {
      case 'text': {
        const text = record['text'];
        if (typeof text !== 'string')
          invalid(`messages[${messageIndex}].content[].text must be a string`);
        blocks.push({ type: 'text', text });
        break;
      }
      case 'image_url': {
        const image = record['image_url'];
        if (typeof image !== 'object' || image === null) {
          invalid(`messages[${messageIndex}].content[].image_url must be an object`);
        }
        const { url, detail } = image as Record<string, unknown>;
        if (typeof url !== 'string' || url.length === 0) {
          invalid(`messages[${messageIndex}].content[].image_url.url must be a non-empty string`);
        }
        blocks.push(decodeImageUrl(url, typeof detail === 'string' ? detail : undefined));
        break;
      }
      default:
        invalid(`messages[${messageIndex}].content[] has unsupported part type`, {
          type: record['type'],
        });
    }
  }
  return blocks;
}

function decodeMessages(raw: unknown[]): CanonicalMessage[] {
  return raw.map((item, index) => {
    const parsed = messageWireSchema.safeParse(item);
    if (!parsed.success) {
      invalid(`messages[${index}] is malformed`, {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const message = parsed.data;

    if (message.role === 'tool') {
      if (!message.tool_call_id)
        invalid(`messages[${index}].tool_call_id is required for role "tool"`);
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '');
      return {
        role: 'tool' as const,
        content: [{ type: 'tool_result' as const, toolCallId: message.tool_call_id, content }],
      };
    }

    const role = message.role === 'developer' ? 'system' : message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      invalid(`messages[${index}].role "${message.role}" is not supported`);
    }

    const content = decodeContent(message.content, index);
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        content.push({
          type: 'tool_call',
          id: call.id,
          name: call.function.name,
          argumentsJson: call.function.arguments,
        });
      }
    }

    return {
      role,
      content,
      ...(message.name === undefined ? {} : { name: message.name }),
    };
  });
}

function decodeTools(raw: unknown[] | undefined): CanonicalTool[] | undefined {
  if (raw === undefined) return undefined;
  return raw.map((item, index) => {
    const record = item as Record<string, unknown> | null;
    if (!record || record['type'] !== 'function') {
      invalid(`tools[${index}].type must be "function"`, { type: record?.['type'] });
    }
    const fn = record['function'] as Record<string, unknown> | undefined;
    if (!fn || typeof fn['name'] !== 'string') {
      invalid(`tools[${index}].function.name is required`);
    }
    const parameters = fn['parameters'];
    return {
      name: fn['name'] as string,
      ...(typeof fn['description'] === 'string' ? { description: fn['description'] } : {}),
      parameters:
        typeof parameters === 'object' && parameters !== null
          ? (parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
    };
  });
}

function decodeToolChoice(raw: unknown): CanonicalToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (typeof raw === 'object') {
    const fn = (raw as Record<string, unknown>)['function'] as Record<string, unknown> | undefined;
    if (fn && typeof fn['name'] === 'string') return { name: fn['name'] };
  }
  invalid(
    'tool_choice must be "auto", "none", "required", or {"type":"function","function":{"name":...}}',
  );
}

function decodeResponseFormat(raw: unknown): CanonicalResponseFormat | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') invalid('response_format must be an object');
  const record = raw as Record<string, unknown>;
  switch (record['type']) {
    case 'text':
      return { type: 'text' };
    case 'json_object':
      return { type: 'json_object' };
    case 'json_schema': {
      const spec = record['json_schema'] as Record<string, unknown> | undefined;
      if (!spec || typeof spec['name'] !== 'string') {
        invalid('response_format.json_schema.name is required');
      }
      return {
        type: 'json_schema',
        name: spec['name'] as string,
        schema:
          typeof spec['schema'] === 'object' && spec['schema'] !== null
            ? (spec['schema'] as Record<string, unknown>)
            : {},
        ...(typeof spec['strict'] === 'boolean' ? { strict: spec['strict'] } : {}),
      };
    }
    default:
      invalid(`response_format.type "${String(record['type'])}" is not supported`);
  }
}

/**
 * 明确拒绝而不是静默降级 —— 见 docs/adr/0004-fail-closed-on-lossy-fields.md。
 * 静默丢弃会让客户端以为功能生效。
 */
function assertNoLossyFields(body: Record<string, unknown>): void {
  const n = body['n'];
  if (typeof n === 'number' && n !== 1) {
    invalid('"n" greater than 1 is not supported; OpenFerry returns a single choice', {
      field: 'n',
    });
  }
  if (body['logprobs'] !== undefined && body['logprobs'] !== null) {
    invalid('"logprobs" is not supported by the canonical model', { field: 'logprobs' });
  }
  if (body['audio'] !== undefined && body['audio'] !== null) {
    invalid('"audio" is not supported', { field: 'audio' });
  }
  if (Array.isArray(body['modalities']) && body['modalities'].some((m) => m !== 'text')) {
    invalid('non-text "modalities" are not supported', { field: 'modalities' });
  }
}

export function decodeChatRequest(raw: unknown): DecodeRequestResult {
  if (typeof raw !== 'object' || raw === null) {
    invalid('request body must be a JSON object');
  }
  assertNoLossyFields(raw as Record<string, unknown>);

  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    invalid('request body does not match OpenAI Chat Completions schema', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  const body = parsed.data;

  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;

  const warnings: CanonicalWarning[] = [];
  if (body.stream_options?.include_usage === true) {
    warnings.push({
      code: 'degraded',
      field: 'stream_options.include_usage',
      message: 'usage is always sent when the upstream provides it',
    });
  }

  return {
    request: {
      model: body.model,
      messages: decodeMessages(body.messages),
      stream: body.stream === true,
      ...(body.tools === undefined ? {} : { tools: decodeTools(body.tools) }),
      ...(body.tool_choice === undefined ? {} : { toolChoice: decodeToolChoice(body.tool_choice) }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { topP: body.top_p }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(stop === undefined ? {} : { stop }),
      ...(body.response_format === undefined
        ? {}
        : { responseFormat: decodeResponseFormat(body.response_format) }),
    },
    warnings,
  };
}

export function decodeChatResponse(raw: unknown, fallbackModel: string): CanonicalResponse {
  const parsed = chatResponseWireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError(
      'upstream_error',
      'upstream response does not match chat.completion schema',
      {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      },
    );
  }
  const body = parsed.data;
  const choice = body.choices[0];
  if (!choice) {
    throw new ProtocolError('upstream_error', 'upstream response contains no choices');
  }

  const message = choice.message;
  if (!message) {
    throw new ProtocolError('upstream_error', 'upstream choice has no message');
  }
  const content: CanonicalContentBlock[] = [];
  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: 'tool_call',
      id: call.id,
      name: call.function.name,
      argumentsJson: call.function.arguments,
    });
  }

  return {
    id: body.id,
    model: body.model || fallbackModel,
    createdAt: body.created ?? Math.floor(Date.now() / 1000),
    message: { role: 'assistant', content },
    finishReason: decodeFinishReason(choice.finish_reason),
    ...(decodeUsage(body.usage) === undefined ? {} : { usage: decodeUsage(body.usage) }),
    warnings: [],
  };
}

export function decodeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function decodeUsage(raw: unknown): CanonicalUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const pick = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const details = usage['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const completionDetails = usage['completion_tokens_details'] as
    Record<string, unknown> | undefined;

  const result: CanonicalUsage = {
    ...(pick(usage['prompt_tokens']) === undefined
      ? {}
      : { inputTokens: pick(usage['prompt_tokens']) }),
    ...(pick(usage['completion_tokens']) === undefined
      ? {}
      : { outputTokens: pick(usage['completion_tokens']) }),
    ...(pick(usage['total_tokens']) === undefined
      ? {}
      : { totalTokens: pick(usage['total_tokens']) }),
    ...(pick(details?.['cached_tokens']) === undefined
      ? {}
      : { cachedInputTokens: pick(details?.['cached_tokens']) }),
    ...(pick(completionDetails?.['reasoning_tokens']) === undefined
      ? {}
      : { reasoningTokens: pick(completionDetails?.['reasoning_tokens']) }),
  };

  return Object.keys(result).length === 0 ? undefined : result;
}
