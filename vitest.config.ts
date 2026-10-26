// vitest.config.ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 60_000,
        exclude: ['**/node_modules/**', '**/build/**'],
    },
});