import { homedir } from 'node:os';
import { join, resolve, delimiter, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { kanbentoHome, manifestPathIn, dataDirIn } from './boards.js';
import { parseCurie } from './refs.js';
import { resolveProcedure, parseCadence } from './commands.js';
import { writeFrontmatterField, removeFrontmatterField } from './frontmatter.js';
import { openBoard } from './kernel.js';
import { FileLog } from './eventlog.js';

const execFileP = promisify(execFile);

// `schedule` — project a procedure's cadence into the OS scheduler. kanbento never
// runs a daemon: it REGISTERS with the platform's scheduler (launchd on macOS) and
// gets out of the way. The scheduled entry point (`--fire`) is a two-stage job — a
// deterministic guard (skip if the cadence window hasn't elapsed) then a headless
// agent run that halts at the consent gate. The launchd job fires DAILY at HH:MM; the
// cadence window is enforced by the guard, so a `7d` cadence fires daily but only acts
// every seventh. Only daily granularity is materialized now (sub-daily is rejected).
//
// Everything OS-facing routes through overridable seams so the suite runs hermetically:
//   KANBENTO_HOME       relocates the state/log/plist tree (isolation)
//   KANBENTO_LAUNCHCTL  replaces the launchctl invocation (a stub or `true`)
//   KANBENTO_RUNNER     replaces the config.json runner (a stub agent)
//   KANBENTO_PLATFORM   overrides process.platform (simulate non-darwin)

// The home tree: state + logs live under $KANBENTO_HOME (a real board's ~/.kanbento).
export function scheduleDir() { return join(kanbentoHome(), 'schedule'); }
export function logsDir() { return join(kanbentoHome(), 'logs'); }

// Where the launchd plist lands. In production that's ~/Library/LaunchAgents (launchd's
// per-user agent dir); under a KANBENTO_HOME override (tests) it stays beside the home so
// nothing touches the operator's real LaunchAgents.
export function launchAgentsDir() {
  return process.env.KANBENTO_HOME
    ? join(process.env.KANBENTO_HOME, 'LaunchAgents')
    : join(homedir(), 'Library', 'LaunchAgents');
}

// Schedule artifacts are BOARD-QUALIFIED: state, plist label, and log carry the owning
// board's id so two boards can schedule the same slug without colliding, and a board's
// reads see only its own schedules. A bare slug (no boardId) names the LEGACY, pre-board
// -identity layout — kept so old state files (state.boardId absent) still resolve.
export function statePath(slug, boardId) { return join(scheduleDir(), `${boardId ? `${boardId}.` : ''}${slug}.json`); }
export function plistPath(slug, boardId) { return join(launchAgentsDir(), `com.kanbento.${boardId ? `${boardId}.` : ''}${slug}.plist`); }
export function logPath(slug, boardId) { return join(logsDir(), `${boardId ? `${boardId}.` : ''}${slug}.log`); }

// The home board is the one whose `.kanbento` store IS kanbentoHome() — its root is the
// store's parent. A legacy stateless schedule (no boardId) is treated as owned by home for
// display, so it surfaces on the home board and nowhere else.
function isHomeBoard(dir) { return !!dir && resolve(dir) === resolve(dirname(kanbentoHome())); }

// The current platform, overridable for tests (a real darwin box can still exercise the
// non-darwin rejection path). launchd is macOS-only; other platforms have no backend yet.
function currentPlatform() { return process.env.KANBENTO_PLATFORM || process.platform; }
function assertLaunchdPlatform(verb = 'schedule') {
  if (currentPlatform() !== 'darwin') {
    throw new Error(`${verb}: launchd backend only; systemd timer backend not yet built`);
  }
}

// The launchctl seam: bootout/bootstrap the plist, routed through KANBENTO_LAUNCHCTL when
// set (a test stub or `true`), else the real binary. Never throws — a bootstrap hiccup is
// reported, not fatal (the plist + state already landed; re-run to retry).
async function launchctl(args) {
  const override = process.env.KANBENTO_LAUNCHCTL;
  const cmd = override
    ? { file: 'sh', argv: ['-c', `${override} "$@"`, override, ...args] } // preserve $@ for a recording stub
    : { file: 'launchctl', argv: args };
  try {
    const { stdout, stderr } = await execFileP(cmd.file, cmd.argv);
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function uid() { return process.getuid?.() ?? 0; }

// Parse `--at HH:MM` into { hour, minute }; default 09:00 (the daily-kanban morning slot).
export function parseAt(at) {
  if (!at) return { hour: 9, minute: 0 };
  const m = String(at).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`schedule: --at "${at}" is not HH:MM`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`schedule: --at "${at}" out of range (00:00–23:59)`);
  return { hour, minute };
}

// Reject a cadence finer than a day — launchd's calendar interval fires daily and the
// whole model is the daily-kanban rhythm. A days/commits cadence is accepted verbatim
// (the job fires daily; the --fire guard enforces the real window).
export function assertDailyCadence(raw) {
  const s = String(raw).trim().toLowerCase();
  if (/^\d+\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)$/.test(s)) {
    throw new Error(`schedule: sub-daily cadence "${raw}" not yet supported — daily is the finest granularity for now`);
  }
  return true;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The interpreter path baked into the plist. process.execPath on a brew-installed node
// resolves through the VERSIONED Cellar dir (…/Cellar/node/26.0.0/bin/node); a
// `brew upgrade node` deletes that dir and launchd's spawn fails silently every morning.
// Prefer a stable, upgrade-surviving path: KANBENTO_NODE verbatim (also the test seam),
// else the first candidate — a `node` on PATH or a well-known symlink — that exists AND
// realpaths to the SAME binary we're running (never a *different* node). Fall back to
// execPath when nothing stable matches.
const WELL_KNOWN_NODES = ['/opt/homebrew/bin/node', '/opt/homebrew/opt/node/bin/node', '/usr/local/bin/node'];
export function stableNodePath({ execPath = process.execPath, wellKnown = WELL_KNOWN_NODES } = {}) {
  if (process.env.KANBENTO_NODE) return process.env.KANBENTO_NODE;
  let target;
  try { target = realpathSync(execPath); } catch { return execPath; }
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const candidates = [...pathDirs.map((d) => join(d, 'node')), ...wellKnown];
  for (const c of candidates) {
    if (c === execPath) continue; // no gain over the fallback
    try {
      if (realpathSync(c) === target) return c;
    } catch { /* candidate absent — keep scanning */ }
  }
  return execPath;
}

// Render a launchd LaunchAgent plist: a daily StartCalendarInterval that re-invokes the
// kanbento CLI as `schedule <fireKey> --fire`, logging both streams to the slug's log file.
export function renderPlist({ label, node, cliEntry, slug, boardId, hour, minute, outPath }) {
  // The fire key IS the state file's own basename — `<boardId>.<slug>` for a board-qualified
  // schedule, bare `<slug>` for a legacy one — so `--fire` resolves state without parsing.
  const fireKey = boardId ? `${boardId}.${slug}` : slug;
  const argv = [node, cliEntry, 'schedule', fireKey, '--fire'];
  const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(outPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

// The CLI entry the plist re-invokes: an explicit override (tests), else the advertised
// $KANBENTO_CLI, else this process's own script — always resolved absolute.
function resolveCliEntry(opts = {}) {
  if (opts.cliEntry) return resolve(opts.cliEntry);
  if (process.env.KANBENTO_CLI) return resolve(process.env.KANBENTO_CLI);
  if (process.argv[1]) return resolve(process.argv[1]);
  return 'kanbento';
}

// Read a slug's schedule state, or null if it isn't scheduled. The visibility read shared
// by the procedures listing + the `do` brief (a scheduled routine advertises its rhythm).
export async function readScheduleState(slug, boardId, boardDir) {
  if (!slug) return null;
  if (boardId) {
    try {
      return JSON.parse(await readFile(statePath(slug, boardId), 'utf8'));
    } catch { /* not scheduled on this board — try the legacy file below */ }
  }
  // A legacy stateless file (no boardId) is owned by the home board for display only.
  if (isHomeBoard(boardDir)) {
    try {
      const legacy = JSON.parse(await readFile(statePath(slug), 'utf8'));
      if (!legacy.boardId) return { ...legacy, legacy: true };
    } catch { /* not scheduled */ }
  }
  return null;
}

// Register: resolve the procedure (same shadowing as `do`), read its cadence, render +
// bootstrap a launchd plist, and persist the schedule state. A LOCAL record also gets a
// `schedule:` frontmatter stamp; a shipped built-in never does (package artifacts are
// immutable — its visibility is the listing + brief).
export async function registerSchedule({ board, dir }, name, opts = {}) {
  assertLaunchdPlatform();
  const rec = await resolveProcedure({ board, dir }, name, { verb: 'schedule' });
  const slug = parseCurie(rec.curie)?.slug ?? String(name);

  // A schedule is OWNED by a board — stamp its identity so reads gate by board, the label +
  // state path qualify, and --fire runs (and witnesses) in the originating board.
  const boardId = board?.manifest?.board?.id;
  if (!boardId) throw new Error('schedule: this board has no id (manifest board.id) — cannot scope the schedule to it');
  const boardDir = resolve(dir);

  const notes = [];
  let cadence = rec.cadence;
  if (cadence == null) {
    cadence = '1d';
    notes.push(`${rec.curie} declares no cadence — defaulting to 1d`);
  }
  assertDailyCadence(cadence);

  const { hour, minute } = parseAt(opts.at);
  const at = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const plist = plistPath(slug, boardId);

  // Resolve the effective grant NOW — declared frontmatter overlaid by the home config's
  // per-procedure override — and FREEZE it into the state. Registering is the informed
  // consent act, so print the resolved grant. `--fire` reads only this frozen grant, never
  // live frontmatter: a re-read would let any agent that can edit a .md escalate its own
  // permissions. The raw declared block is snapshotted too (`declared`) so the list can flag
  // drift ⇒ re-register.
  const cfg = await readConfig();
  const declared = rec.runner ?? null;
  const override = cfg.procedures?.[slug] ?? null;
  const grant = resolveGrant(declared, override);
  const grantLine = `grants: ${grantSummary(grant)}`;

  await mkdir(scheduleDir(), { recursive: true });
  await mkdir(logsDir(), { recursive: true });
  await mkdir(launchAgentsDir(), { recursive: true });

  // Legacy migration: a pre-board-identity state file for this slug (bare `<slug>.json`, no
  // boardId) is superseded by this board-qualified registration. Unload its old label +
  // remove its artifacts so the two don't double-fire. Runs only when the operator
  // re-registers on the owning board — the deliberate migration act.
  let migrated = false;
  const legacyStatePath = statePath(slug);
  if (legacyStatePath !== statePath(slug, boardId) && existsSync(legacyStatePath)) {
    try {
      const prev = JSON.parse(await readFile(legacyStatePath, 'utf8'));
      if (!prev.boardId) {
        const oldPlist = prev.plist ?? plistPath(slug);
        await launchctl(['bootout', `gui/${uid()}`, oldPlist]);
        if (existsSync(oldPlist)) await unlink(oldPlist);
        await unlink(legacyStatePath);
        migrated = true;
      }
    } catch { /* unreadable legacy file — leave it untouched */ }
  }

  const state = {
    procedure: slug,
    curie: rec.curie, // the owning-board CURIE — the handle --fire witnesses on success
    boardId,
    boardDir,
    cadence,
    at,
    plist,
    registeredAt: new Date().toISOString(),
    lastRun: null,
    grant, // the frozen grant — the only thing --fire consults
    declared, // the raw declared block at registration — drift baseline for the list
  };
  await writeFile(statePath(slug, boardId), JSON.stringify(state, null, 2) + '\n', 'utf8');

  const xml = renderPlist({
    label: `com.kanbento.${boardId}.${slug}`,
    node: stableNodePath(),
    cliEntry: resolveCliEntry(opts),
    slug,
    boardId,
    hour,
    minute,
    outPath: logPath(slug, boardId),
  });
  await writeFile(plist, xml, 'utf8');

  // A local record self-describes in its frontmatter; a shipped built-in must not be
  // mutated (it's a package file).
  let stamped = false;
  if (!rec.builtin && rec.path) {
    await writeFrontmatterField(resolve(dir, rec.path), 'schedule', `daily @ ${at}`);
    stamped = true;
  }

  // Reload the agent: bootout any prior copy (ignore failure), then bootstrap.
  await launchctl(['bootout', `gui/${uid()}`, plist]);
  const boot = await launchctl(['bootstrap', `gui/${uid()}`, plist]);

  return { slug, curie: rec.curie, boardId, cadence, at, plist, state, notes, stamped, migrated, builtin: !!rec.builtin, bootstrapped: boot.ok, grant, grantLine };
}

// Deregister: bootout the agent, delete the plist + state, drop the frontmatter stamp.
// Idempotent — deregistering an unscheduled procedure is an honest no-op.
export async function removeSchedule({ board, dir }, name) {
  assertLaunchdPlatform();
  const boardId = board?.manifest?.board?.id;
  let rec = null;
  let slug;
  try {
    rec = await resolveProcedure({ board, dir }, name, { verb: 'schedule' });
    slug = parseCurie(rec.curie)?.slug ?? String(name);
  } catch {
    slug = String(name).replace(/^procedure:/, ''); // a since-deleted procedure can still be unscheduled by slug
  }

  const sPath = statePath(slug, boardId);
  const state = existsSync(sPath) ? JSON.parse(await readFile(sPath, 'utf8')) : null;
  const plist = state?.plist ?? plistPath(slug, boardId);

  if (!existsSync(sPath) && !existsSync(plist)) {
    return { slug, removed: false }; // not scheduled — nothing to do
  }

  await launchctl(['bootout', `gui/${uid()}`, plist]);
  if (existsSync(plist)) await unlink(plist);
  if (existsSync(sPath)) await unlink(sPath);
  if (rec && !rec.builtin && rec.path) {
    try { await removeFrontmatterField(resolve(dir, rec.path), 'schedule'); } catch { /* stamp already gone */ }
  }
  return { slug, removed: true, plist };
}

// List the schedules VISIBLE to a board, slug-sorted — the bare `kanbento schedule` read
// model. A board sees its own schedules (state.boardId === boardId); the home board also
// sees legacy stateless files (no boardId), flagged `legacy` so the caller can hint migration.
export async function listSchedules({ boardId, boardDir } = {}) {
  let files;
  try {
    files = (await readdir(scheduleDir())).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no schedule dir — nothing registered
  }
  const home = isHomeBoard(boardDir);
  const out = [];
  for (const f of files.sort()) {
    try {
      const s = JSON.parse(await readFile(join(scheduleDir(), f), 'utf8'));
      if (s.boardId) { if (s.boardId === boardId) out.push(s); }
      else if (home) out.push({ ...s, legacy: true }); // pre-board-identity — owned by home for display
    } catch { /* skip a corrupt state file */ }
  }
  return out;
}

// The guard's threshold in local calendar days. A days cadence is exact; anything else
// (a commits cadence, an unparseable value) falls back to daily.
function cadenceDays(cadence) {
  const c = parseCadence(cadence);
  return c?.kind === 'days' ? c.n : 1;
}

// Local calendar days between two instants — midnight-boundary counting, not elapsed ms.
// A rolling window would let an evening manual --fire suppress the next morning's run;
// Math.round absorbs DST's 23/25-hour days.
function localDaysBetween(fromMs, toMs) {
  const midnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.round((midnight(toMs) - midnight(fromMs)) / 86400000);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runShell(cmd, cwd) {
  return new Promise((res) => {
    const child = spawn('sh', ['-c', cmd], { cwd, stdio: 'inherit' });
    child.on('exit', (code) => res(code ?? 0));
    child.on('error', () => res(1));
  });
}

// The harness flag grammar lives HERE, in one named constant — never scattered through
// logic. A config.json without a `runner` key gets this default, so per-routine grants
// reach the deployed harness (Claude Code) out of the box. A second harness swaps this
// one line (or overrides `runner` in config.json); nothing else in kanbento knows a
// concrete flag name. Placeholders: {prompt}, {model}, {tools} (tools joined with commas).
// The prompt sits BEFORE --allowedTools: that flag is VARIADIC in the claude CLI, so a
// trailing positional prompt would be swallowed as another tool name.
export const DEFAULT_RUNNER_TEMPLATE = 'claude -p {prompt} --model {model} --allowedTools {tools}';

// Read ~/.kanbento/config.json (under KANBENTO_HOME). Returns {} when absent/unreadable —
// every consumer defaults from there.
async function readConfig() {
  try {
    return JSON.parse(await readFile(join(kanbentoHome(), 'config.json'), 'utf8'));
  } catch {
    return {}; // no config — callers default
  }
}

// The runner TEMPLATE: an explicit config.json `runner` string, else the default template.
function runnerTemplate(cfg) {
  return typeof cfg.runner === 'string' ? cfg.runner : DEFAULT_RUNNER_TEMPLATE;
}

// Resolve the effective grant at registration: declared frontmatter defaults, overlaid by
// the home config's per-procedure override (override wins wholesale, per key). Model absent
// → null (inherit the runner default); tools absent → [] (no extra grant).
export function resolveGrant(declared, override) {
  const d = declared ?? {};
  const o = override ?? {};
  return {
    model: o.model ?? d.model ?? null,
    tools: o.tools ?? d.tools ?? [],
  };
}

// A one-line human summary of a grant — printed at register (informed consent) and shown
// in the list + brief. "model=default · tools=Bash(kanbento *), Read" (or "tools=none").
export function grantSummary(grant) {
  const g = grant ?? {};
  const model = g.model || 'default';
  const tools = g.tools?.length ? g.tools.join(', ') : 'none';
  return `model=${model} · tools=${tools}`;
}

// Substitute {prompt}/{model}/{tools} in a template's whitespace-separated tokens. A grant
// placeholder ({model}/{tools}) that resolves empty is dropped ALONG WITH its adjacent flag
// token (the previous token starting with '-') so nothing dangles — `--model {model}`
// vanishes entirely when the grant has no model. {prompt} is never dropped. Tools join with
// commas. Each substituted value is shell-quoted: the command runs under `sh -c`, and the
// default tool grammar — `Bash(kanbento *)` — carries parens, spaces, and globs by design;
// unquoted it would misparse.
function substituteTemplate(template, grant, prompt) {
  const values = {
    '{prompt}': prompt ?? '',
    '{model}': grant?.model || '',
    '{tools}': grant?.tools?.length ? grant.tools.join(',') : '',
  };
  const tokens = template.split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (Object.prototype.hasOwnProperty.call(values, tok)) {
      const val = values[tok];
      if (val === '' && tok !== '{prompt}') {
        if (out.length && out[out.length - 1].startsWith('-')) out.pop(); // drop the dangling flag
        continue;
      }
      out.push(shellQuote(val));
    } else {
      out.push(tok);
    }
  }
  return out.join(' ');
}

// Assemble the runner invocation from a template + a frozen grant + the prompt. A template
// carrying {prompt}/{model}/{tools} placeholders gets them substituted (empty grant segments
// dropped); a placeholder-free template (a bare `claude -p`, or the KANBENTO_RUNNER stub) is
// used as-is — grant flags simply don't reach a template that never asked for them. The
// prompt lands where {prompt} says; a template WITHOUT {prompt} gets it appended
// shell-quoted at the end (backward compat — but a variadic flag like claude's
// --allowedTools would swallow a trailing positional, hence the placeholder).
export function assembleRunner(template, grant, prompt) {
  const hasPlaceholder = /\{(prompt|model|tools)\}/.test(template);
  const base = hasPlaceholder ? substituteTemplate(template, grant, prompt) : template;
  if (template.includes('{prompt}')) return base;
  return `${base} ${shellQuote(prompt)}`;
}

// Compare a routine's CURRENT frontmatter runner declaration against the snapshot frozen at
// registration. Drift ⇒ the operator must re-register (the frozen grant is authoritative
// until they do — a live re-read would let any md-writing agent escalate its own grant). A
// since-deleted procedure doesn't count as drift (nothing to re-register).
export async function declarationDrifted(ctx, slug, frozenDeclared) {
  let current = null;
  try {
    const rec = await resolveProcedure(ctx, slug, { verb: 'schedule' });
    current = rec.runner ?? null;
  } catch {
    return false; // procedure gone — no drift to report
  }
  return JSON.stringify(current ?? null) !== JSON.stringify(frozenDeclared ?? null);
}

// The `kanbento schedule` list read model, each state annotated with declaration drift
// (needs board/dir to re-resolve the live frontmatter). Grant + drift render from here.
export async function annotateSchedules(ctx) {
  const { board, dir } = ctx;
  const list = await listSchedules({ boardId: board?.manifest?.board?.id, boardDir: dir });
  const out = [];
  for (const s of list) {
    out.push({ ...s, drifted: await declarationDrifted(ctx, s.procedure, s.declared ?? null) });
  }
  return out;
}

// The scheduled entry point — the two-stage job launchd fires. GUARD: skip unless the
// cadence's calendar days have passed since lastRun (deterministic, no agent spawned). COMPOSE: spawn the
// runner on a prompt that runs the procedure and halts at the consent gate (drafts only,
// never sends). Stamp lastRun on exit 0; leave it untouched on failure. Works on any
// platform — the OS scheduler is what invoked us; we don't re-check the backend here.
export async function fireSchedule(_ctx, name, opts = {}) {
  // The fire key IS the state file's basename (the plist names it directly), so it resolves
  // with no parsing: `<boardId>.<slug>` board-qualified, bare `<slug>` legacy. As a manual
  // convenience, a bare slug + opts.boardId falls back to that board's qualified file — so a
  // human running `schedule <slug> --fire` from inside a board finds its own state.
  const key = String(name).replace(/^procedure:/, '');
  let sPath = statePath(key);
  if (!existsSync(sPath) && opts.boardId) sPath = statePath(key, opts.boardId);
  if (!existsSync(sPath)) return { slug: key, ran: false, reason: `no schedule registered for "${key}"` };
  const state = JSON.parse(await readFile(sPath, 'utf8'));
  const slug = state.procedure ?? key; // the human-facing slug for the prompt, messages, return
  const now = opts.now ?? Date.now();

  if (state.lastRun) {
    const since = new Date(state.lastRun).getTime();
    if (Number.isFinite(since) && localDaysBetween(since, now) < cadenceDays(state.cadence)) {
      return { slug, ran: false, skipped: true, reason: 'current — skipping' };
    }
  }

  // Fire in the OWNING board root (state.boardDir), so the routine acts where it was
  // registered. A legacy stateless schedule has no boardDir → fall back to the home board
  // root (dirname of the store). A recorded boardDir that no longer exists is a hard error:
  // NEVER silently fire against home instead.
  let cwd;
  if (state.boardDir) {
    if (!existsSync(state.boardDir)) {
      return { slug, ran: false, failed: true, reason: `owning board dir is gone (${state.boardDir}) — not firing against home` };
    }
    cwd = state.boardDir;
  } else {
    cwd = dirname(kanbentoHome()); // legacy stateless — the home board root
  }

  // Assemble the invocation from the FROZEN grant in the state file only — never a live
  // frontmatter re-read (that would let any md-writing agent escalate its own permissions).
  // The template: KANBENTO_RUNNER (test/override) wins, else config.json's `runner`, else the
  // default template that carries the harness flag grammar. Empty grant segments drop cleanly.
  const grant = state.grant ?? { model: null, tools: [] };
  const template = process.env.KANBENTO_RUNNER ?? runnerTemplate(await readConfig());
  const prompt = `Run the kanbento procedure "${slug}": execute \`kanbento do ${slug}\` and follow it with judgment. Stop at the consent gate — store the draft, never send.`;
  const command = assembleRunner(template, grant, prompt);
  const code = await runShell(command, cwd);

  if (code === 0) {
    state.lastRun = new Date(now).toISOString();
    await writeFile(sPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    // Reconcile the two clocks: a wrapped run CAN witness execution (unlike interactive `do`),
    // so append ProcedureInvoked to the OWNING board's log — the board-scoped lastRan fold now
    // reflects scheduled runs. Best-effort: a witnessing hiccup never fails a successful run.
    let witnessed = false;
    if (state.boardDir && state.curie) {
      try { await witnessInvocation(state.boardDir, state.curie); witnessed = true; }
      catch { /* the run succeeded; the witness is advisory */ }
    }
    return { slug, ran: true, exitCode: 0, witnessed };
  }
  return { slug, ran: true, failed: true, exitCode: code };
}

// Witness a scheduled run on its owning board: append a ProcedureInvoked event to that
// board's log (the same fact interactive `do` records, but here the wrapped run genuinely
// witnessed execution). Opens the board from its on-disk manifest + event log.
async function witnessInvocation(boardDir, curie) {
  const board = await openBoard({
    manifestPath: manifestPathIn(boardDir),
    log: new FileLog(join(dataDirIn(boardDir), 'events.jsonl')),
    boardDir,
  });
  await board.procedureInvoked(curie, { by: 'schedule' });
}
