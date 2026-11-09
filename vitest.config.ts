// vitest.config.ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        fileParallelism: false,
        testTimeout: 180_000,
        hookTimeout: 180_000,
        exclude: ['**/node_modules/**', '**/build/**'],
        setupFiles: ['./vitest.setup.ts'],
    },
});