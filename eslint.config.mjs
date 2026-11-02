import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'coverage/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
        rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
    },
    {
        files: ['app.js', 'fog.js'],
        languageOptions: { globals: { L: 'readonly', JSZip: 'readonly', pako: 'readonly', __CARTO_API_KEY__: 'readonly', __JSZIP_URL__: 'readonly', __JSZIP_INTEGRITY__: 'readonly', __PAKO_URL__: 'readonly', __PAKO_INTEGRITY__: 'readonly' } },
    },
    {
        files: ['import-client.js'],
        languageOptions: { globals: { __IMPORT_WORKER_URL__: 'readonly' } },
    },
];
