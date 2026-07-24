// Derive LoreKit scope strings from the git working directory.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

// git@github.com:Owner/Repo.git  →  owner/repo
// https://github.com/Owner/Repo  →  owner/repo
export function ownerRepoFromRemote(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/i, '');
  s = s.replace(/^git@[^:]+:/, ''); // scp-style
  s = s.replace(/^ssh:\/\/git@[^/]+\//, '');
  s = s.replace(/^https?:\/\/[^/]+\//, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return `${owner}/${repo}`.toLowerCase();
}

// Returns { ownerRepo, branch, repoScope, branchScope, projectScope, readOrder }.
export function deriveScope(cwd = process.cwd()) {
  const remote = git(['config', '--get', 'remote.origin.url'], cwd);
  const ownerRepo = ownerRepoFromRemote(remote);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const root = git(['rev-parse', '--show-toplevel'], cwd) || cwd;
  const projectName = path.basename(root).toLowerCase();

  const repoScope = ownerRepo ? `repo::${ownerRepo}` : null;
  const branchScope =
    ownerRepo && branch && branch !== 'HEAD'
      ? `branch::${ownerRepo}::${branch.toLowerCase()}`
      : null;
  const projectScope = `project::${projectName}`;

  const readOrder = [branchScope, repoScope, 'global'].filter(Boolean);

  return {
    ownerRepo,
    branch,
    projectName,
    repoScope,
    branchScope,
    projectScope,
    readOrder,
    hasRemote: Boolean(ownerRepo),
  };
}
