import { z } from 'zod';

/**
 * OpenAI Chat Completions 的线格式 Schema。
 *
 * 用 looseObject 保留未知字段：拒绝策略需要看到字段本身才能给出
 * 「哪个字段不被支持」的明确报错，静默丢弃是最坏的选项。
 */

export const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  response_format: z.unknown().optional(),
  n: z.number().optional(),
  logprobs: z.unknown().optional(),
  audio: z.unknown().optional(),
  modalities: z.unknown().optional(),
  user: z.string().optional(),
  seed: z.number().optional(),
});

export type ChatRequestWire = z.infer<typeof chatRequestSchema>;

export const toolCallWireSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

export const toolWireSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const messageWireSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallWireSchema).optional(),
});

export const chatResponseWireSchema = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string(),
  choices: z.array(
    z.looseObject({
      index: z.number().optional(),
      message: messageWireSchema.optional(),
      delta: messageWireSchema.optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      prompt_tokens_details: z.looseObject({ cached_tokens: z.number().optional() }).optional(),
      completion_tokens_details: z
        .looseObject({ reasoning_tokens: z.number().optional() })
        .optional(),
    })
    .optional(),
});

export type ChatResponseWire = z.infer<typeof chatResponseWireSchema>;

export const errorWireSchema = z.looseObject({
  error: z
    .looseObject({
      message: z.string().optional(),
      type: z.string().optional(),
      code: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

export const modelListWireSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      object: z.string().optional(),
      created: z.number().optional(),
      owned_by: z.string().optional(),
    }),
  ),
});

export type ModelListWire = z.infer<typeof modelListWireSchema>;
