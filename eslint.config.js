// Flat config (ESLint 9+). Deliberately light: this is a personal-scale CLI,
// so the rules here catch real mistakes (unused code, accidental fallthrough,
// bad promise usage) and stay out of the way on style.
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'host/**'],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // typescript-eslint's non-type-checked recommended set.
      ...tseslint.configs['flat/recommended']
        .flatMap((c) => (c.rules ? [c.rules] : []))
        .reduce((all, rules) => ({ ...all, ...rules }), {}),

      // Underscore prefix is the escape hatch for a deliberately unused
      // binding (e.g. a parameter kept for signature compatibility).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // TypeScript already reports undefined identifiers, and this rule has no
      // knowledge of Node globals without an extra `globals` dependency.
      'no-undef': 'off',

      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
];
