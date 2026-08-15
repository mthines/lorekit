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
