// `lorekit quota` — your memories against your plan's cap (GET /memories/quota).
// Remote-only, and exits 1 when the remote cannot answer: a script gating a bulk
// write needs to see that failure, and there is no offline answer to fall back to.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { describeError } from '../shared/lessons-view.mjs';
import { log, heading, status, c } from '../shared/util.mjs';

/** Headroom below this share of the cap earns a warning, so the cap is never a surprise. */
const LOW_HEADROOM_RATIO = 0.1;

export async function quota(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };

  const { remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });
  const { remoteDenied } = resolveDenies(root, { env });

  let section;
  if (remoteDenied) {
    section = { available: false, reason: `disabled by deny constraint (${remoteDenied.source})` };
  } else if (!remote.usable()) {
    section = { available: false, reason: remoteUnavailableReason(connection) };
  } else {
    const res = await remote.quota();
    section = res.ok ? { available: true, ...res.quota } : { available: false, reason: describeError(res) };
  }

  if (args.json) {
    log(JSON.stringify(
      section.available ? { available: true, endpoint: connection.endpoint, ...withoutFlag(section) } : section,
      null,
      2,
    ));
  } else {
    render(section, remote.usable() ? connection.endpoint : undefined);
  }

  // Bounded, non-PII telemetry extras: counts, never a scope, path or token.
  return {
    exitCode: section.available ? 0 : 1,
    'lorekit.cli.quota.available': section.available,
    'lorekit.cli.quota.personal_count': section.available ? section.personal.count : 0,
    'lorekit.cli.quota.personal_limit': section.available ? section.personal.limit : 0,
  };
}

function withoutFlag({ available: _available, ...rest }) {
  return rest;
}

function render(section, endpoint) {
  heading('LoreKit quota');
  if (endpoint) log(`  ${c.dim(endpoint)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    log('');
    return;
  }

  const { plan, personal, org_count: orgCount, total } = section;
  log(`  ${c.dim('plan'.padEnd(9))}${c.bold(plan)}`);
  log(
    `  ${c.dim('personal'.padEnd(9))}${c.bold(`${personal.count} / ${personal.limit}`)}  `
      + c.dim(`(${personal.remaining} left)`),
  );
  if (orgCount > 0) {
    log(`  ${c.dim('org'.padEnd(9))}${orgCount}  ${c.dim("(counted against each org's own cap)")}`);
  }
  log(`  ${c.dim('total'.padEnd(9))}${total}`);

  if (personal.limit > 0 && personal.remaining === 0) {
    status('warn', 'at the cap', 'new personal writes are refused until you archive or delete some');
  } else if (personal.limit > 0 && personal.remaining < personal.limit * LOW_HEADROOM_RATIO) {
    status('warn', 'near the cap', `${personal.remaining} personal writes left`);
  }
  log('');
}
