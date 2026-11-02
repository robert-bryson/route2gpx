import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        coverage: {
            provider: 'v8',
            include: ['*.js'],
            reporter: ['text', 'json-summary', 'html'],
            thresholds: { statements: 58, branches: 52, functions: 64, lines: 61 },
        },
    },
});
