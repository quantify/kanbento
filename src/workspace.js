import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { asBoardRoot, writeBoardPointer, removeBoardPointer } from './boards.js';

// The WORKSPACE intake mode — the runner's second materialization axis (parallel
// to params/artifacts). Default `fs`: writes stay confined to the run dir, zero
// git. Opt-in `worktree`: the runner checks out an isolated git worktree INSIDE
// the run dir before the harness runs, and computes the diff of what changed vs
// base FOR FREE at finalize (an implicit `diff` artifact). The PR/push EFFECT is
// never here — it stays in hooks/finalize (this module is pure intake). git
// worktree add touches the board repo's .git/worktrees, but the setup phase runs
// UNSANDBOXED, so that's fine; the checkout itself is under the run dir, already
// the sandbox write-floor.

// Normalize a record's `workspace:` frontmatter into { mode, base, branch }.
// Tolerated + preserved (the folder must stay a valid Agent Skill): a scalar
// "worktree" opts in; a { mode: worktree, base, branch } object carries overrides;
// anything else — absent, "fs", a malformed value — is fs (the zero-change default).
export function declaredWorkspace(rec) {
  const raw = rec?.workspace;
  if (raw == null) return { mode: 'fs' };
  if (typeof raw === 'string') {
    return raw === 'worktree' ? { mode: 'worktree', base: null, branch: null } : { mode: 'fs' };
  }
  if (typeof raw === 'object' && !Array.isArray(raw) && raw.mode === 'worktree') {
    return {
      mode: 'worktree',
      base: raw.base != null ? String(raw.base) : null,
      branch: raw.branch != null ? String(raw.branch) : null,
    };
  }
  return { mode: 'fs' };
}

// Spawn git, resolve its stdout (trimmed on demand), reject with the stderr on a
// nonzero exit. cwd is the repo (or worktree) the command runs against.
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(Object.assign(new Error(`git ${args.join(' ')} failed (exit ${code}): ${err.trim()}`), { code, stderr: err }));
    });
  });
}

// The git repo root that CONTAINS a directory (the board dir), or null when the
// dir is not inside a git repo. worktree mode needs this — it errors clearly when
// null.
export async function findRepoRoot(dir) {
  try {
    return (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  } catch {
    return null;
  }
}

// A stable, param-scoped default branch — `kanbento/<slug>/<hash>` where hash is a
// short DETERMINISTIC digest of the sorted params (no Date/random — same params →
// same branch, so a finalize `gh pr create` updates rather than duplicates). An
// explicit override (a `branch` param or frontmatter) wins wholesale.
export function workspaceBranch(slug, params = {}, override = null) {
  if (override != null && String(override).trim()) return String(override).trim();
  const canon = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const hash = createHash('sha256').update(canon).digest('hex').slice(0, 12);
  return `kanbento/${slug}/${hash}`;
}

// Materialize the worktree: resolve base to a concrete sha (default HEAD), then
// `git worktree add -f -B <branch> <worktreeDir> <baseSha>` off the board repo.
// `-B` creates-or-resets the branch to base, so re-runs with the same params are
// idempotent. Returns { dir, branch, base, baseSha } — persisted to workspace.json
// so a later `--finalize` (a separate process) can diff against the same base.
export async function materializeWorktree({ repoRoot, worktreeDir, branch, base = null }) {
  const baseRef = base || 'HEAD';
  let baseSha;
  try {
    baseSha = (await git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot)).trim();
  } catch (e) {
    throw new Error(`workspace: worktree — base ref "${baseRef}" not resolvable in ${repoRoot}: ${(e.stderr ?? e.message ?? '').trim()}`);
  }
  // Prune stale entries first (a prior run left for inspection, then deleted by
  // hand, can leave a dangling registration that blocks `-B <branch>`).
  try { await git(['worktree', 'prune'], repoRoot); } catch { /* best-effort */ }
  await git(['worktree', 'add', '-f', '-B', branch, worktreeDir, baseSha], repoRoot);
  return { dir: worktreeDir, branch, base: baseRef, baseSha };
}

// Parse `git diff --numstat` into a summary: files touched + total insertions /
// deletions. Binary files report '-' for both counts — surfaced as a file, zero
// lines.
function parseNumstat(numstat) {
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del] = parts;
    const file = parts.slice(2).join('\t');
    const a = add === '-' ? 0 : parseInt(add, 10) || 0;
    const d = del === '-' ? 0 : parseInt(del, 10) || 0;
    insertions += a;
    deletions += d;
    files.push(file);
  }
  return { files, insertions, deletions };
}

// The shared diff primitive: stage everything in the worktree (`git add -A` —
// captures the change whether or not the agent committed), diff the index against
// base, write the full patch to `patchPath`, and return { patch, summary }. Both
// the run-scoped and card-scoped diffs are this against a different base + output.
async function stageAndDiff({ worktreeDir, baseSha, patchPath }) {
  await git(['add', '-A'], worktreeDir);
  const patch = await git(['diff', '--cached', baseSha], worktreeDir);
  const numstat = await git(['diff', '--cached', '--numstat', baseSha], worktreeDir);
  await writeFile(patchPath, patch, 'utf8');
  return { patch: patchPath, summary: parseNumstat(numstat) };
}

// Diff two commits (no working tree) — used when the card worktree is not checked
// out at the branch tip, so an index-based diff would under-report branch work.
async function rangeDiff({ worktreeDir, baseSha, tipSha, patchPath }) {
  const patch = await git(['diff', baseSha, tipSha], worktreeDir);
  const numstat = await git(['diff', '--numstat', baseSha, tipSha], worktreeDir);
  await writeFile(patchPath, patch, 'utf8');
  return { patch: patchPath, summary: parseNumstat(numstat) };
}

// Resolve a base ref for recovery. "HEAD" is ambiguous inside a card worktree
// (HEAD is the card branch tip) — prefer an explicit ref, then main/master, then HEAD.
async function resolveRecoveryBaseRef(cwd, baseRef) {
  const candidates = [];
  if (baseRef && baseRef !== 'HEAD') candidates.push(baseRef);
  candidates.push('main', 'master', 'HEAD');
  for (const c of candidates) {
    try {
      await git(['rev-parse', '--verify', `${c}^{commit}`], cwd);
      return c;
    } catch { /* try next */ }
  }
  throw new Error(`workspace: card worktree — no recoverable base ref in ${cwd}`);
}

// Recover a TRUE card-branch base: merge-base(baseRef, branch).
// - Never-diverged (tip == baseRef tip): returns tip — empty diff is correct.
// - Unique commits on branch: returns the fork point (≠ tip).
// - Fully merged into baseRef (tip is strict ancestor of baseRef tip): FAILS LOUD —
//   merge-base==tip would silently empty the review subject (post-merge re-attach hole).
async function recoverCardBranchBase({ cwd, baseRef, branch }) {
  const resolvedRef = await resolveRecoveryBaseRef(cwd, baseRef);
  let baseSha;
  try {
    baseSha = (await git(['merge-base', resolvedRef, branch], cwd)).trim();
  } catch (e) {
    throw new Error(
      `workspace: card worktree — could not recover base for branch "${branch}" ` +
      `(merge-base with "${resolvedRef}" unresolvable): ${(e.stderr ?? e.message ?? '').trim()}`,
    );
  }
  if (!baseSha) {
    throw new Error(
      `workspace: card worktree — recovered an empty base for branch "${branch}" ` +
      `(no merge-base with "${resolvedRef}")`,
    );
  }
  const tip = (await git(['rev-parse', '--verify', `${branch}^{commit}`], cwd)).trim();
  const baseRefSha = (await git(['rev-parse', '--verify', `${resolvedRef}^{commit}`], cwd)).trim();
  if (baseSha === tip && tip !== baseRefSha) {
    // Branch tip is fully contained in baseRef but is not baseRef itself — almost
    // always "already merged into main and main advanced". Refuse tip-as-base.
    throw new Error(
      `workspace: card worktree — recovered base equals branch tip for "${branch}" ` +
      `(merge-base with "${resolvedRef}" is the tip — branch is fully contained, often already ` +
      `merged). Refusing a tip-as-base that would make the card diff empty. ` +
      `Pass --base at the true fork, or remove and re-open before merge.`,
    );
  }
  return baseSha;
}

// The DIFF FOR FREE: stage everything the agent did in the worktree, then diff the
// index against base. Writes the full patch to <runDir>/diff.patch and returns
// { patch: <path>, summary: { files, insertions, deletions } }. The summary (not
// the whole patch) is what rides an observe capture — card bodies stay sane.
export async function computeWorktreeDiff({ worktreeDir, baseSha, runDir }) {
  return stageAndDiff({ worktreeDir, baseSha, patchPath: join(runDir, 'diff.patch') });
}

// --- card-scoped worktrees (the coordinator's persistent "table") -----------
//
// A SECOND, distinct worktree axis. The run-scoped worktree above is keyed on
// slug+params, lives inside the (gitignored) run dir, and is torn down at
// finalize. This one is keyed on the CARD ID, persists across the stage loop
// (in_progress → review → rework → in_progress → …), and is removed only on an
// explicit call at done/abandon. A delivery coordinator materializes it as step 0
// (before dev), reuses it on every subsequent entry, and diffs base..branch to
// hand a reviewer an unambiguous subject.
//
// Namespaces never collide: branches are `kanbento/card/<id>` (vs the run's
// `kanbento/<slug>/<hash>`); checkouts live under `<dataDir>/worktrees/<id>` (vs
// the run's `<runDir>/repo`).

// The card branch — `kanbento/card/<cardId>`. An explicit override wins wholesale.
export function cardBranch(cardId, override = null) {
  if (override != null && String(override).trim()) return String(override).trim();
  return `kanbento/card/${cardId}`;
}

// The persistent checkout dir for a card — `<dataDir>/worktrees/<cardId>`.
export function cardWorktreeDir(dataDir, cardId) {
  return join(dataDir, 'worktrees', cardId);
}

// The metadata sidecar — `<dataDir>/worktrees/<cardId>.json`, OUTSIDE the checkout
// (so it never lands in the card's own diff). Persists { base, baseSha, branch } so
// a later diff/removal (a separate process, after HEAD has moved) is unambiguous.
function cardWorktreeMetaPath(dataDir, cardId) {
  return join(dataDir, 'worktrees', `${cardId}.json`);
}

// Find an existing card worktree — null when it was never materialized (or the
// checkout was removed by hand). Returns the persisted meta joined to its dir.
export async function findCardWorktree({ dataDir, cardId }) {
  const dir = cardWorktreeDir(dataDir, cardId);
  const metaPath = cardWorktreeMetaPath(dataDir, cardId);
  if (!existsSync(dir) || !existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    return { ...meta, dir, metaPath };
  } catch {
    return null;
  }
}

// --- worktree dep provisioning (auto-guess, zero config) --------------------
//
// A git worktree shares `.git` but NOT ignored/untracked files, so a fresh card
// worktree has none of the main checkout's gitignored build inputs — `npm test`
// (or any tool) can't run there without them. On open we auto-detect the common
// gitignored dependency/config paths PRESENT in the main checkout and bring them
// in — COW-cloned (cheap) and git-excluded (invisible to `git add -A` / the card
// diff). Auto-guess only: no manifest `worktree.carry` and no `.worktreeinclude`
// (both deliberately deferred — see capability:worktrees); a fixed, general set of
// candidates covers the 99% case language-agnostically.

// Directory/file names that are almost always gitignored build inputs. Detected
// wherever they sit — repo root AND one level down (this repo keeps node_modules
// under app/), so `app/node_modules` is found without hardcoding the layout.
const WORKTREE_DEP_NAMES = new Set([
  'node_modules', '.venv', 'venv', 'vendor', '.vscode', '.idea', '.envrc',
]);
// `.env`, `.env.local`, `.env.production`, … — dotenv secrets, never in the tree.
const isEnvFile = (name) => /^\.env(\..+)?$/.test(name);

// Relative paths (vs repoRoot) of gitignored deps present in the main checkout.
// Scans the repo root plus one level of non-hidden subdirs (bounded — never
// descends into node_modules or hidden dirs like the board's own .kanbento).
function findWorktreeDepPaths(repoRoot) {
  const found = [];
  const scanDirs = ['']; // '' = repo root
  let top;
  try { top = readdirSync(repoRoot, { withFileTypes: true }); } catch { return found; }
  for (const e of top) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') scanDirs.push(e.name);
  }
  for (const dir of scanDirs) {
    const abs = dir ? join(repoRoot, dir) : repoRoot;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (WORKTREE_DEP_NAMES.has(e.name) || isEnvFile(e.name)) {
        found.push(dir ? `${dir}/${e.name}` : e.name);
      }
    }
  }
  return found;
}

// Spawn an arbitrary command, resolving on exit 0, rejecting otherwise (stderr in
// the message). Used for the `cp` clone attempts (git() is git-only).
function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code}): ${err.trim()}`)));
  });
}

// Copy-on-write with a fallback chain: `cp -Rc` (macOS APFS clone) → `cp
// --reflink=auto -a` (Linux reflink, plain-copy fallback) → `cp -a` (portable
// deep copy). Try in order, fall through on failure. Returns true if any won.
async function copyClone(src, dest) {
  const attempts = [
    ['cp', ['-Rc', src, dest]],
    ['cp', ['--reflink=auto', '-a', src, dest]],
    ['cp', ['-a', src, dest]],
  ];
  for (const [cmd, args] of attempts) {
    try { await runCmd(cmd, args); return true; } catch { /* fall through */ }
  }
  return false;
}

// Append paths to the worktree's git-exclude so `git add -A` / the card diff never
// pick them up. For a LINKED worktree the effective exclude file is not obvious —
// git redirects `info/exclude` to the common gitdir — so we ask git itself where
// it reads it (`rev-parse --git-path info/exclude`) rather than guessing the path.
// Idempotent: only appends patterns not already present.
async function excludeFromGit({ worktreeDir, paths }) {
  let excludePath;
  try {
    excludePath = (await git(['rev-parse', '--git-path', 'info/exclude'], worktreeDir)).trim();
  } catch { return; }
  if (!isAbsolute(excludePath)) excludePath = join(worktreeDir, excludePath);
  let existing = '';
  try { existing = await readFile(excludePath, 'utf8'); } catch { /* not created yet */ }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const additions = paths.filter((p) => !have.has(p));
  if (!additions.length) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, existing + sep + additions.join('\n') + '\n', 'utf8');
}

// Bring the main checkout's gitignored deps into a freshly-created worktree: for
// each detected path absent from the worktree, COW-clone it in, then git-exclude
// the ones that landed. Never overwrites an existing dest (a tracked path already
// checked out, or a prior provision). Best-effort per path — one failure never
// aborts the rest. Returns the relative paths actually brought in.
async function provisionWorktreeDeps({ repoRoot, worktreeDir }) {
  const brought = [];
  for (const rel of findWorktreeDepPaths(repoRoot)) {
    const dest = join(worktreeDir, rel);
    if (existsSync(dest)) continue; // never overwrite
    // The dest's parent may be absent (e.g. app/ isn't in the checkout when its
    // only content is the gitignored app/node_modules) — create it before cloning.
    await mkdir(dirname(dest), { recursive: true });
    if (await copyClone(join(repoRoot, rel), dest)) brought.push(rel);
  }
  if (brought.length) await excludeFromGit({ worktreeDir, paths: brought });
  return brought;
}

// Ensure the worktree's `.kanbento/.kanbento` pointer routes board verbs to the
// main board. Idempotent rewrite on every open (including reuse) so a stale or
// hand-deleted pointer is healed. The pointer's identity is the PATH to the main
// board, so it writes unconditionally — no boardId to resolve, no skip.
function ensureWorktreeBoardPointer({ worktreeDir, dataDir, boardDir = null }) {
  const target = boardDir ? asBoardRoot(boardDir) : asBoardRoot(dataDir);
  return writeBoardPointer(worktreeDir, { board: target });
}

// Materialize (or REUSE) the card's persistent worktree. Idempotent: a second call
// for the same card returns the existing tree untouched (reused: true) — it does
// NOT reset the branch, so commits made during a stage loop survive a re-entry
// after a review FAIL. Only first materialization creates the branch (off base,
// default HEAD) and checks it out; if the branch already exists but the checkout
// is gone, it re-attaches to the branch tip (never resets to base — that would
// discard work). On first materialization (and re-attach — both mint a fresh
// checkout) it also provisions the main checkout's gitignored deps into the tree
// (see provisionWorktreeDeps) so `npm test` just works. Always (re)writes the
// store-routing pointer so verbs from inside the worktree hit the main board.
// Returns { cardId, dir, branch, base, baseSha, reused }.
export async function materializeCardWorktree({
  repoRoot, dataDir, cardId, base = null, branch = null, boardDir = null,
}) {
  const wantBranch = cardBranch(cardId, branch);
  const dir = cardWorktreeDir(dataDir, cardId);
  const metaPath = cardWorktreeMetaPath(dataDir, cardId);
  const pointerOpts = { worktreeDir: dir, dataDir, boardDir };

  const existing = await findCardWorktree({ dataDir, cardId });
  if (existing) {
    // Reuse: do not reset the branch — but still ensure the store pointer
    // (idempotent rewrite) so a missing/stale pointer never silently leaves the
    // worktree writing to its checked-out .kanbento/.
    try { ensureWorktreeBoardPointer(pointerOpts); } catch { /* best-effort on reuse */ }
    return { ...existing, reused: true };
  }

  // Prune stale registrations (a checkout deleted by hand can dangle).
  try { await git(['worktree', 'prune'], repoRoot); } catch { /* best-effort */ }

  // Does the branch already exist (checkout gone, meta lost — a re-attach case)?
  let branchExists = false;
  try {
    await git(['rev-parse', '--verify', `refs/heads/${wantBranch}`], repoRoot);
    branchExists = true;
  } catch { /* fresh branch */ }

  const baseRef = base || 'HEAD';
  let baseSha;
  await mkdir(dirname(dir), { recursive: true });
  if (branchExists) {
    // Re-attach to the existing branch tip; do NOT reset to base (preserve commits).
    await git(['worktree', 'add', '-f', dir, wantBranch], repoRoot);
    // Meta was lost — recover the TRUE base, NOT the branch tip. baseSha=tip would
    // make a later base..branch diff EMPTY (tip..tip), vanishing the card's work.
    // Also refuse merge-base==tip (branch already integrated into baseRef) — that
    // was a hole in the first re-attach fix (post-merge re-open → silent empty).
    baseSha = await recoverCardBranchBase({ cwd: repoRoot, baseRef, branch: wantBranch });
  } else {
    try {
      baseSha = (await git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot)).trim();
    } catch (e) {
      throw new Error(`workspace: card worktree — base ref "${baseRef}" not resolvable in ${repoRoot}: ${(e.stderr ?? e.message ?? '').trim()}`);
    }
    await git(['worktree', 'add', '-f', '-b', wantBranch, dir, baseSha], repoRoot);
  }

  // Bring the main checkout's gitignored deps (node_modules, .venv, editor
  // configs, .env*, …) into the fresh checkout — COW-cloned + git-excluded — so a
  // tool can run immediately and the borrowed paths never leak into the card diff.
  // Best-effort: a provisioning failure must not block the worktree from opening.
  try { await provisionWorktreeDeps({ repoRoot, worktreeDir: dir }); } catch { /* best-effort */ }

  // Route board verbs from inside this worktree to the main board.
  try { ensureWorktreeBoardPointer(pointerOpts); } catch { /* best-effort: open still succeeds */ }

  const meta = { cardId, dir, branch: wantBranch, base: baseRef, baseSha };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { ...meta, reused: false };
}

// The card's branch diff (base..branch tip, including uncommitted work when the
// worktree is on the tip): read the meta sidecar, heal a degraded base when
// possible, then diff. Never silently return empty when the branch is ahead of
// base — that was the review-loop hole (reviewer PASSes on nothing).
//
// Returns { patch, summary, baseSha, branchTip }.
export async function computeCardWorktreeDiff({ dataDir, cardId }) {
  const meta = await findCardWorktree({ dataDir, cardId });
  if (!meta) throw new Error(`workspace: card worktree for ${cardId} not found — materialize it first`);

  const branchTip = (await git(['rev-parse', '--verify', `${meta.branch}^{commit}`], meta.dir)).trim();
  let baseSha = meta.baseSha;
  const baseRef = meta.base || 'HEAD';

  // Heal tip-as-base (poisoned meta): re-resolve via merge-base against mainline
  // (not worktree HEAD — that IS the tip). Re-persist when the base moves.
  // Never-diverged (base==tip, no unique commits) is fine — recover returns tip.
  // Fully-merged (tip strict ancestor of main) fails loud inside recover.
  if (!baseSha || baseSha === branchTip) {
    const recovered = await recoverCardBranchBase({ cwd: meta.dir, baseRef, branch: meta.branch });
    if (recovered !== baseSha) {
      baseSha = recovered;
      const healed = { cardId: meta.cardId, dir: meta.dir, branch: meta.branch, base: baseRef, baseSha };
      await writeFile(meta.metaPath, JSON.stringify(healed, null, 2) + '\n', 'utf8');
    } else {
      baseSha = recovered;
    }
  }

  const patchPath = join(dataDir, 'worktrees', `${cardId}.patch`);
  const head = (await git(['rev-parse', 'HEAD'], meta.dir)).trim();

  // Prefer index vs base when checked out on the tip (captures uncommitted work).
  // If the worktree is detached/elsewhere, range-diff the branch tip so branch
  // commits never vanish behind a stale index.
  let result;
  if (head === branchTip) {
    result = await stageAndDiff({ worktreeDir: meta.dir, baseSha, patchPath });
  } else {
    result = await rangeDiff({ worktreeDir: meta.dir, baseSha, tipSha: branchTip, patchPath });
  }

  // Fail loud: commits ahead of base but zero files → never hand a reviewer silence.
  let ahead = 0;
  try {
    ahead = parseInt((await git(['rev-list', '--count', `${baseSha}..${branchTip}`], meta.dir)).trim(), 10) || 0;
  } catch { /* best-effort; the empty-file check still applies when countable */ }
  if (ahead > 0 && result.summary.files.length === 0) {
    throw new Error(
      `workspace: card worktree diff is empty but branch "${meta.branch}" is ${ahead} ` +
      `commit(s) ahead of base ${baseSha.slice(0, 8)} — base is likely wrong or the ` +
      `commits are empty. Refusing a silent empty review subject ` +
      `(base ${baseSha.slice(0, 8)}..tip ${branchTip.slice(0, 8)}).`,
    );
  }

  return { ...result, baseSha, branchTip };
}

// Remove the card's worktree — the EXPLICIT teardown, invoked only at done/abandon
// (never automatically per run; contrast removeWorktree). Removes the checkout,
// deletes the branch, and clears the meta sidecar + patch. Guarded/best-effort so
// a partial state never throws, but does actually remove (a later find → null).
export async function removeCardWorktree({ repoRoot, dataDir, cardId, branch = null }) {
  const dir = cardWorktreeDir(dataDir, cardId);
  const wantBranch = cardBranch(cardId, branch);
  // Drop the store pointer first (the whole checkout removal also deletes it;
  // explicit so a partial-remove path still clears the redirect).
  if (existsSync(dir)) {
    try { removeBoardPointer(dir); } catch { /* best-effort */ }
  }
  if (existsSync(dir)) {
    try { await git(['worktree', 'remove', '--force', dir], repoRoot); } catch { /* best-effort */ }
  }
  try { await git(['worktree', 'prune'], repoRoot); } catch { /* best-effort */ }
  try { await git(['branch', '-D', wantBranch], repoRoot); } catch { /* best-effort */ }
  try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { await rm(cardWorktreeMetaPath(dataDir, cardId), { force: true }); } catch { /* best-effort */ }
  try { await rm(join(dataDir, 'worktrees', `${cardId}.patch`), { force: true }); } catch { /* best-effort */ }
}

// Remove the run-dir worktree after a SUCCESSFUL run (the checkout is transient;
// the run dir is gitignored). Best-effort + guarded: a missing worktree, a failed
// remove, or a prune error never throws — the caller keeps the run dir either way.
export async function removeWorktree({ repoRoot, worktreeDir }) {
  if (!worktreeDir || !existsSync(worktreeDir)) return;
  try { await git(['worktree', 'remove', '--force', worktreeDir], repoRoot); } catch { /* best-effort */ }
  try { await git(['worktree', 'prune'], repoRoot); } catch { /* best-effort */ }
}
