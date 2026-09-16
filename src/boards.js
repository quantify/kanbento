import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative, dirname, basename, sep } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

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

// Board location resolution — one chain, multiple entry forms.
//
//   entry form  →  locate candidate  →  follow pointer  →  board root
//
// Entry forms (discriminated only; never fall through between forms):
//   "@home"   reserved door to the board rooted at $HOME (findUp will not
//             discover it implicitly — home is the walk-up ceiling)
//   "@name"   registry lookup, else $KANBENTO_HOME/boards/<name>
//             (explicit only — bare resolve never falls through to @name)
//   "<path>"  that directory, collapsed through asBoardRoot
//   (none)    walk up from cwd for a .kanbento/ or a manifest (home is ceiling);
//             else cwd collapsed through asBoardRoot
//
// After the candidate is located, every form ends in followBoardPointer:
//   pointer absent            → local candidate
//   pointer present-but-broken → loud fail (never silent fallback)
//   pointer present           → pointed board root
//
// Public choke point: resolveBoardDir. Callers (openCtx, init, install, …) go
// through it — no parallel ad-hoc walk-up / @name / pointer paths.
//
// A board directory holds a `manifest.*` plus a `.kanbento/` data dir.

const MANIFEST_NAMES = ['manifest.yaml', 'manifest.yml', 'manifest.json'];

// $HOME the *ceiling*, not kanbentoHome() the store — a separate seam, deliberately.
// Node's os.homedir() re-reads $HOME on every call; Bun caches it at startup, so a
// process that reassigns process.env.HOME (the test harness does) diverges by runtime.
// Reading the env first is exactly Node's posix semantics, made explicit so every
// runtime agrees; homedir() remains the fallback when the var is unset.
function userHome() {
  return (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || homedir();
}

export function kanbentoHome() {
  return process.env.KANBENTO_HOME || join(userHome(), '.kanbento');
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
// Is `dir` an ephemeral (OS-temp) location? Scratch/test/e2e boards live under
// os.tmpdir(); self-registering them would pollute the persistent machine
// registry with dead handles (registry-pollution@751247f9). Compared on realpaths
// because macOS tmp is a symlink (/var/folders/... -> /private/var/folders/...).
function isEphemeralDir(dir) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const d = real(dir);
  const t = real(tmpdir());
  return d === t || d.startsWith(t + sep);
}

// Upsert handle -> dir. Best-effort: a registry write must never break the verb
// that triggered it (compile/init), so failures are swallowed. Idempotent.
// Boards under the OS temp dir are ephemeral by definition — skip them so a
// throwaway board never leaves a stale entry in the real registry. This is the
// robust seam (vs. asking every test/e2e to isolate KANBENTO_HOME by hand): one
// choke point, protects all ephemeral boards regardless of test discipline.
export function registerBoard(handle, dir) {
  if (!handle || !dir) return;
  if (isEphemeralDir(dir)) return;
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
//
// Note: a *file* at `.kanbento/.kanbento` is the store-routing pointer (see
// boardPointerPath) — not a nested store. asBoardRoot still collapses a path
// that ends in that name; followBoardPointer is what reads the file.
export function asBoardRoot(dir) {
  let d = resolve(dir);
  while (basename(d) === '.kanbento') {
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return d;
}

// --- store pointer (worktree / satellite board routing) ---------------------
//
// `.kanbento/.kanbento` — self-similar like git's `.git` file. When present, ALL
// verb reads/writes (log, manifest, compiled.json, materializations, projections)
// target the pointed board; the local checked-out `.kanbento/` is inert. When
// absent, walk-up / local resolution is unchanged. Present-but-broken (no board
// key, missing / not-a-board target) fails LOUDLY — never silent fallback.
// Format: git-style `key: value` lines (like `.git`'s `gitdir: <path>`); one pair
// per line, single space after the colon, value runs to end of line (no quoting —
// paths may contain spaces). Unknown keys are ignored (forward-compat). No version
// field. The `board:` value is a path RELATIVE to the pointer file's own directory
// (git's gitdir: convention when relative); an absolute value is accepted too.
// Example (standard worktree layout):
//   board: ../../../..

export function boardPointerPath(dir) {
  return join(dataDirIn(dir), '.kanbento');
}

// Parse the `key: value` pointer body — first `: ` delimits, value runs to EOL.
// Unknown keys are ignored; duplicate keys → last wins.
function parseBoardPointer(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(': ');
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

// Sync board.id from the manifest at `dir`, or null when missing/unreadable.
export function readBoardId(dir) {
  for (const base of [dataDirIn(dir), dir]) {
    for (const name of MANIFEST_NAMES) {
      const p = join(base, name);
      if (!existsSync(p)) continue;
      try {
        const raw = readFileSync(p, 'utf8');
        const m = name.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
        const id = m?.board?.id;
        return id != null && id !== '' ? String(id) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Write (or rewrite) the store pointer under `dir`'s store. Idempotent.
// The `board:` value is written RELATIVE to the pointer file's own directory
// (git's gitdir: convention when relative) — the standard worktree layout yields
// exactly `../../../..`. We deliberately write NO boardId: the path is the
// identity (git precedent — .git files carry no repo id), and an id check would
// brick every already-open worktree's pointer the moment a manifest edit changes
// board.id.
export function writeBoardPointer(dir, { board }) {
  if (!board) {
    throw new Error('writeBoardPointer requires board (path)');
  }
  const p = boardPointerPath(dir);
  const rel = relative(dirname(p), resolve(board));
  const body = `board: ${rel}\n`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, 'utf8');
  return p;
}

// Best-effort remove of the pointer file (absent is fine).
export function removeBoardPointer(dir) {
  const p = boardPointerPath(dir);
  try {
    if (existsSync(p) && statSync(p).isFile()) unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

// If `dir` has a pointer file, return the pointed board root (validated).
// Pointer absent (or a directory at the path — a nested-store phantom) → `dir`
// unchanged. Present-but-invalid → throws naming the pointer and the target/local.
export function followBoardPointer(dir) {
  const local = resolve(dir);
  const pointerPath = boardPointerPath(local);
  if (!existsSync(pointerPath)) return local;
  let st;
  try { st = statSync(pointerPath); } catch { return local; }
  // A directory at this path is a nested-store phantom, not a pointer file.
  if (st.isDirectory()) return local;

  const data = parseBoardPointer(readFileSync(pointerPath, 'utf8'));
  if (!data.board) {
    throw new Error(
      `board pointer is malformed at ${pointerPath} (from board at ${local}) — ` +
      `need a "board: <path>" line; refusing silent fallback`,
    );
  }
  // The value is resolved against the pointer file's own directory — relative
  // (the written form) or absolute both work, since resolve() ignores the base
  // when the value is already absolute.
  const target = asBoardRoot(resolve(dirname(pointerPath), String(data.board)));
  if (!hasManifest(target) && !existsSync(dataDirIn(target))) {
    throw new Error(
      `board pointer at ${pointerPath} targets missing board ${target} ` +
      `(from board at ${local}) — refusing silent fallback`,
    );
  }
  return target;
}

// Locate the candidate board root for an entry form. Pure discrimination —
// does not follow pointers. Returns { candidate, fixedLabel } where fixedLabel
// is set for @ forms (the entry token) and null for path/walk-up (label becomes
// the post-pointer dir).
function locateBoardCandidate(arg) {
  if (arg?.startsWith('@')) {
    const handle = arg.slice(1);
    // `@home` is the reserved, explicit door to the board rooted at $HOME — the one
    // findUp deliberately won't discover implicitly (the home-ceiling above).
    if (handle === 'home') {
      return { candidate: userHome(), fixedLabel: '@home' };
    }
    // cross-repo: a board that recorded its own location in the machine registry
    const registered = lookupBoard(handle);
    const candidate = registered ?? join(kanbentoHome(), 'boards', handle);
    return { candidate, fixedLabel: arg };
  }
  if (arg) {
    return { candidate: asBoardRoot(resolve(arg)), fixedLabel: null };
  }
  const found = findUp(process.cwd());
  // Never fall back to a store path — even when findUp finds nothing, collapse
  // `.kanbento` so openCtx does not mkdir a nested phantom under the store.
  return { candidate: found ?? asBoardRoot(process.cwd()), fixedLabel: null };
}

// The single resolution function. Entry form → candidate → followBoardPointer.
export function resolveBoardDir(arg) {
  const { candidate, fixedLabel } = locateBoardCandidate(arg);
  const dir = followBoardPointer(candidate);
  return { dir, label: fixedLabel ?? dir };
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

// Structural data files (event log, drift baseline, sweep mark, install lock)
// live under .kanbento/data/ — the store root stays quiet: manifest + docs +
// content dirs. The one canonical constructor for those paths: the runtime never
// reads the store root (no fallback). A board made before the data/ layout (≤0.2)
// is refused loudly at open until `kanbento upgrade` renames its files into place.
export function dataFilePath(dir, name) {
  return join(dataDirIn(dir), 'data', name);
}

const DATA_FILES = ['events.jsonl', 'compiled.json', 'swept.json', 'installed.json'];

// The pre-data/ layout: structural files still at the store root. Only files whose
// data/ counterpart is absent count — a board with both is not "legacy", it is a
// store that was written under both layouts and needs a human, not a rename.
export function legacyDataFiles(dir) {
  return DATA_FILES
    .map((name) => ({ name, from: join(dataDirIn(dir), name), to: dataFilePath(dir, name) }))
    .filter((f) => existsSync(f.from) && !existsSync(f.to));
}

// One-time migration into the data/ layout (the `upgrade` verb's first step —
// it must run before the board is opened, since open refuses the legacy layout).
export function migrateDataFiles(dir, { dryRun = false } = {}) {
  const files = legacyDataFiles(dir);
  if (!dryRun && files.length) {
    mkdirSync(join(dataDirIn(dir), 'data'), { recursive: true });
    for (const f of files) renameSync(f.from, f.to);
  }
  return files;
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
  const home = userHome();
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
