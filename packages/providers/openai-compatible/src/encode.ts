import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
} from '@openferry/canonical';

function encodeImage(
  block: Extract<CanonicalContentBlock, { type: 'image' }>,
): Record<string, unknown> {
  const url =
    block.source.kind === 'url'
      ? block.source.url
      : `data:${block.source.mediaType};base64,${block.source.data}`;
  return {
    type: 'image_url',
    image_url: { url, ...(block.detail === undefined ? {} : { detail: block.detail }) },
  };
}

function encodeMessages(messages: CanonicalMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const message of messages) {
    // 一条 canonical 的 tool 消息可能带多个结果，线格式要求每个结果一条消息。
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        out.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content });
      }
      continue;
    }

    const texts: string[] = [];
    const images: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];

    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'image') images.push(encodeImage(block));
      else if (block.type === 'tool_call') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.argumentsJson },
        });
      }
    }

    const content: unknown =
      images.length === 0
        ? texts.join('')
        : [...texts.map((text) => ({ type: 'text', text })), ...images];

    out.push({
      role: message.role,
      content,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    });
  }

  return out;
}

export interface EncodeOptions {
  /** 上游真实模型 ID（已剥掉 provider 前缀）。 */
  model: string;
  stream: boolean;
}

export function encodeCanonicalRequest(
  request: CanonicalRequest,
  options: EncodeOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: encodeMessages(request.messages),
    stream: options.stream,
  };

  if (request.tools && request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters,
      },
    }));
  }

  if (request.toolChoice !== undefined) {
    body['tool_choice'] =
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : { type: 'function', function: { name: request.toolChoice.name } };
  }

  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  if (request.stop !== undefined) body['stop'] = request.stop;

  if (request.responseFormat !== undefined) {
    const format = request.responseFormat;
    if (format.type === 'text') body['response_format'] = { type: 'text' };
    else if (format.type === 'json_object') body['response_format'] = { type: 'json_object' };
    else {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: format.name,
          schema: format.schema,
          ...(format.strict === undefined ? {} : { strict: format.strict }),
        },
      };
    }
  }

  if (request.extensions !== undefined) {
    for (const [key, value] of Object.entries(request.extensions)) {
      if (!(key in body)) body[key] = value;
    }
  }

  return body;
}
