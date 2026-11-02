import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        coverage: {
            provider: 'v8',
            include: ['*.js'],
            reporter: ['text', 'json-summary', 'html'],
            thresholds: {
                statements: 80, branches: 71, functions: 84, lines: 83,
                'app.js': { statements: 70, branches: 56, functions: 73, lines: 74 },
                'app-dialogs.js': { statements: 92, branches: 84, functions: 100, lines: 93 },
                'route-list.js': { statements: 95, branches: 85, functions: 100, lines: 99 },
                'fog.js': { statements: 95, branches: 83, functions: 100, lines: 98 },
                'xml-import.js': { statements: 98, branches: 91, functions: 100, lines: 99 },
            },
        },
    },
});
