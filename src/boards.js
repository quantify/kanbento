import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// A git-backed worktree observer for `dir` — the seam openBoard stamps card events
// with. Returns the checked-out branch and the dirty set (tracked changes vs HEAD ∪
// untracked, `.kanbento/**` excluded), paths relative to the repo root. Fail-soft:
// no git binary, not a repo, or an empty repo (no HEAD) → null, never throws/prints.
// execFile (no shell) — the dir is untrusted input.
export function gitObserver(dir) {
  return async () => {
    try {
      const git = async (args) => (await execFileP('git', args, { cwd: dir })).stdout;
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null;
      const changed = await git(['diff', '--name-only', 'HEAD']);
      const untracked = await git(['ls-files', '--others', '--exclude-standard']);
      const dirty = [...changed.split('\n'), ...untracked.split('\n')]
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !p.startsWith('.kanbento/'));
      return { branch, dirty };
    } catch {
      return null; // git absent / not a repo / empty repo — no observation, not an error
    }
  };
}

// A git-backed identity observer for `dir` — the seam openBoard stamps a
// `principal` onto every appended event with. The principal is the human on whose
// behalf work happens (repo-local config, else global); the event's `by` stays the
// actor role. Email is the join key — no email, no stamp. Fail-soft like
// gitObserver: no git / not a repo / unset config → null, never throws.
export function gitIdentity(dir) {
  return async () => {
    try {
      const git = async (args) => (await execFileP('git', args, { cwd: dir })).stdout.trim();
      const email = await git(['config', 'user.email']).catch(() => '');
      if (!email) return null;
      const name = await git(['config', 'user.name']).catch(() => '');
      return { email, ...(name ? { name } : {}), source: 'git' };
    } catch {
      return null;
    }
  };
}

// Board location resolution — the .git/.kanbento analogy made literal.
//
//   "@name"   a shared board under $KANBENTO_HOME/boards/<name> (reachable from
//             any folder — this is how agents in different folders collaborate)
//   "<path>"  that directory, treated as a board
//   (none)    walk up from cwd for a .kanbento/ or a manifest, like git finds
//             .git/; fall back to cwd
//
// A board directory holds a `manifest.*` plus a `.kanbento/` data dir.

const MANIFEST_NAMES = ['manifest.yaml', 'manifest.yml', 'manifest.json'];

export function kanbentoHome() {
  return process.env.KANBENTO_HOME || join(homedir(), '.kanbento');
}

// Personal, machine-scoped preferences — presentation concerns, never board
// grammar (those live in the manifest).
//   $KANBENTO_HOME/config.json  =>  { "linkScheme": "kanbento" | "file", ... }
export function homeConfig() {
  try {
    return JSON.parse(readFileSync(join(kanbentoHome(), 'config.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

// The machine-scoped board registry: a handle -> location index that resolves
// boards a tree scan can't reach (a board in another repo — e.g. a submit target).
// Auto-built (a board records itself on compile/init) and disposable: an
// accelerator, never the source of truth.
//   $KANBENTO_HOME/registry.json  =>  { "<board-id>": "<board dir>", ... }
function registryPath() {
  return join(kanbentoHome(), 'registry.json');
}
function readRegistry() {
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf8')) || {};
  } catch {
    return {}; // missing or malformed — an empty index
  }
}
// Upsert handle -> dir. Best-effort: a registry write must never break the verb
// that triggered it (compile/init), so failures are swallowed. Idempotent.
export function registerBoard(handle, dir) {
  if (!handle || !dir) return;
  try {
    const reg = readRegistry();
    if (reg[handle] === dir) return; // already current
    reg[handle] = dir;
    mkdirSync(kanbentoHome(), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + '\n', 'utf8');
  } catch {
    /* the registry is an accelerator — its write is never fatal */
  }
}
export function lookupBoard(handle) {
  return readRegistry()[handle] ?? null;
}

// The board's machine-readable context — the docker-machine-env pattern: the facts a
// script needs to orient (which board, where, is it the home board, who else is on the
// machine) derived once, in the kernel, so every transport prints the same truth. Pure
// over the filesystem + the passed manifest — no writes, no event append, no registration.
//   dir      the resolved board dir (from resolveBoardDir); may not actually be a board
//   manifest the loaded manifest (when present) — the source of board.id
// A board is "present" only when a manifest resolves under `dir`; otherwise boardDir is
// empty (the honest signal a script tests), never a bare cwd fallback.
export function boardEnv({ dir, manifest } = {}) {
  const present = dir ? hasManifest(dir) : false;
  const boardDir = present ? resolve(dir) : '';
  const boardId = present ? (manifest?.board?.id ?? '') : '';
  const home = kanbentoHome();
  const homeDir = dirname(home); // the dir whose .kanbento IS kanbentoHome() — the home board's root
  const isHome = !!boardDir && resolve(boardDir) === resolve(homeDir);
  const regPath = registryPath();
  const hasReg = existsSync(regPath);
  return {
    boardDir,
    boardId,
    home,
    isHome,
    registryPath: hasReg ? regPath : null,
    // Live registry entries a script can address as @handle: the board dir still exists
    // and holds a manifest, minus the home entry itself. Empty when there's no registry.
    members: hasReg
      ? Object.entries(readRegistry())
          .filter(([, d]) => d && existsSync(d) && hasManifest(d) && resolve(d) !== resolve(homeDir))
          .map(([handle, d]) => ({ handle, dir: d }))
      : [],
  };
}

// A directory named `.kanbento` is a *store*, not a board root. The board root is
// the parent that *owns* that store. Nested phantoms (`.kanbento/.kanbento/...`)
// collapse the same way. Without this, running a verb with cwd inside a store
// treats the store as a root and FileLog.mkdir creates a nested phantom board
// (nested-store-spawn@b588f7b8).
export function asBoardRoot(dir) {
  let d = resolve(dir);
  while (basename(d) === '.kanbento') {
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return d;
}

export function resolveBoardDir(arg) {
  if (arg?.startsWith('@')) {
    const handle = arg.slice(1);
    // `@home` is the reserved, explicit door to the board rooted at $HOME — the one
    // findUp deliberately won't discover implicitly (the home-ceiling above).
    if (handle === 'home') return { dir: homedir(), label: '@home' };
    const registered = lookupBoard(handle); // cross-repo: a board that recorded its own location
    return { dir: registered ?? join(kanbentoHome(), 'boards', handle), label: arg };
  }
  if (arg) {
    const dir = asBoardRoot(resolve(arg));
    return { dir, label: dir };
  }
  const found = findUp(process.cwd());
  // Never fall back to a store path — even when findUp finds nothing, collapse
  // `.kanbento` so openCtx does not mkdir a nested phantom under the store.
  const dir = found ?? asBoardRoot(process.cwd());
  return { dir, label: dir };
}

// Where a NEW board goes. Creation must NOT walk up: `resolveBoardDir` finds an existing
// board to OPERATE on (git-like walk-up), but for `init` that silently adopts an ancestor
// board — e.g. a home-level ~/.kanbento — instead of making one here. So a bare init lands
// in cwd; @name and explicit dirs still resolve as usual.
export function resolveInitTarget(arg) {
  return arg ? resolveBoardDir(arg) : { dir: process.cwd(), label: process.cwd() };
}

// The manifest lives in .kanbento/ (self-contained; keeps the project root
// clean — no clash with a web app's own manifest.json). Legacy boards kept it at
// the board root, so resolve there as a fallback. New boards write it under
// .kanbento/.
export function manifestPathIn(dir) {
  for (const base of [dataDirIn(dir), dir]) {
    for (const name of MANIFEST_NAMES) {
      const p = join(base, name);
      if (existsSync(p)) return p;
    }
  }
  return join(dataDirIn(dir), 'manifest.json'); // default home; errors helpfully if missing
}

export function dataDirIn(dir) {
  return join(dir, '.kanbento');
}

export function hasManifest(dir) {
  return [dataDirIn(dir), dir].some((base) => MANIFEST_NAMES.some((name) => existsSync(join(base, name))));
}

// Walk up for a board, but $HOME is the CEILING: a board at the home dir (or above) is
// never discovered implicitly — otherwise every path eventually ascends into ~/.kanbento
// and any boardless folder silently adopts it. Git-independent (keys off home, not a
// .git marker), so it holds for non-repo folders too. The home board stays reachable,
// but only explicitly, via `@home` — *except* when the start path is already inside
// the home store (cwd=~/.kanbento): that is intentional presence in the home board,
// not silent adoption from a boardless folder under home. No board below the ceiling
// → null (the caller errors).
function findUp(start) {
  const home = homedir();
  // Presence inside the home store is judged against kanbentoHome() — the same seam
  // every other home-aware path rides (KANBENTO_HOME override included) — and on real
  // paths, so a symlinked route into the store still counts as being inside it.
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const store = real(kanbentoHome());
  const s = real(start);
  if (s === store || s.startsWith(store + sep)) {
    // Intentional presence in the home board (the start path is inside its store),
    // not silent adoption from a boardless folder under home. The owning root is
    // the store's parent — the dir whose store IS kanbentoHome() (boardEnv's
    // convention), which under a KANBENTO_HOME override may sit anywhere.
    const root = dirname(store);
    if (existsSync(store) || hasManifest(root)) return root;
    return null;
  }
  // Collapse any store prefix so a start of `…/.kanbento[/…]` is judged at the
  // board root that owns it, not at the store (which also hosts manifest.json).
  let dir = asBoardRoot(start);
  for (;;) {
    if (dir !== home && (existsSync(join(dir, '.kanbento')) || hasManifest(dir))) return dir;
    if (dir === home) return null; // reached the ceiling without a board
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = asBoardRoot(parent);
  }
}

// The scan root for network discovery: the enclosing repo (nearest ancestor with
// a .git), else the topmost board ancestor, else the start dir. A network is
// scoped to a tree the way a docker-compose project is scoped to its directory.
export function repoRoot(start) {
  let dir = start;
  let topBoard = null;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (hasManifest(dir)) topBoard = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return topBoard ?? start;
}
