// Fixture recorder. When LOREKIT_HOOK_RECORD points at a directory, every hook
// invocation writes the exact payload the host sent to
// <dir>/<adapter>-<event>.json. Run each framework ONCE with this env set to
// harvest real fixtures; the replay tests then run offline forever.
import fs from 'node:fs';
import path from 'node:path';

export function recordFixture(adapter, event, raw) {
  const dir = process.env.LOREKIT_HOOK_RECORD;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let stdin;
    try {
      stdin = JSON.parse(raw);
    } catch {
      stdin = raw; // keep the raw string if it was not valid JSON
    }
    const name = `${adapter}-${event || 'unknown'}.json`;
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ adapter, event: event || null, stdin }, null, 2) + '\n',
    );
  } catch {
    // Recording must never affect the host — swallow any error.
  }
}
