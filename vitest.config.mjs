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
                statements: 82, branches: 73, functions: 86, lines: 85,
                'app.js': { statements: 75, branches: 62, functions: 78, lines: 80 },
                'app-dialogs.js': { statements: 92, branches: 84, functions: 100, lines: 93 },
                'export-data.js': { statements: 95, branches: 90, functions: 100, lines: 95 },
                'route-export.js': { statements: 95, branches: 90, functions: 100, lines: 95 },
                'route-list.js': { statements: 95, branches: 85, functions: 100, lines: 99 },
                'fog.js': { statements: 95, branches: 83, functions: 100, lines: 98 },
                'xml-import.js': { statements: 98, branches: 91, functions: 100, lines: 99 },
            },
        },
    },
});
