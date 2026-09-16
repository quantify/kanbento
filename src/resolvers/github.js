import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// The `github:` resolver — rung 1 of the watch primitive's namespace→resolver table
// (watch.js). A resolver FETCHES and normalizes; it interprets nothing (the diff detector
// and the matcher own interpretation). It returns a stable snapshot object the generic
// diff can deep-compare across checks, so only the fields we normalize here drive change
// detection (raw API churn — etag, node_id — never leaks into a diff).
//
// Two id shapes:
//   owner/repo#N  — an issue or a PR (the issues endpoint carries both; a `pull_request`
//                   sub-object marks a PR, and the pulls endpoint gives authoritative merged)
//   owner/repo    — the repo itself (+ its latest release, if any)
//
// Auth + transport ride the `gh` CLI (already authenticated on the operator's machine); a
// non-zero exit (network, 404, rate-limit) rejects — watch.js records it in state and keeps
// checking the other watches (a resolver failure never crashes the check run).

const ISSUE_RE = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;
const REPO_RE = /^([^/\s]+)\/([^/#\s]+)$/;

// Run `gh api <path>` and parse the JSON body. A 404/absent resource can be tolerated by
// the caller (`allow404`) — the latest-release probe returns null rather than failing the
// whole snapshot when a repo has cut no releases.
async function ghApi(apiPath, { allow404 = false } = {}) {
  try {
    const { stdout } = await execFileP('gh', ['api', apiPath], { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    if (allow404 && /HTTP 404|Not Found/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) return null;
    const detail = String(e.stderr ?? e.message ?? '').trim().split('\n')[0];
    throw new Error(`gh api ${apiPath} failed: ${detail || 'unknown error'}`);
  }
}

// Normalize an issue/PR into the watched shape. Labels flatten to their names, comments to
// a count — the human-meaningful fields, not the raw payload. `merged` is null for a plain
// issue; for a PR it comes from the authoritative pulls endpoint (.merged), so a diff can
// fire the moment a PR merges.
async function issueSnapshot(owner, repo, number) {
  const issue = await ghApi(`repos/${owner}/${repo}/issues/${number}`);
  const isPR = issue.pull_request != null;
  let merged = null;
  if (isPR) {
    const pr = await ghApi(`repos/${owner}/${repo}/pulls/${number}`);
    merged = pr?.merged === true || pr?.merged_at != null;
  }
  return {
    kind: isPR ? 'pr' : 'issue',
    state: issue.state ?? null,
    merged,
    title: issue.title ?? null,
    labels: Array.isArray(issue.labels) ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean).sort() : [],
    comments: issue.comments ?? 0,
    updated_at: issue.updated_at ?? null,
    closed_at: issue.closed_at ?? null,
  };
}

// Normalize a repo + its latest release tag. `latest_release_tag` is null when the repo has
// cut no releases (the /releases/latest probe 404s — tolerated).
async function repoSnapshot(owner, repo) {
  const r = await ghApi(`repos/${owner}/${repo}`);
  const release = await ghApi(`repos/${owner}/${repo}/releases/latest`, { allow404: true });
  return {
    kind: 'repo',
    pushed_at: r.pushed_at ?? null,
    default_branch: r.default_branch ?? null,
    open_issues: r.open_issues_count ?? null,
    latest_release_tag: release?.tag_name ?? null,
    stargazers: r.stargazers_count ?? null,
  };
}

// The resolver contract: id part → normalized snapshot. Shape-dispatch on the id; an
// unrecognized shape is a loud error (watch.js records it, continues).
export async function resolve(id) {
  const s = String(id ?? '').trim();
  const issue = s.match(ISSUE_RE);
  if (issue) return issueSnapshot(issue[1], issue[2], issue[3]);
  const repo = s.match(REPO_RE);
  if (repo) return repoSnapshot(repo[1], repo[2]);
  throw new Error(`github: "${id}" is not owner/repo#N (issue/PR) or owner/repo (repo)`);
}
