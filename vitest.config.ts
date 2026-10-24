// vitest.config.ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        fileParallelism: false,
        testTimeout: 15000,
        exclude: ['**/node_modules/**', '**/build/**'],
    },
});