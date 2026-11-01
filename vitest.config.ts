import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

/**
 * Packages are consumed from source in tests so `pnpm test` never requires a prior
 * `tsc -b`. Runtime (Node/Electron) still resolves the built `dist` output through
 * each package's `exports` map.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@openferry/core': pkg('core'),
      '@openferry/canonical': pkg('protocols/canonical'),
      '@openferry/protocol-openai-chat': pkg('protocols/openai-chat'),
      '@openferry/provider-contract': pkg('providers/contract'),
      '@openferry/provider-openai-compatible': pkg('providers/openai-compatible'),
      '@openferry/testkit': pkg('testkit'),
      '@openferry/gateway': pkg('gateway'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
});
