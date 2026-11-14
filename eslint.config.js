import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const AGENT_SDKS = [
  { group: ['@anthropic-ai/*'], home: 'packages/adapters/claude', agent: 'Claude' },
  { group: ['@agentclientprotocol/*'], home: 'packages/adapters/acp', agent: 'ACP' },
  { group: ['@zed-industries/*'], home: 'packages/adapters/codex', agent: 'Codex' },
];

function agentSdkRules() {
  const rule = (sdks) => ({
    'no-restricted-imports': [
      'error',
      {
        patterns: sdks.map((sdk) => ({
          group: sdk.group,
          message: `${sdk.agent}-specific code belongs in ${sdk.home}.`,
        })),
      },
    ],
  });
  return [
    { files: ['**/*.ts', '**/*.tsx'], rules: rule(AGENT_SDKS) },
    ...AGENT_SDKS.map((sdk) => ({
      files: [`${sdk.home}/**/*.ts`],
      rules: rule(AGENT_SDKS.filter((other) => other !== sdk)),
    })),
  ];
}

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '**/test-results/**',
      'packages/cli/pack/**',
    ],
  },
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
  // Agent-specific SDKs stay inside their adapter packages (see CLAUDE.md).
  // One rule lists all of them; each adapter package gets the rule without its
  // own SDK. (Separate blocks would not add up: the last one would win.)
  ...agentSdkRules(),
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // Tests may assert presence with `!`; a wrong guess fails the test anyway.
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
  prettier,
);
