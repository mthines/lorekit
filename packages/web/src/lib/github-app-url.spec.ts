import { describe, it, expect, afterEach } from 'vitest';
import { resolveGithubAppInstallUrl } from './github-app-url';

// resolveGithubAppInstallUrl reads NEXT_PUBLIC_GITHUB_APP_SLUG at call time.
// Snapshot and restore it around every case so the tests don't leak env state
// into each other (or into the rest of the suite).
const KEY = 'NEXT_PUBLIC_GITHUB_APP_SLUG';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('resolveGithubAppInstallUrl', () => {
  it('builds the public install URL from the slug', () => {
    process.env[KEY] = 'lorekitbot';
    expect(resolveGithubAppInstallUrl()).toBe(
      'https://github.com/apps/lorekitbot/installations/new',
    );
  });

  it('returns null when the slug is unset', () => {
    delete process.env[KEY];
    expect(resolveGithubAppInstallUrl()).toBeNull();
  });

  it('returns null when the slug is an empty string', () => {
    process.env[KEY] = '';
    expect(resolveGithubAppInstallUrl()).toBeNull();
  });

  it('returns null when the slug is whitespace only', () => {
    process.env[KEY] = '   ';
    expect(resolveGithubAppInstallUrl()).toBeNull();
  });

  it('trims surrounding whitespace before building the URL', () => {
    process.env[KEY] = '  lorekitbot  ';
    expect(resolveGithubAppInstallUrl()).toBe(
      'https://github.com/apps/lorekitbot/installations/new',
    );
  });

  it('percent-encodes the slug so it cannot break out of the path segment', () => {
    process.env[KEY] = 'weird slug/../x';
    expect(resolveGithubAppInstallUrl()).toBe(
      `https://github.com/apps/${encodeURIComponent('weird slug/../x')}/installations/new`,
    );
  });
});
