import { mkdir, readdir, cp, access, readFile, writeFile } from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import { join, basename, isAbsolute, normalize, resolve, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { readFrontmatter } from './frontmatter.js';
import { declaredWorkspace, findRepoRoot, computeWorktreeDiff, removeWorktree } from './workspace.js';

// The procedure RUNNER — the mechanics behind `kanbento do <name> [key=value...]`.
// A bare file procedure with no params keeps the legacy serve path (zero behavior
// change); a folder-form procedure (.kanbento/procedures/<slug>/SKILL.md) or one
// declaring `params:` engages the runner: validate params → materialize a run dir
// (a full copy of the skill folder, so SKILL.md's RELATIVE references resolve in
// place) → run the init hook from the copy → interpolate ${...} slots → persist
// the compiled prompt. Everything here is pure mechanics; cli.js orchestrates.

const HOOK_TIMEOUT_MS = 60000;

// Normalize a record's `params:` frontmatter into { key: { required, default } }.
// null when the block is absent (the procedure is parameterless — pairs are then
// an error, not silently dropped). Values are strings at rung 1: a scalar value
// is shorthand for a default; a null value (`issue:`) declares a bare param.
export function declaredParams(rec) {
  const raw = rec?.params;
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`do: ${rec.curie ?? 'procedure'} has a malformed params: block — declare a map, e.g. params: { issue: { required: true } }`);
  }
  const out = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v == null) out[key] = {};
    else if (typeof v === 'object' && !Array.isArray(v)) {
      out[key] = { ...(v.required ? { required: true } : {}), ...(v.default != null ? { default: String(v.default) } : {}) };
    } else out[key] = { default: String(v) }; // scalar shorthand: `limit: "500"`
  }
  return out;
}

// The env binding for one param key: KANBENTO_PARAM_<UPPERKEY> (non-alnum → _).
export function paramEnvKey(key) {
  return `KANBENTO_PARAM_${String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

// Validate the invocation's params BEFORE anything executes: CLI pairs win over
// env (KANBENTO_PARAM_<UPPERKEY>), defaults fill the rest; an unknown key errors
// naming the declared params, a missing required key errors naming the fix.
// Returns the validated { key: value } map (all strings).
export function validateParams({ declared, pairs = [], env = {}, name = 'procedure' }) {
  const keys = Object.keys(declared ?? {});
  const params = {};
  for (const k of keys) {
    const bound = env[paramEnvKey(k)];
    if (bound != null) params[k] = String(bound);
    else if (declared[k].default != null) params[k] = declared[k].default;
  }
  for (const pair of pairs) {
    const at = String(pair).indexOf('=');
    const key = String(pair).slice(0, at);
    const value = String(pair).slice(at + 1);
    if (!keys.includes(key)) {
      throw new Error(`do: unknown param "${key}" — ${name} declares: ${keys.join(', ')}`);
    }
    params[key] = value; // CLI wins over env and defaults
  }
  const missing = keys.filter((k) => declared[k].required && params[k] == null);
  if (missing.length) {
    throw new Error(
      `do: missing required param${missing.length === 1 ? '' : 's'} ${missing.map((k) => `"${k}"`).join(', ')} — pass ${missing.map((k) => `${k}=<value>`).join(' ')} (or env ${missing.map(paramEnvKey).join(', ')})`,
    );
  }
  return params;
}

// Create a per-invocation run dir at .kanbento/runs/<slug>/<ISO-ts-safe>/. For a
// folder-form procedure `copyFrom` is its home: the run dir starts as a RECURSIVE
// COPY of the whole skill folder (SKILL.md, hooks/, scripts/, references/, …) so
// the compiled prompt's relative references resolve in place, the run is a
// complete witness of what ran, and the hook gets a safe cwd. Same-ms collisions
// uniquify with a -2, -3 suffix.
export async function createRunDir(boardDir, slug, { copyFrom = null, now = new Date() } = {}) {
  const base = join(boardDir, '.kanbento', 'runs', slug);
  await mkdir(base, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let runDir = join(base, stamp);
  for (let n = 2; existsSync(runDir); n++) runDir = join(base, `${stamp}-${n}`);
  if (copyFrom) await cp(copyFrom, runDir, { recursive: true });
  else await mkdir(runDir);
  return runDir;
}

// An init-hook failure carries the child's stderr so the CLI can surface it and
// persist it into the run dir's error.txt.
function hookError(message, stderr) {
  const err = new Error(message);
  err.stderr = stderr;
  err.hook = true;
  return err;
}

// Run a procedure's init hook — executable-agnostic (the file is spawned
// directly; its shebang picks the interpreter) FROM THE COPY in the run dir
// (cwd = run dir: scratch files land beside the inputs, the source procedure
// folder is never touched). Contract: env gets KANBENTO_RUN_DIR /
// KANBENTO_BOARD_DIR / KANBENTO_PARAM_<UPPERKEY>; the validated params map
// arrives on stdin as JSON; stdout is empty (context = {}) or one JSON object.
// Non-zero exit, a broken stdout contract, or the 60s hard-kill timeout all
// reject with the stderr attached.
export async function runInitHook({ hook, runDir, boardDir, params, workspaceDir = null, timeoutMs = HOOK_TIMEOUT_MS }) {
  try {
    await access(hook, constants.X_OK);
  } catch {
    throw new Error(`init hook is not executable — chmod +x ${hook}`);
  }
  return await new Promise((resolveP, rejectP) => {
    const env = { ...process.env, KANBENTO_RUN_DIR: runDir, KANBENTO_BOARD_DIR: boardDir, ...(workspaceDir ? { KANBENTO_WORKSPACE_DIR: workspaceDir } : {}) };
    for (const [k, v] of Object.entries(params)) env[paramEnvKey(k)] = v;
    const child = spawn(hook, [], { cwd: runDir, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let out = '';
    let errBuf = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('error', (e) => rejectP(hookError(`init hook failed to start: ${e.message}`, errBuf)));
    child.on('close', (code, signal) => {
      if (signal) return rejectP(hookError(`init hook killed (${signal}) — exceeded the ${Math.round(timeoutMs / 1000)}s timeout`, errBuf));
      if (code !== 0) return rejectP(hookError(`init hook exited ${code}`, errBuf));
      const t = out.trim();
      if (!t) return resolveP({});
      let ctx;
      try { ctx = JSON.parse(t); } catch { return rejectP(hookError('init hook stdout is not JSON — emit nothing (context = {}) or a single JSON object', errBuf)); }
      if (typeof ctx !== 'object' || ctx === null || Array.isArray(ctx)) {
        return rejectP(hookError('init hook stdout must be a single JSON object (the context), not a scalar or array', errBuf));
      }
      resolveP(ctx);
    });
    child.stdin.on('error', () => {}); // a hook that never reads stdin closes the pipe — not a failure
    child.stdin.end(JSON.stringify(params));
  });
}

// Walk a dot-path into the interpolation scope: params.<key> · context.<path>
// (into the init hook's JSON) · run.dir · workspace.dir (the worktree checkout,
// present only in worktree mode — fs-mode procedures referencing it get the
// unresolved-slot error, which is correct: only worktree procedures use it).
// Anything else is unresolved (undefined).
function resolveSlot(scope, expr) {
  const segs = String(expr).trim().split('.');
  if (!['params', 'context', 'run', 'workspace'].includes(segs[0])) return undefined;
  let cur = scope;
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object' || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

// Interpolate ${params.<key>} / ${context.<path>} / ${run.dir} slots into a body.
// ANY unresolved slot is a loud error listing every offender — never partial
// output (a half-compiled prompt is worse than none). Escape hatch: $${ renders
// a literal ${.
export function interpolate(text, scope) {
  const unresolved = [];
  const out = String(text).replace(/\$\$\{|\$\{([^}]*)\}/g, (m, expr) => {
    if (m === '$${') return '${';
    const val = resolveSlot(scope, expr);
    if (val === undefined) { unresolved.push(`\${${expr}}`); return m; }
    return typeof val === 'string' ? val : JSON.stringify(val);
  });
  if (unresolved.length) {
    throw new Error(
      `do: unresolved slot${unresolved.length === 1 ? '' : 's'} ${[...new Set(unresolved)].join(', ')} — available: params.<key>, context.<path> (the init hook's JSON), run.dir, workspace.dir (worktree mode only) (escape a literal with $\${)`,
    );
  }
  return out;
}

// --- artifacts: the run's declared deliverables (rung 2) ---------------------

// The compact schema notation, rung-2 minimal: "string" | "int" | "number" |
// "bool" | "<T>[]" (scalar array) | a nested object literal | a one-element array
// literal [<T>] (array whose every element matches <T> — the only way to express
// an array-of-objects, e.g. [{ pr: int, category: string }]). The notation recurses:
// object fields and array elements are themselves schemas, arbitrarily nested.
// Anything else errors at MANIFEST READ time (declaredArtifacts), never at
// validation time — a typo'd contract must not silently pass runs.
const SCHEMA_SCALARS = new Set(['string', 'int', 'number', 'bool']);
const SCHEMA_FORMS = '"string" | "int" | "number" | "bool" | "<T>[]" | a nested object literal | a one-element array literal [<T>]';

function assertSchemaNotation(schema, at) {
  if (typeof schema === 'string') {
    const base = schema.endsWith('[]') ? schema.slice(0, -2) : schema;
    if (SCHEMA_SCALARS.has(base)) return;
  } else if (Array.isArray(schema)) {
    // A one-element array literal [<T>] means "array whose elements match <T>".
    if (schema.length === 1) return void assertSchemaNotation(schema[0], `${at}[]`);
  } else if (schema != null && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) assertSchemaNotation(v, `${at}.${k}`);
    return;
  }
  throw new Error(`unknown schema notation ${JSON.stringify(schema)} at ${at} — use ${SCHEMA_FORMS}`);
}

// Render a schema readably for the compiled prompt / a violation message:
// { issues: int[], reason: string } — an array literal renders as <element>[],
// so [{ pr: int }] round-trips to { pr: int }[].
export function schemaLabel(schema) {
  if (typeof schema === 'string') return schema;
  if (Array.isArray(schema)) return `${schemaLabel(schema[0])}[]`;
  return `{ ${Object.entries(schema).map(([k, v]) => `${k}: ${schemaLabel(v)}`).join(', ')} }`;
}

// An artifact file: must stay inside the run dir — relative path only, no absolute,
// no `..` escape after normalize. Enforced at manifest read (declaredArtifacts) so a
// malicious/typo'd SKILL.md fails BEFORE any join/read/write against the path
// (runner-artifact-path-traversal@4d310af0).
export function normalizeArtifactFile(file, who, name) {
  const s = String(file);
  if (!s.trim()) {
    throw new Error(`do: ${who} artifact "${name}" file: is empty — declare a run-dir-relative path, e.g. file: ${name}.json`);
  }
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    throw new Error(`do: ${who} artifact "${name}" file: must be relative to the run dir, not absolute (got ${JSON.stringify(s)})`);
  }
  if (s.includes('\0')) {
    throw new Error(`do: ${who} artifact "${name}" file: contains illegal characters`);
  }
  const norm = normalize(s);
  // After normalize, escape attempts surface as a leading `..` segment
  // (e.g. `foo/../../etc/hosts` → `../etc/hosts`).
  const parts = norm.split(/[/\\]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts[0] === '..' || parts.includes('..')) {
    throw new Error(`do: ${who} artifact "${name}" file: escapes the run dir (got ${JSON.stringify(s)}) — use a path under the run dir only`);
  }
  return parts.join('/'); // posix-style relative for stable joins
}

// True when `target` is `root` or a path strictly under it (after resolve).
export function pathInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// Normalize a record's `artifacts:` frontmatter into { name: { file, required, schema } }.
// null when the block is absent (nothing to validate or dispose). Each entry needs a
// `file:`; a `schema:` is checked against the notation NOW — manifest read time.
export function declaredArtifacts(rec) {
  const raw = rec?.artifacts;
  if (raw == null) return null;
  const who = rec.curie ?? 'procedure';
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`do: ${who} has a malformed artifacts: block — declare a map, e.g. artifacts: { verdict: { file: verdict.json, required: true } }`);
  }
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (v == null || typeof v !== 'object' || Array.isArray(v) || v.file == null) {
      throw new Error(`do: ${who} artifact "${name}" needs a file:, e.g. artifacts: { ${name}: { file: ${name}.json } }`);
    }
    if (v.schema != null) assertSchemaNotation(v.schema, `${who} artifacts.${name}.schema`);
    out[name] = { file: normalizeArtifactFile(v.file, who, name), required: !!v.required, schema: v.schema ?? null };
  }
  return Object.keys(out).length ? out : null;
}

// The generated ARTIFACTS section of the compiled prompt — the contract the agent
// sees up front: which files to write into the run dir, which are required, and
// the expected schema. Slotted after the body, before the precedents/pointers footer.
export function renderArtifactsSection(artifacts, runDir) {
  const out = ['## Artifacts', '', 'Your entire output is these files in the run dir — they are validated and disposed at finalize.', ''];
  for (const [name, a] of Object.entries(artifacts)) {
    const req = a.required ? 'REQUIRED' : 'optional';
    const schema = a.schema ? ` — JSON matching ${schemaLabel(a.schema)}` : a.file.endsWith('.json') ? ' — valid JSON' : '';
    out.push(`- ${name} (${req}): write \`${join(runDir, a.file)}\`${schema}`);
  }
  return out.join('\n');
}

// The disposition instruction is injected by the runner, not authored in the skill —
// and only in INTERACTIVE mode (bare `do`), where no runner loop will finalize on the
// agent's behalf, so the session agent must trigger it. Under `--exec` the runner
// finalizes after the harness exits, so nothing is injected (telling the agent to run
// --finalize mid-session would double-dispose). The agent calls the gate-respecting
// verb, never hooks/finalize raw (that skips validation + the status gate).
export function renderDispositionSection(slug) {
  return [
    '## Disposition',
    '',
    `When the artifacts are written, run \`kanbento do ${slug} --finalize\` to validate and dispose them: a draft procedure captures the result to the board inbox; a trusted one runs its effect. Do not perform the effect yourself.`,
  ].join('\n');
}

function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === 'object') return 'object';
  return JSON.stringify(v);
}

function scalarOk(value, t) {
  if (t === 'string') return typeof value === 'string';
  if (t === 'int') return Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean'; // 'bool'
}

// Check one parsed JSON value against a schema, appending every violation (never
// stop at the first — the whole list feeds the re-prompt). Extra keys are tolerated
// (union tolerance, the house style); missing declared keys are not.
function checkSchema(value, schema, path, out) {
  if (typeof schema === 'string') {
    if (schema.endsWith('[]')) {
      const t = schema.slice(0, -2);
      if (!Array.isArray(value)) return void out.push(`${path}: expected ${schema}, got ${describeValue(value)}`);
      value.forEach((v, i) => { if (!scalarOk(v, t)) out.push(`${path}[${i}]: expected ${t}, got ${describeValue(v)}`); });
      return;
    }
    if (!scalarOk(value, schema)) out.push(`${path}: expected ${schema}, got ${describeValue(value)}`);
    return;
  }
  if (Array.isArray(schema)) {
    // A one-element array literal: value must be an array; each element is checked
    // against the element schema (recursion handles array-of-objects and nesting).
    if (!Array.isArray(value)) return void out.push(`${path}: expected ${schemaLabel(schema)}, got ${describeValue(value)}`);
    value.forEach((v, i) => checkSchema(v, schema[0], `${path}[${i}]`, out));
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return void out.push(`${path}: expected an object matching ${schemaLabel(schema)}, got ${describeValue(value)}`);
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!(k in value)) out.push(`${path}.${k}: missing (expected ${schemaLabel(v)})`);
    else checkSchema(value[k], v, `${path}.${k}`, out);
  }
}

// Validate a run dir's artifacts against the declaration. EVERY violation is
// collected (machine-readable enough to append to a re-prompt): a required file
// missing, a .json that doesn't parse, a schema mismatch. A non-JSON artifact with
// no schema is an existence check only. Returns { violations, manifest } — the
// manifest maps each PRESENT artifact to { file, path } (the finalize hook's stdin).
export async function validateArtifacts(artifacts, runDir) {
  const violations = [];
  const manifest = {};
  const root = resolve(runDir);
  for (const [name, a] of Object.entries(artifacts)) {
    // Defense in depth: even if a caller bypassed declaredArtifacts, never
    // read/join a path that leaves the run dir.
    let rel;
    try { rel = normalizeArtifactFile(a.file, 'procedure', name); }
    catch (e) { violations.push(`${a.file}: ${e.message.replace(/^do: /, '')}`); continue; }
    const path = resolve(root, rel);
    if (!pathInside(root, path)) {
      violations.push(`${a.file}: escapes the run dir — artifacts must stay under ${root}`);
      continue;
    }
    if (!existsSync(path)) {
      if (a.required) violations.push(`${rel}: required artifact missing — write it to ${path}`);
      continue;
    }
    if (a.schema || rel.endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(await readFile(path, 'utf8')); }
      catch (e) { violations.push(`${rel}: not valid JSON — ${e.message}`); continue; }
      if (a.schema) checkSchema(parsed, a.schema, rel, violations);
    }
    manifest[name] = { file: rel, path };
  }
  return { violations, manifest };
}

// Resolve which run `--finalize [runRef]` means: the latest run of the slug by
// default, else the unique run-dir timestamp prefix. Ambiguity and absence both
// error naming the candidates.
export async function resolveRunDir(boardDir, slug, ref = null) {
  const base = join(boardDir, '.kanbento', 'runs', slug);
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch { throw new Error(`do --finalize: no runs recorded for ${slug} — run \`kanbento do ${slug}\` first`); }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!dirs.length) throw new Error(`do --finalize: no runs recorded for ${slug} — run \`kanbento do ${slug}\` first`);
  if (!ref) return join(base, dirs[dirs.length - 1]);
  const matches = dirs.filter((n) => n.startsWith(ref));
  if (matches.length === 1) return join(base, matches[0]);
  if (matches.length > 1) throw new Error(`do --finalize: "${ref}" is ambiguous — matches ${matches.join(', ')}`);
  throw new Error(`do --finalize: no run of ${slug} matches "${ref}" — recorded: ${dirs.join(', ')}`);
}

// The effective disposition: the STATUS GATE composed with the flags, never
// overridden by them. draft (or any untrusted status) caps at observe regardless;
// --safe forces observe even on trusted; --dry-run records what WOULD happen.
export function effectiveDisposition({ status = null, dryRun = false, safe = false } = {}) {
  const gate = status === 'trusted' ? 'effect' : 'observe'; // the trust axis — only trusted earns the effect
  const wouldHave = safe ? 'observe' : gate;
  return dryRun ? { mode: 'dry', wouldHave } : { mode: wouldHave };
}

// Run a procedure's finalize hook — the SAME contract style as init (ANY
// executable, spawned directly, cwd = run dir, 60s hard kill) with the finalize
// bindings: env adds KANBENTO_MODE (+ KANBENTO_WORKSPACE_DIR in worktree mode),
// stdin carries the VALIDATED artifact manifest as JSON. fs mode: the BARE manifest
// ({ name: { file, path } }) — the unchanged contract. worktree mode: the manifest
// wrapped alongside the diff ({ artifacts: {...}, diff: { patch, summary } }) so the
// hook can push/PR the diff. No stdout contract — the hook IS the effect. Resolves
// { code, signal, stderr } (a nonzero exit is the CALLER's disposition business,
// not an exception); rejects only when the hook can't run at all.
export async function runFinalizeHook({ hook, runDir, boardDir, params = {}, mode = 'effect', manifest = {}, diff = null, workspaceDir = null, timeoutMs = HOOK_TIMEOUT_MS }) {
  try {
    await access(hook, constants.X_OK);
  } catch {
    throw new Error(`finalize hook is not executable — chmod +x ${hook}`);
  }
  return await new Promise((resolveP, rejectP) => {
    const env = { ...process.env, KANBENTO_RUN_DIR: runDir, KANBENTO_BOARD_DIR: boardDir, KANBENTO_MODE: mode, ...(workspaceDir ? { KANBENTO_WORKSPACE_DIR: workspaceDir } : {}) };
    for (const [k, v] of Object.entries(params)) env[paramEnvKey(k)] = v;
    const child = spawn(hook, [], { cwd: runDir, env, stdio: ['pipe', 'inherit', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('error', (e) => rejectP(hookError(`finalize hook failed to start: ${e.message}`, errBuf)));
    child.on('close', (code, signal) => resolveP({ code, signal, stderr: errBuf }));
    child.stdin.on('error', () => {}); // a hook that never reads stdin closes the pipe — not a failure
    const payload = diff ? { artifacts: manifest, diff } : manifest;
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readJsonIf(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
}

// Finalize a run — PROPOSE/DISPOSE: the agent's whole output is the declared
// artifact set; effects happen here, after the session, by the runner. Validates
// the artifacts against the manifest THE RUN RAN WITH (the run-dir copy's SKILL.md;
// a file-form run has no copy, so the caller passes the source record), throws a
// `.violations`-carrying error on failure (the retry loop's food), then applies the
// status gate + flags and disposes:
//   observe — capture to the board inbox (via the injected `capture` — the kernel
//             stays cli-side), with lineage when the manifest declares a template
//   dry     — write disposition.json { mode:"dry", wouldHave } and touch nothing else
//   effect  — run hooks/finalize (trusted procedures MUST have one)
// Always writes disposition.json recording what happened.
export async function finalizeRun({ boardDir, runDir, slug, record = null, dryRun = false, safe = false, capture }) {
  const skillMd = join(runDir, 'SKILL.md');
  // The version that RAN, not the current source — a since-edited procedure must
  // not re-gate or re-shape a finished run.
  const data = existsSync(skillMd) ? (await readFrontmatter(skillMd)).data : (record ?? {});
  const artifacts = declaredArtifacts({ ...data, curie: `procedure:${slug}` });
  if (!artifacts) {
    throw new Error(`do --finalize: procedure:${slug} declares no artifacts: block — nothing to validate or dispose (declare the run's deliverables in its frontmatter)`);
  }
  const params = (await readJsonIf(join(runDir, 'params.json'))) ?? {};
  const context = (await readJsonIf(join(runDir, 'context.json'))) ?? {};
  const { violations, manifest } = await validateArtifacts(artifacts, runDir);
  if (violations.length) {
    const err = new Error(`artifact validation failed for ${slug} run ${basename(runDir)}:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    err.violations = violations;
    throw err;
  }
  // DIFF FOR FREE (worktree mode): the workspace.json the run materialized records
  // the base sha; stage + diff the worktree against it into an IMPLICIT `diff`
  // artifact — no declaration needed, in ADDITION to the declared set. Absent /
  // gone worktree → no diff (fs mode, or an already-cleaned run).
  const workspace = declaredWorkspace(data);
  const wsMeta = workspace.mode === 'worktree' ? await readJsonIf(join(runDir, 'workspace.json')) : null;
  const worktreeDir = wsMeta ? join(runDir, 'repo') : null;
  let diff = null;
  if (worktreeDir && wsMeta?.baseSha && existsSync(worktreeDir)) {
    diff = await computeWorktreeDiff({ worktreeDir, baseSha: wsMeta.baseSha, runDir });
  }
  const { mode, wouldHave } = effectiveDisposition({ status: data.status ?? null, dryRun, safe });
  const disposition = {
    mode,
    ...(mode === 'dry' ? { wouldHave } : {}),
    artifacts: Object.entries(manifest).map(([name, m]) => ({ name, file: m.file })),
    ...(diff ? { diff: { patch: basename(diff.patch), summary: diff.summary } } : {}),
    at: new Date().toISOString(),
  };
  let captured = null;
  if (mode === 'observe') {
    // The runner itself captures to the board inbox — the draft-status persistence.
    // Body = the required artifacts' content (all present ones when none is required);
    // source = the interpolated lineage: template, when declared. The diff-for-free
    // rides as a SUMMARY + the run-dir path to diff.patch — never the whole patch
    // inline (card bodies stay sane; the reviewable patch is one hop away).
    const ts = basename(runDir);
    const names = Object.keys(artifacts).filter((n) => manifest[n] && artifacts[n].required);
    const carry = names.length ? names : Object.keys(manifest);
    const parts = [];
    for (const n of carry) parts.push(`## ${manifest[n].file}\n\n${(await readFile(manifest[n].path, 'utf8')).trim()}`);
    if (diff) parts.push(`## diff (worktree vs base)\n\n${diffSummaryLine(diff.summary)}\n\npatch: ${diff.patch}`);
    const first = Object.values(artifacts)[0];
    const source = data.lineage != null
      ? interpolate(String(data.lineage), { params, context, run: { dir: runDir } })
      : undefined;
    captured = await capture({
      title: `${slug} run ${ts}: ${first.file}`,
      body: parts.join('\n\n') || `(run ${ts} produced no artifact content)`,
      source,
    });
    disposition.captured = captured?.id ?? true;
  } else if (mode === 'effect') {
    const hook = join(runDir, 'hooks', 'finalize');
    if (!existsSync(hook)) {
      throw new Error(`do --finalize: trusted procedure ${slug} has no hooks/finalize — the effect has no rails to run on (author one, or pass --safe to observe)`);
    }
    // worktree mode hands the hook the diff on stdin ({ artifacts, diff }) + the
    // KANBENTO_WORKSPACE_DIR env so it can push/PR the checkout; fs mode keeps the
    // bare-manifest contract unchanged.
    const res = await runFinalizeHook({ hook, runDir, boardDir, params, mode, manifest, diff, workspaceDir: worktreeDir });
    disposition.hook = { exit: res.code, ...(res.signal ? { signal: res.signal } : {}) };
    if (res.signal || res.code !== 0) {
      await writeFile(join(runDir, 'disposition.json'), JSON.stringify(disposition, null, 2) + '\n', 'utf8');
      const err = new Error(`finalize hook ${res.signal ? `killed (${res.signal}) — exceeded the timeout` : `exited ${res.code}`} — disposition recorded at ${join(runDir, 'disposition.json')}`);
      err.stderr = res.stderr;
      throw err; // FAILURE: leave the worktree standing for inspection (no cleanup)
    }
  }
  await writeFile(join(runDir, 'disposition.json'), JSON.stringify(disposition, null, 2) + '\n', 'utf8');
  // SUCCESS: the run-dir worktree is transient — remove it (best-effort, guarded).
  // A failed run (validation/hook throw above) never reaches here → kept.
  if (worktreeDir && existsSync(worktreeDir)) {
    const repoRoot = await findRepoRoot(boardDir);
    if (repoRoot) await removeWorktree({ repoRoot, worktreeDir });
  }
  return { mode, wouldHave: mode === 'dry' ? wouldHave : undefined, runDir, manifest, captured, diff };
}

// A one-line diff summary — "3 file(s), +42/-7 · a.js, b.md" — for an observe
// capture body and log lines. Truncates the file list so a big change stays sane.
function diffSummaryLine(summary) {
  const { files = [], insertions = 0, deletions = 0 } = summary ?? {};
  const shown = files.slice(0, 12).join(', ');
  const more = files.length > 12 ? `, +${files.length - 12} more` : '';
  return `${files.length} file(s), +${insertions}/-${deletions}${files.length ? ` · ${shown}${more}` : ''}`;
}

// The run witness for one procedure: how many runs sit under .kanbento/runs/<slug>/
// and when the latest happened (parsed back from the ISO-ts-safe dir name). A cheap
// readdir; a missing dir is simply { count: 0 } — never an error.
export async function runWitness(boardDir, slug) {
  let entries;
  try { entries = await readdir(join(boardDir, '.kanbento', 'runs', slug), { withFileTypes: true }); }
  catch { return { count: 0, last: null }; }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!dirs.length) return { count: 0, last: null };
  const m = dirs[dirs.length - 1].match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  return { count: dirs.length, last: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null };
}
