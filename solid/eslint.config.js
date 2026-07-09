// Flat ESLint config for the SolidJS SPA. The core value is
// `eslint-plugin-solid` (official, catches reactivity footguns: destructured
// props, signals out of scope, `.map()` instead of <For>, etc.). Layered on
// top of JS + typescript-eslint recommended (non-type-checked, fast).
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import solid from 'eslint-plugin-solid/configs/typescript'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    ...solid,
    languageOptions: {
      ...solid.languageOptions,
      globals: { ...globals.browser },
    },
    rules: {
      ...solid.rules,
      // Intentional `_`-prefixed params/vars (unused-by-contract) are allowed.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Real reactivity bugs stay errors. These two are correctness-neutral
      // style rules with a large existing backlog (`.map()`→`<For>`, inline
      // style objects) — keep them visible as warnings and migrate incrementally.
      'solid/prefer-for': 'warn',
      'solid/style-prop': 'warn',
    },
  },
)
