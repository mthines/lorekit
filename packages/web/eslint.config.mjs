import { FlatCompat } from '@eslint/eslintrc';
import reactHooks from 'eslint-plugin-react-hooks';
import baseConfig from '../../eslint.config.mjs';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...baseConfig,
  ...compat.extends('plugin:@next/next/recommended'),
  {
    // Register the react-hooks plugin so its rules resolve — several source
    // files carry `// eslint-disable-next-line react-hooks/exhaustive-deps`
    // directives that error out ("rule not found") when the plugin is absent.
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];
