import { defineConfig } from 'vitest/config';

// The default, fast suite (`npm test`): use cases + routes against
// `InMemory<X>Repository` doubles only — no live database (the locked
// convention, docs/BUILD-PLAN.md). Prisma repository contract tests live in
// `*.integration.test.ts` files and run only via `npm run test:integration`
// (`vitest.integration.config.ts`) — see docs/testing.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
  },
});
