/**
 * GitHub App REST client — the impure shell around github-app-jwt.ts.
 *
 * This is the ONLY place the App's private-key material is read
 * (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY, Supabase secrets — never Vercel env,
 * never the browser).  It mints a short-lived RS256 App JWT with Web Crypto and
 * uses it to resolve an installation's account + covered repositories so the
 * dashboard can record the installation WITHOUT waiting on a webhook delivery.
 *
 * All functions fail soft (return null / []) rather than throw, so a missing
 * secret or a transient GitHub error degrades gracefully at the call site.
 */

import { toPkcs8Der, bytesToBase64Url, encodeSigningInput } from './github-app-jwt.ts';

const GITHUB_APP_ID = Deno.env.get('GITHUB_APP_ID') ?? '';
const GITHUB_APP_PRIVATE_KEY = Deno.env.get('GITHUB_APP_PRIVATE_KEY') ?? '';
const GITHUB_API = 'https://api.github.com';

/** Common headers for every GitHub REST call. */
function githubHeaders(bearer: string): HeadersInit {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lorekit-app',
  };
}

/**
 * True when the App credentials are provisioned.  When false the installation
 * sync endpoint returns `app_not_configured` and the dashboard falls back to
 * the webhook-driven linking path.
 */
export function isAppConfigured(): boolean {
  return GITHUB_APP_ID.length > 0 && GITHUB_APP_PRIVATE_KEY.length > 0;
}

/**
 * Mint a signed App JWT (RS256).  `iat` is backdated 30s to absorb clock skew;
 * `exp` is 9 minutes out (GitHub's ceiling is 10).  Returns null on any signing
 * failure (e.g. a malformed private key) rather than throwing.
 */
async function mintAppJwt(): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iat: now - 30, exp: now + 540, iss: GITHUB_APP_ID };
    const signingInput = encodeSigningInput({ alg: 'RS256', typ: 'JWT' }, claims);
    // `toPkcs8Der` returns a `Uint8Array`, whose backing store TypeScript models
    // as `ArrayBufferLike` (it could be a SharedArrayBuffer). `importKey` wants
    // a `BufferSource` over a plain `ArrayBuffer`, so the two do not match.
    // Copying into a freshly allocated ArrayBuffer satisfies it with the same
    // bytes, and does so HERE: `github-app-jwt.ts` is byte-mirrored from
    // packages/mcp-core and cannot change its return type without diverging.
    const der = toPkcs8Der(GITHUB_APP_PRIVATE_KEY);
    const derBuffer = new ArrayBuffer(der.byteLength);
    new Uint8Array(derBuffer).set(der);

    const key = await crypto.subtle.importKey(
      'pkcs8',
      derBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  } catch {
    return null;
  }
}

export interface InstallationInfo {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repos: string[];
}

/**
 * Resolve an installation's account metadata and covered repositories.
 *
 * 1. GET /app/installations/{id}         (App JWT)         → account id/login/type
 * 2. POST /app/installations/{id}/access_tokens (App JWT)  → installation token
 * 3. GET /installation/repositories       (install token)  → full_names (paginated)
 *
 * Returns null when the App is unconfigured, the JWT can't be minted, or the
 * installation lookup fails.  Repo resolution is best-effort: a repo-fetch
 * failure yields an empty list, never null, so the installation still links.
 */
export async function fetchInstallation(installationId: number): Promise<InstallationInfo | null> {
  const appJwt = await mintAppJwt();
  if (!appJwt) return null;

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: githubHeaders(appJwt),
  });
  if (!res.ok) return null;

  // deno-lint-ignore no-explicit-any
  const body: Record<string, any> = await res.json().catch(() => ({}));
  const account = body['account'] ?? {};
  const accountId = Number(account['id']);
  if (!Number.isFinite(accountId) || accountId <= 0) return null;

  const accountType = account['type'] === 'Organization' ? 'Organization' : 'User';
  const repos = await fetchInstallationRepos(installationId, appJwt).catch(() => []);

  return {
    installationId,
    accountId,
    accountLogin: String(account['login'] ?? ''),
    accountType,
    repos,
  };
}

/** Mint an installation access token, then enumerate its repositories (paginated). */
async function fetchInstallationRepos(installationId: number, appJwt: string): Promise<string[]> {
  const tokenRes = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(appJwt),
  });
  if (!tokenRes.ok) return [];
  const { token } = await tokenRes.json().catch(() => ({ token: '' }));
  if (!token) return [];

  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) break;
    const body = await res.json().catch(() => ({ repositories: [] }));
    const batch: string[] = (body.repositories ?? [])
      .map((r: { full_name?: string }) => (r.full_name ?? '').toLowerCase())
      .filter(Boolean);
    names.push(...batch);
    if (batch.length < 100) break;
  }
  return names;
}
