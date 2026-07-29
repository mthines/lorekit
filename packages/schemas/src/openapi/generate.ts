import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec } from './spec.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const out = join(dir, '../../../../supabase/functions/api-openapi/openapi.generated.json');
writeFileSync(out, JSON.stringify(generateSpec(), null, 2) + '\n');
console.log('OpenAPI spec written to', out);
