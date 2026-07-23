import { FlatCompat } from '@eslint/eslintrc';
import baseConfig from '../../eslint.config.mjs';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...baseConfig,
  ...compat.extends('plugin:@next/next/recommended'),
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];
