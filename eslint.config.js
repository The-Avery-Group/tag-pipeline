import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    rules: {
      // JSX imports need eslint-plugin-react for precise unused-import
      // analysis. Keep this non-blocking until that plugin is introduced.
      'no-unused-vars': 'off',
      'no-undef': 'error',
    },
  },
]
