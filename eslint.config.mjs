// ESLint flat config for the Codey monorepo.
//
// Scope note: this is deliberately a *starting* ruleset. The repo had no
// static analysis at all, so turning on the full recommended set at `error`
// would bury real findings under thousands of pre-existing style violations.
// Rules that catch genuine bugs are errors; stylistic ones are warnings or
// off, and can be tightened once the existing warnings are burned down.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output, deps, and nested worktrees are not ours to lint.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/release-local/**',
      '**/build/**',
      '**/out/**',
      '.worktrees/**',
      'chrome-extension/**',
      'docs/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Severity policy for rules that fire on pre-existing, deliberate code.
    // Applied to every linted file so JS/MJS/CJS get the same treatment as TS.
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      // `require-atomic-updates` cannot tell a real await-race from the very
      // common `e.target.value` / single-assignment-after-await patterns, and
      // every current hit in this repo is the latter. Kept visible, not fatal.
      'require-atomic-updates': 'warn',
      // Escapes like `[.\-]` and `\/` are redundant but deliberate and easier
      // to read; control-char classes are intentional sanitisers.
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-regex-spaces': 'warn',
      // `let x: T | undefined` assigned once later is not `const`-able, so
      // this rule's suggestion is often not applicable.
      'prefer-const': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // TypeScript already resolves identifiers; `no-undef` on TS only
      // produces false positives for types and ambient globals.
      'no-undef': 'off',

      // --- Real-bug rules: errors ---------------------------------------
      // `catch {}` with no binding is idiomatic here; an empty block with a
      // binding usually means a swallowed error someone meant to handle.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',

      // --- Noise from an untyped-lint-free history: warnings -------------
      // `any` is pervasive in the IPC and agent-adapter layers. Flag it so it
      // stops spreading, without failing the build on day one.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Electron main/preload legitimately use `require` for lazy loading.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  {
    // Renderer only: hook rules need React in scope.
    files: ['codey-mac/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Calling a hook conditionally is always a bug — error.
      'react-hooks/rules-of-hooks': 'error',
      // Stale-closure detector. There are ~180 effects in this app and no
      // rule has ever checked them, so start at warn.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Tests reach for `any` and non-null assertions to build fixtures.
    files: ['**/*.test.{ts,tsx}', '**/vitest.setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Repo scripts are plain Node ESM/CJS, in every workspace.
    files: [
      'scripts/**/*.{mjs,cjs,js}',
      '**/scripts/**/*.{mjs,cjs,js}',
      '**/*.config.{ts,mts,js,mjs}',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  {
    // CommonJS files: `require`/`module`/`__dirname` are ambient, and
    // sourceType must be `commonjs` or the parser rejects them.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs },
    },
    rules: {
      // `require()` is the whole point of a .cjs file.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
