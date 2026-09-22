import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Lint policy for CivicWorkDesk.
 *
 * The rules below are not decoration. Two groups encode hard product requirements:
 *   - `no-restricted-syntax` blocks the injection primitives the legacy prototype used
 *     (`eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML`, `document.write`).
 *   - `no-restricted-globals` blocks blocking native dialogs, which the legacy prototype
 *     used for renames and which are neither accessible nor testable.
 *
 * NOTE on accessibility linting: `eslint-plugin-jsx-a11y` has no release compatible with
 * ESLint 10 (its peer range stops at ^9), and ESLint 9 is deprecated upstream. Rather than
 * force an unsupported peer, static JSX a11y linting is omitted and replaced by
 * `@axe-core/playwright` assertions over rendered states plus a documented manual
 * keyboard/focus review. See docs/dependencies.md and docs/qa-plan.md.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
      '_private_reference/**',
      '_review_packages/**',
      'dev-dist/**',
      /*
       * Audit evidence, not build input.
       *
       * `scripts/audit/` holds probes that are *copied into an older checkout* and run there, so they
       * are written against that commit's API surface and belong to no tsconfig project here. They are
       * packaged for inspection (see review/AUDIT_REGRESSION_RESULTS.md) and deliberately excluded from
       * linting and typechecking of this tree.
       */
      'scripts/audit/**',
      /*
       * `scripts/fixtures/` generates the demo archive used by the screenshots and by review. It
       * writes files as a side effect, runs under its own vitest config, and belongs to no tsconfig
       * project here for the same reason the audit probes do.
       */
      'scripts/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        /*
         * Both TypeScript projects are listed explicitly. `projectService: true` resolves a file
         * to the nearest `tsconfig.json` only, so everything covered by `tsconfig.node.json`
         * (vite/vitest/playwright configs and `tests/e2e`) would fail to parse and silently lose
         * every type-aware rule.
         */
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is forbidden. Render escaped text; see docs/security.md.',
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'innerHTML is forbidden. Use React rendering; see docs/security.md.',
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message: 'outerHTML is forbidden. Use React rendering; see docs/security.md.',
        },
        {
          selector: "MemberExpression[object.name='document'][property.name='write']",
          message: 'document.write is forbidden; it was a legacy print-window hack.',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'new Function is forbidden (CSP + injection risk).',
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: 'eval is forbidden (CSP + injection risk).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=1] > Literal",
          message:
            'Do not construct a Date from a literal string. Use src/domain/dates for date-only values.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Use the in-app dialog/toast components instead.' },
        { name: 'confirm', message: 'Use ConfirmDialog so the flow is accessible and testable.' },
        { name: 'prompt', message: 'Use a real form field instead of a blocking native prompt.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message:
            'localStorage is reserved for UI preferences via src/services/storage. Records live in IndexedDB.',
        },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
      complexity: ['error', 18],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      /*
       * Full-width spaces (U+3000) are meaningful punctuation in the Chinese UI strings and in
       * generated report text, so they are permitted inside strings, templates and comments —
       * but still forbidden in code, where they would be an invisible syntax hazard.
       */
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true, skipComments: true, skipJSXText: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The service-worker update bridge and the storage module are the two places
    // allowed to touch the platform APIs the rules above restrict.
    files: ['src/services/storage/**/*.ts', 'src/app/pwa/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'max-lines': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'max-lines': 'off',
    },
  },
  {
    // Plain-JS tooling files are not part of either TypeScript project, so type-aware rules
    // cannot run against them.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
