#!/usr/bin/env node
// evidence.mjs — the deterministic evidence ORCHESTRATOR behind the status-update procedure.
// Membership + the gather-loop are mechanical, so they live here (a script versioned with the
// tool) rather than in procedure prose an agent has to re-derive each run. It resolves the
// board context the way the CLI would, decides who the members are (the home registry, or the
// "array of one" for a single board), and for each member spawns the two sibling extractors —
// git-activity.sh + board-activity.mjs — inlining their stdout under a uniform header.
//
// Unlike the extractors (which stay dependency-free so they run standalone from a served brief),
// this orchestrator SHIPS WITH the package, so it may reach into the kernel surface for board
// resolution — the single source of truth for "which board, where, who else". The two extractors
// own the window default (yesterday when --since/--until are omitted); we never duplicate it —
// we forward the flags only when given, and otherwise leave them off.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';
import { boardEnv } from '../../../src/kernel.js';
import { resolveBoardDir, manifestPathIn, hasManifest } from '../../../src/boards.js';
import { loadManifest } from '../../../src/manifest.js';

const GIT_EXTRACTOR = fileURLToPath(new URL('./git-activity.sh', import.meta.url));
const BOARD_EXTRACTOR = fileURLToPath(new URL('./board-activity.mjs', import.meta.url));

function parseArgs(argv) {
  const out = { since: null, until: null, board: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') out.since = argv[++i] ?? null;
    else if (a === '--until') out.until = argv[++i] ?? null;
    else if (a === '--board') out.board = argv[++i] ?? null;
    else { process.stderr.write(`evidence: unknown argument: ${a}\n`); process.exit(2); }
  }
  return out;
}

// The window flags to forward — only the ones actually given. The extractors own the
// yesterday-default when both are absent, so we NEVER synthesize one here.
function windowFlags(args) {
  const f = [];
  if (args.since != null) f.push('--since', args.since);
  if (args.until != null) f.push('--until', args.until);
  return f;
}

// Is `dir` inside a git work tree? Fail-soft: no git / not a repo → false, never a throw.
function isGitRepo(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  } catch { return false; }
}

// Spawn one extractor, inlining its stdout. A failure (spawn error or non-zero exit — the
// extractors are fail-soft and normally exit 0) prints one error line and returns; the caller
// keeps sweeping. Deterministic: same inputs, same bytes.
function runExtractor(cmd, cmdArgs, label) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  if (r.error) { console.log(`  ${label}: failed — ${r.error.message}`); return; }
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.status !== 0) console.log(`  ${label}: exited ${r.status}${r.stderr ? ` — ${String(r.stderr).trim()}` : ''}`);
}

// Who the evidence covers, in a deterministic order:
//   home board  → the live registry members (env.members is already filtered), sorted by handle
//   any other board present → the "array of one": this board alone
//   no board at all, but cwd is a git repo → a single member on cwd (raw-repo fallback)
//   otherwise → empty (the header will say 0 members)
function membersFor(env, dir) {
  if (env.isHome) return [...env.members].sort((a, b) => a.handle.localeCompare(b.handle));
  if (env.boardDir) return [{ handle: env.boardId || basename(env.boardDir), dir: env.boardDir }];
  if (isGitRepo(dir)) return [{ handle: basename(dir), dir }];
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the board context exactly as the CLI would: walk up from cwd, or honor --board.
  const { dir } = resolveBoardDir(args.board);
  const manifest = hasManifest(dir) ? await loadManifest(manifestPathIn(dir)).catch(() => null) : null;
  const env = boardEnv({ dir, manifest });

  const members = membersFor(env, resolve(dir));
  const win = windowFlags(args);

  const sinceLabel = args.since ?? 'default (yesterday)';
  const untilLabel = args.until ?? '';
  console.log(`# evidence · ${members.length} member(s) · window: ${sinceLabel} → ${untilLabel}`);

  for (const m of members) {
    console.log(`\n=== ${m.handle} — ${m.dir} ===`);
    runExtractor('bash', [GIT_EXTRACTOR, '--repo', m.dir, ...win], 'git-activity');
    runExtractor(process.execPath, [BOARD_EXTRACTOR, '--board', m.dir, ...win], 'board-activity');
  }
}

main();
