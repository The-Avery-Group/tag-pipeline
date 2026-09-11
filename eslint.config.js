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
      'crm-ui/readable-copy': 'error',
      'crm-ui/shared-textarea': 'error',
    },
    plugins: {
      'crm-ui': {
        rules: {
          'readable-copy': {
            meta: { type: 'suggestion', schema: [], messages: { punctuation: 'Do not use em dashes in app text. Use clear sentences or appropriate punctuation.' } },
            create(context) {
              const check = (node, value) => {
                if (typeof value === 'string' && value.includes('\u2014')) context.report({ node, messageId: 'punctuation' })
              }
              return {
                Literal: (node) => check(node, node.value),
                JSXText: (node) => check(node, node.value),
                TemplateElement: (node) => check(node, node.value.cooked),
              }
            },
          },
          'shared-textarea': {
            meta: { type: 'suggestion', schema: [], messages: { shared: 'Use AutoTextarea so multiline fields resize consistently across the app.' } },
            create(context) {
              return {
                JSXOpeningElement(node) {
                  if (node.name.name === 'textarea' && !context.filename.endsWith('/Common/AutoTextarea.jsx')) {
                    context.report({ node, messageId: 'shared' })
                  }
                },
              }
            },
          },
        },
      },
    },
  },
]
