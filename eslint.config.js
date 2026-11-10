import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', '**/test-results/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.js', '*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Claude-specific types stay inside the Claude adapter (see CLAUDE.md).
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/adapters/claude/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/*'],
              message: 'Claude-specific code belongs in packages/adapters/claude.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // Tests may assert presence with `!`; a wrong guess fails the test anyway.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
  prettier,
);
