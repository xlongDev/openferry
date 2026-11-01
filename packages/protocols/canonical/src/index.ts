import { z } from 'zod';

/**
 * Canonical Model —— 所有协议转换的唯一中转。
 * 设计约束见 docs/adr/0003-canonical-model.md：
 *  - 不做最小公分母，无法表达的东西显式拒绝而不是丢弃
 *  - undefined ≠ 0（缺失的 usage 字段保持缺失）
 */

export const roleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type CanonicalRole = z.infer<typeof roleSchema>;

export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1) }),
  z.object({ kind: z.literal('base64'), mediaType: z.string().min(1), data: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    source: imageSourceSchema,
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    /** 原始 JSON 字符串，保持分片拼接后的字节，不做二次序列化。 */
    argumentsJson: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type CanonicalContentBlock = z.infer<typeof contentBlockSchema>;

export const messageSchema = z.object({
  role: roleSchema,
  content: z.array(contentBlockSchema),
  name: z.string().optional(),
});
export type CanonicalMessage = z.infer<typeof messageSchema>;

export const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()),
});
export type CanonicalTool = z.infer<typeof toolSchema>;

export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ name: z.string().min(1) }),
]);
export type CanonicalToolChoice = z.infer<typeof toolChoiceSchema>;

export const responseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
]);
export type CanonicalResponseFormat = z.infer<typeof responseFormatSchema>;

export const requestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  tools: z.array(toolSchema).optional(),
  toolChoice: toolChoiceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  responseFormat: responseFormatSchema.optional(),
  /** 透传给上游的供应商特有字段；网关不解释它。 */
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CanonicalRequest = z.infer<typeof requestSchema>;

export type FinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';

export interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  createdAt: number;
  message: CanonicalMessage;
  finishReason: FinishReason;
  usage?: CanonicalUsage;
  /** 降级或丢弃的字段说明，会以 x-openferry-warnings 响应头回给客户端。 */
  warnings: CanonicalWarning[];
}

export interface CanonicalWarning {
  code: 'degraded' | 'dropped' | 'unknown_field';
  field: string;
  message: string;
}

/** 流式事件是语义事件，不是线格式事件的别名。 */
export type CanonicalEvent =
  | { type: 'start'; id: string; model: string }
  | {
      type: 'content_block_start';
      index: number;
      blockType: 'text' | 'tool_call';
      toolCallId?: string;
      toolName?: string;
    }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'content_block_stop'; index: number }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'done'; finishReason: FinishReason }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'aborted'; reason: string };

export const finishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
  'unknown',
]);

/** 供应商能力声明。探测结果会覆盖这里的静态声明（阶段 4）。 */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  images: boolean;
  jsonObject: boolean;
  jsonSchema: boolean;
  usageInStream: boolean;
  reasoning: boolean;
}

export const defaultCapabilities: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  images: false,
  jsonObject: false,
  jsonSchema: false,
  usageInStream: false,
  reasoning: false,
};

/** 模型目录条目。价格未知必须是 `undefined`，不能填 0。 */
export interface ModelDescriptor {
  /** `${providerId}/${upstreamId}`，稳定且可逆。 */
  id: string;
  providerId: string;
  upstreamId: string;
  displayName: string;
  createdAt?: number;
  ownedBy?: string;
  pricing?: { inputPerMTokens?: number; outputPerMTokens?: number; currency?: string };
  /** 数据来源与时间，供 UI 显示「这个价格是什么时候、从哪来的」。 */
  source: string;
  observedAt: string;
}
