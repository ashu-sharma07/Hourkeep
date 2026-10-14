import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'spikes/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    // Plain Node scripts (e2e tooling) have no TypeScript types to supply globals.
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
