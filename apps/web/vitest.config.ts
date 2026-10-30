import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    maxWorkers: 1,
    fileParallelism: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/workspace/api.ts',
        'src/workspace/useResource.ts',
        'src/workspace/outbox.ts',
        'src/workspace/Recovery.tsx',
      ],
    },
  },
});
