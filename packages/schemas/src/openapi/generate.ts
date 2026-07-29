/**
 * Writes dist/openapi.json — a static reference copy of the OpenAPI spec.
 *
 * Run via: pnpm nx generate:openapi schemas
 *
 * The rest-openapi edge function generates the same spec at runtime, so this
 * file is a convenience artifact for local tooling (Postman, Insomnia, etc.)
 * and is NOT the authoritative runtime source.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiSpec } from './spec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '../../../dist');
const outFile = join(outDir, 'openapi.json');

mkdirSync(outDir, { recursive: true });
const spec = generateOpenApiSpec({ serverUrl: 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1' });
writeFileSync(outFile, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
console.log(`Generated: ${outFile}`);
