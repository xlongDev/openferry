import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '@openferry/provider-openai-compatible';
import type { ProviderAdapter } from '@openferry/provider-contract';

/**
 * 配置文件是**唯一**的供应商来源（阶段 3 之前）。
 * 密钥永远通过环境变量引用（`apiKeyEnv`），配置文件里不写明文。
 */

const providerSchema = z.object({
  id: z.string().min(1),
  type: z.literal('openai-compatible'),
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      tools: z.boolean().optional(),
      parallelToolCalls: z.boolean().optional(),
      images: z.boolean().optional(),
      jsonObject: z.boolean().optional(),
      jsonSchema: z.boolean().optional(),
      usageInStream: z.boolean().optional(),
      reasoning: z.boolean().optional(),
    })
    .optional(),
});

export const configFileSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(41980),
  maxConcurrency: z.number().int().min(1).max(256).default(16),
  maxBodyBytes: z
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),
  providers: z.array(providerSchema).default([]),
});

export type ConfigFile = z.infer<typeof configFileSchema>;
export type ProviderEntry = z.infer<typeof providerSchema>;

export interface ProviderBuildResult {
  providers: ProviderAdapter[];
  warnings: Array<{ providerId: string; message: string }>;
}

export async function loadConfigFile(path: string): Promise<ConfigFile> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config file ${path} is not valid JSON`);
  }
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`config file ${path} is invalid:\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

export function createProviders(
  entries: ProviderEntry[],
  env: NodeJS.ProcessEnv = process.env,
): ProviderBuildResult {
  const warnings: ProviderBuildResult['warnings'] = [];
  const providers = entries.map((entry) => {
    const apiKey = entry.apiKeyEnv === undefined ? undefined : env[entry.apiKeyEnv];
    if (entry.apiKeyEnv !== undefined && apiKey === undefined) {
      warnings.push({
        providerId: entry.id,
        message: `environment variable ${entry.apiKeyEnv} is not set`,
      });
    }
    return new OpenAICompatibleProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(entry.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: entry.allowPrivateNetwork }),
      ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
    });
  });
  return { providers, warnings };
}
