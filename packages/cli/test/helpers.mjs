// Shared test helpers for the CLI suite. Not a test file (no `.test.mjs`), so
// `node --test test/*.test.mjs` never runs it as a suite — it is imported.

// Run `fn` with HOME and USERPROFILE pointed at `home`, then restore both to
// exactly their prior state (including "was unset"). Async-safe: `fn` may return
// a promise and the restore runs in a `.finally`, so it fires whether `fn`
// resolves or rejects. Replaces the hand-rolled HOME save/restore blocks that
// had been copy-pasted across install.test.mjs and uninstall.test.mjs.
export function withHome(home, fn) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    });
}

/**
 * Stub `globalThis.fetch` and run `fn`, capturing every request it makes.
 *
 * Same shape as the stub `migrate.test.mjs` hand-rolled for `RemoteStore` —
 * lifted here so `policy.test.mjs`/`groom.test.mjs`/`store.test.mjs` share it
 * rather than re-deriving it a third time. Deliberately NOT a real loopback
 * HTTP server: this repo's `cli:test` known-flaky surface is exactly that
 * shape (the spawned child's `fetch` never arrives in a container), and
 * everything worth pinning about a policy/groom request — what landed ON THE
 * WIRE — is visible from a stubbed `fetch` without one.
 *
 * `respond({ method, url, body }, calls)` returns `{ status, body, headers }`
 * for the just-made call, or a falsy value to take the default (200, `{}`).
 * `endpoint`/`token` are passed straight to `createRemoteStore` by callers
 * that build their own store — this helper only owns the fetch stub, not env
 * vars, since `resolveStores`/`createRemoteStore` both take an explicit
 * `endpoint`/`token` argument that a caller can set directly instead of
 * routing through `LOREKIT_MCP_URL`/`LOREKIT_TOKEN`.
 */
export async function withRemote(fn, { respond = null } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const answer = (respond && respond(call, calls)) || null;
    const status = answer?.status ?? 200;
    const body = answer?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Mock',
      headers: { get: (h) => (answer?.headers ?? {})[String(h).toLowerCase()] ?? null },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
