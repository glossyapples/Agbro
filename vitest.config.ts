import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Don't accidentally load Next.js/Prisma server code at collection time.
    globals: false,
    // Run test files in parallel but tests within a file sequentially — our
    // unit tests are pure; mocks live in setup files when needed.
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/db.ts', 'src/lib/auth/**', '**/*.d.ts', 'src/lib/alpaca.ts'],
    },
  },
});
