import { FlatCompat } from '@eslint/eslintrc';
import reactHooks from 'eslint-plugin-react-hooks';
import baseConfig from '../../eslint.config.mjs';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// ── Local rule: no-non-async-use-server-export ────────────────────────────────
// A file with a top-level `'use server'` directive may only EXPORT async
// functions — Next.js rejects any other export at BUILD time ("Only async
// functions are allowed to be exported in a 'use server' file"). `nx typecheck`
// does not model this, so the failure only surfaces in `next build` (Vercel).
// This rule moves that failure into the `lint` gate, which runs on every PR.
//
// It flags value/`const` exports and non-async function exports; it allows
// async functions and type-only exports (`export type` / `export interface` are
// erased and never reach the runtime the directive governs).
const noNonAsyncUseServerExport = {
  meta: {
    type: 'problem',
    docs: {
      description: "In a 'use server' file, only async functions may be exported",
    },
    schema: [],
    messages: {
      badExport:
        "A 'use server' file may only export async functions — `{{name}}` is a {{kind}}. " +
        'Move it to a non-"use server" module (or make it a module-local const / an async ' +
        'function). This breaks the Next.js/Vercel build; `nx typecheck` does not catch it.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    // Scan the directive prologue (leading string-literal statements) for
    // `'use server'`. Stop at the first non-directive statement.
    let isServerFile = false;
    for (const node of sourceCode.ast.body) {
      const isStringDirective =
        node.type === 'ExpressionStatement' &&
        node.expression?.type === 'Literal' &&
        typeof node.expression.value === 'string';
      if (!isStringDirective) break;
      if (node.directive === 'use server' || node.expression.value === 'use server') {
        isServerFile = true;
        break;
      }
    }
    if (!isServerFile) return {};

    const isAsyncFn = (n) =>
      !!n &&
      (n.type === 'ArrowFunctionExpression' ||
        n.type === 'FunctionExpression' ||
        n.type === 'FunctionDeclaration') &&
      n.async === true;

    const isFn = (n) =>
      !!n &&
      (n.type === 'ArrowFunctionExpression' ||
        n.type === 'FunctionExpression' ||
        n.type === 'FunctionDeclaration');

    return {
      ExportNamedDeclaration(node) {
        // `export type { … }` — type-only, erased, allowed.
        if (node.exportKind === 'type') return;

        const decl = node.declaration;
        if (!decl) return; // `export { a, b }` specifiers — binding resolved elsewhere; skip.

        // Type declarations are erased — allowed regardless of the directive.
        if (
          decl.type === 'TSInterfaceDeclaration' ||
          decl.type === 'TSTypeAliasDeclaration'
        ) {
          return;
        }

        if (decl.type === 'FunctionDeclaration') {
          if (!decl.async) {
            context.report({
              node: decl.id ?? decl,
              messageId: 'badExport',
              data: { name: decl.id?.name ?? '(default)', kind: 'non-async function' },
            });
          }
          return;
        }

        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (isAsyncFn(d.init)) continue;
            context.report({
              node: d,
              messageId: 'badExport',
              data: {
                name: d.id?.type === 'Identifier' ? d.id.name : '(value)',
                kind: isFn(d.init) ? 'non-async function' : 'value',
              },
            });
          }
        }
      },
    };
  },
};

export default [
  ...baseConfig,
  ...compat.extends('plugin:@next/next/recommended'),
  {
    // Register the react-hooks plugin so its rules resolve — several source
    // files carry `// eslint-disable-next-line react-hooks/exhaustive-deps`
    // directives that error out ("rule not found") when the plugin is absent.
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      lorekit: { rules: { 'no-non-async-use-server-export': noNonAsyncUseServerExport } },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'lorekit/no-non-async-use-server-export': 'error',
    },
  },
  {
    // `storybook-static/**` is the Storybook build artifact (gitignored); the
    // MSW worker is a generated vendor file — neither should be linted.
    ignores: [
      '.next/**',
      'node_modules/**',
      'storybook-static/**',
      'public/mockServiceWorker.js',
    ],
  },
];
