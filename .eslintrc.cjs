const vitestPlugin = require('eslint-plugin-vitest');

module.exports = {
  env: {
    node: true,
    es2020: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: ['./tsconfig.eslint.json'],
  },
  plugins: ['@typescript-eslint', 'import', 'security', 'vitest'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:security/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-misused-promises': [
      'error',
      {
        checksVoidReturn: false,
      },
    ],
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'never',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-unresolved': ['error', { ignore: ['^node:', '^@modelcontextprotocol/sdk/'] }],
    'import/no-named-as-default': 'off',
  },
  settings: {
    'import/resolver': {
      node: true,
      typescript: { project: ['tsconfig.json', 'tsconfig.eslint.json'] },
    },
  },
  overrides: [
    {
      files: ['**/*.ts'],
      excludedFiles: ['src/http.ts'],
      rules: {
        'no-restricted-imports': ['error', { paths: [{ name: 'zod-v3', message: 'Use Zod v4. zod-v3 allowed only in src/http.ts' }] }],
      },
    },
    {
      files: ['src/http.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      files: ['tests/**/*.ts'],
      env: {
        'vitest/env': true,
        node: true,
      },
      plugins: ['vitest'],
      rules: {
        ...vitestPlugin.configs.recommended.rules,
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        'security/detect-object-injection': 'off',
      },
    },
    {
      files: ['src/logger.ts'],
      rules: {
        'security/detect-object-injection': 'off',
      },
    },
  ],
};
