import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger, newToken, stdoutSink } from '@openferry/core';
import { createGateway } from '@openferry/gateway';
import { createProviders, loadConfigFile } from '@openferry/config-manager';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultConfigPath(): string {
  const candidate = join(homedir(), '.openferry', 'config.json');
  return existsSync(candidate) ? candidate : '';
}

async function main(): Promise<void> {
  const configPath = argValue('--config') ?? process.env['OPENFERRY_CONFIG'] ?? defaultConfigPath();
  if (!configPath) {
    process.stderr.write(
      'OpenFerry gateway\n\n' +
        'No config file found. Create ~/.openferry/config.json or pass --config <path>.\n\n' +
        'Minimal config:\n' +
        JSON.stringify(
          {
            port: 41980,
            providers: [
              {
                id: 'openai',
                type: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyEnv: 'OPENAI_API_KEY',
              },
            ],
          },
          null,
          2,
        ) +
        '\n',
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfigFile(configPath);
  const logger = createLogger({ level: 'info', sink: stdoutSink });
  const { providers, warnings } = createProviders(config.providers);
  for (const warning of warnings) {
    logger.warn('provider.missing_credential', {
      providerId: warning.providerId,
      message: warning.message,
    });
  }

  const token = process.env['OPENFERRY_TOKEN'] ?? newToken();
  const gateway = createGateway({
    providers,
    token,
    host: config.host,
    port: Number(argValue('--port') ?? config.port),
    maxConcurrency: config.maxConcurrency,
    maxBodyBytes: config.maxBodyBytes,
    logger,
  });

  const { url } = await gateway.start();
  process.stdout.write(`\nOpenFerry gateway listening on ${url}\n`);
  process.stdout.write(`Token: ${token}\n`);
  process.stdout.write(`Config: ${configPath}\n\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n${signal} received, shutting down…\n`);
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
