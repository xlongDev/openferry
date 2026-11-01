import type { CanonicalEvent } from '@openferry/canonical';
import { decodeFinishReason, decodeUsage } from './decode.js';

/**
 * OpenAI chunk → CanonicalEvent。
 *
 * 解码器是有状态的：文本块要懒创建，工具调用的 `index`（OpenAI 的扁平编号）
 * 要映射到 Canonical 的内容块编号。把状态放在这里，而不是让网关记住协议细节。
 */
export interface StreamDecoderState {
  started: boolean;
  finished: boolean;
  textBlockIndex: number | null;
  toolBlocks: Map<number, number>;
  openBlocks: Set<number>;
  nextBlockIndex: number;
}

export function createStreamDecoderState(): StreamDecoderState {
  return {
    started: false,
    finished: false,
    textBlockIndex: null,
    toolBlocks: new Map(),
    openBlocks: new Set(),
    nextBlockIndex: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function decodeChatChunk(chunk: unknown, state: StreamDecoderState): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const record = asRecord(chunk);
  if (!record) return events;

  const error = asRecord(record['error']);
  if (error) {
    events.push({
      type: 'error',
      error: {
        code: typeof error['code'] === 'string' ? error['code'] : 'upstream_error',
        message:
          typeof error['message'] === 'string'
            ? error['message']
            : 'upstream returned an error event',
      },
    });
    return events;
  }

  const id = typeof record['id'] === 'string' ? record['id'] : 'chatcmpl-unknown';
  const model = typeof record['model'] === 'string' ? record['model'] : '';

  if (!state.started) {
    state.started = true;
    events.push({ type: 'start', id, model });
  }

  const usage = decodeUsage(record['usage']);
  if (usage !== undefined) events.push({ type: 'usage', usage });

  const choices = Array.isArray(record['choices']) ? record['choices'] : [];
  const choice = asRecord(choices[0]);
  if (!choice) return events;

  const delta = asRecord(choice['delta']) ?? asRecord(choice['message']) ?? {};

  const content = delta['content'];
  if (typeof content === 'string' && content.length > 0) {
    if (state.textBlockIndex === null) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.openBlocks.add(state.textBlockIndex);
      events.push({ type: 'content_block_start', index: state.textBlockIndex, blockType: 'text' });
    }
    events.push({ type: 'text_delta', index: state.textBlockIndex, text: content });
  }

  const toolCalls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
  for (const rawCall of toolCalls) {
    const call = asRecord(rawCall);
    if (!call) continue;
    const toolIndex = typeof call['index'] === 'number' ? call['index'] : 0;
    const fn = asRecord(call['function']) ?? {};

    let blockIndex = state.toolBlocks.get(toolIndex);
    if (blockIndex === undefined) {
      blockIndex = state.nextBlockIndex++;
      state.toolBlocks.set(toolIndex, blockIndex);
      state.openBlocks.add(blockIndex);
      events.push({
        type: 'content_block_start',
        index: blockIndex,
        blockType: 'tool_call',
        toolCallId: typeof call['id'] === 'string' ? call['id'] : `call_${toolIndex}`,
        toolName: typeof fn['name'] === 'string' ? fn['name'] : '',
      });
    }

    const args = fn['arguments'];
    if (typeof args === 'string' && args.length > 0) {
      events.push({ type: 'tool_call_delta', index: blockIndex, argumentsDelta: args });
    }
  }

  const finish = choice['finish_reason'];
  if (typeof finish === 'string' && !state.finished) {
    state.finished = true;
    for (const index of [...state.openBlocks].sort((a, b) => a - b)) {
      events.push({ type: 'content_block_stop', index });
    }
    state.openBlocks.clear();
    events.push({ type: 'done', finishReason: decodeFinishReason(finish) });
  }

  return events;
}

export interface ChatChunkEncoderOptions {
  id: string;
  model: string;
  created: number;
}

/**
 * CanonicalEvent → OpenAI chunk。
 *
 * `[DONE]` 不在这里写：网关要在流真正结束后才写，否则上游在 done 之后
 * 再补一条 usage chunk 时会落到哨兵之后，客户端直接丢掉。
 */
export class ChatChunkEncoder {
  readonly #toolIndexByBlock = new Map<number, number>();
  #nextToolIndex = 0;
  readonly #meta: ChatChunkEncoderOptions;

  constructor(meta: ChatChunkEncoderOptions) {
    this.#meta = meta;
  }

  #envelope(choices: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.#meta.id,
      object: 'chat.completion.chunk',
      created: this.#meta.created,
      model: this.#meta.model,
      choices,
      ...extra,
    };
  }

  encode(event: CanonicalEvent): Record<string, unknown> | null {
    switch (event.type) {
      case 'start':
        return this.#envelope([
          { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
        ]);
      case 'content_block_start':
        if (event.blockType !== 'tool_call') return null;
        return this.#toolStart(event.index, event.toolCallId ?? 'call_0', event.toolName ?? '');
      case 'text_delta':
        return this.#envelope([{ index: 0, delta: { content: event.text }, finish_reason: null }]);
      case 'tool_call_delta': {
        const index = this.#toolIndexByBlock.get(event.index) ?? 0;
        return this.#envelope([
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: event.argumentsDelta } }] },
            finish_reason: null,
          },
        ]);
      }
      case 'content_block_stop':
        return null;
      case 'usage':
        return this.#envelope([], { usage: event.usage });
      case 'done':
        return this.#envelope([
          {
            index: 0,
            delta: {},
            finish_reason: event.finishReason === 'unknown' ? null : event.finishReason,
          },
        ]);
      case 'error':
      case 'aborted':
        return null;
    }
  }

  #toolStart(blockIndex: number, toolCallId: string, toolName: string): Record<string, unknown> {
    const index = this.#nextToolIndex++;
    this.#toolIndexByBlock.set(blockIndex, index);
    return this.#envelope([
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: toolCallId,
              type: 'function',
              function: { name: toolName, arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ]);
  }
}
