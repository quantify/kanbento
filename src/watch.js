import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { kanbentoHome } from './boards.js';
import { captureCard } from './commands.js';
import * as githubResolver from './resolvers/github.js';

// `watch` — a standing observation on external state: a logged registration whose checks
// run FETCH → DIFF → MATCH, whose only output is silence or an inbox capture. Registration
// is an event (WatchSet/WatchCleared, on the board's log); per-check state (last snapshot,
// last verdict) lives in a STATE FILE (the schedule-state precedent) — checks NEVER touch
// the event log. Only matcher HITS reach the board, as ordinary captures with diff evidence.
//
// The pipeline is a mechanical bulk stage (cheap, deterministic) gating an expensive judgment
// stage: FETCH normalizes a snapshot, DIFF asks the one mechanical question ("changed at
// all?"), and only a non-empty diff spends the LLM matcher on the watch's stored question.

// --- namespace → resolver table ---------------------------------------------
// Rung 1 ships one built-in resolver (github). The table IS the extension seam: rung 2/3
// slot board-local script resolvers in via the shadow-chain pattern, kernel untouched. A
// resolver FETCHES a normalized snapshot and interprets nothing.
export const RESOLVERS = { github: githubResolver };
export const SUPPORTED_NAMESPACES = Object.keys(RESOLVERS);

// Parse an `--on` value into { namespace, id }. The grammar is `namespace:id` — the same
// namespace:id shape CURIEs use (rung 3 unifies them). Split on the FIRST colon: a github id
// (owner/repo#N) carries no colon, so the remainder is the whole id.
export function parseOn(on) {
  const s = String(on ?? '').trim();
  const i = s.indexOf(':');
  if (i < 1 || i >= s.length - 1) {
    throw new Error(`watch: --on must be namespace:id (e.g. github:owner/repo#12) — got "${on}"`);
  }
  return { namespace: s.slice(0, i), id: s.slice(i + 1) };
}

// Validate an `--on` against the supported namespaces — rung 1 is github-only. Rejects with
// the supported set named, so the next move needs no lookup. Returns { namespace, id }.
export function assertSupportedOn(on) {
  const parsed = parseOn(on);
  if (!SUPPORTED_NAMESPACES.includes(parsed.namespace)) {
    throw new Error(
      `watch: namespace "${parsed.namespace}" is not supported — rung 1 supports: ${SUPPORTED_NAMESPACES.join(', ')}`,
    );
  }
  return parsed;
}

// --- state file (schedule-state precedent) ----------------------------------
// Per-board runtime state under $KANBENTO_HOME (a real board's ~/.kanbento). Board-qualified
// so two boards watching the same referent never collide. NOT the event log: checks rewrite
// this file; they append nothing.
export function watchDir() { return join(kanbentoHome(), 'watch'); }
export function watchStatePath(boardId) { return join(watchDir(), `${boardId ?? 'board'}.json`); }

// The state key for one watch: (cardId, on). A card may watch several referents; a referent
// may be watched by several cards.
export function stateKey(cardId, on) { return `${cardId}\0${on}`; }

export async function readWatchState(boardId) {
  try { return JSON.parse(await readFile(watchStatePath(boardId), 'utf8')); }
  catch { return {}; } // no state yet — nothing checked
}

export async function writeWatchState(boardId, state) {
  await mkdir(watchDir(), { recursive: true });
  await writeFile(watchStatePath(boardId), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// --- diff (generic) ---------------------------------------------------------
// Deep-compare two normalized snapshots, keyed on the shallow snapshot fields (a resolver
// returns a flat, normalized object by design). Returns a minimal { key: { from, to } } for
// the matcher, or null when nothing changed. deep-equal on values so an array field (labels)
// only diffs on real membership change.
export function diffSnapshots(prev, next) {
  const diff = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const k of keys) {
    const a = prev?.[k];
    const b = next?.[k];
    if (!deepEqual(a, b)) diff[k] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(diff).length ? diff : null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

// --- match (the LLM verdict) ------------------------------------------------
// The rung-1 matcher is HARDCODED to the grok binary (George's call). The invocation is a
// verified read-only/no-tools surface: `grok -p <prompt> --json-schema <schema> --tools ""
// --max-turns 1 --verbatim`. grok has no native timeout, so the child is wrapped with one.
// KANBENTO_WATCH_MATCHER_CMD is a TEST-ONLY seam (undocumented) — when set it replaces the
// argv (run via `sh -c`, prompt in $KANBENTO_WATCH_PROMPT); grok stays the default.
const MATCHER_SCHEMA = { type: 'object', properties: { hit: { type: 'boolean' }, why: { type: 'string' } }, required: ['hit', 'why'] };
const MATCHER_TIMEOUT_MS = 120000;

// The matcher prompt: the watch's stored question + the diff + the new snapshot (compact
// JSON), asking whether the change means the watched-for condition is met.
export function matcherPrompt(question, diff, snapshot) {
  return [
    'You are the matcher for a standing watch on external state. A change was detected. Decide whether this change means the watched-for condition below is now met.',
    '',
    `Watched-for condition (the question): ${question}`,
    '',
    `What changed (diff): ${JSON.stringify(diff)}`,
    '',
    `Current state (snapshot): ${JSON.stringify(snapshot)}`,
    '',
    'Answer with hit=true only if the change clearly satisfies the condition; otherwise hit=false. Put a one-line justification in why.',
  ].join('\n');
}

function runProcess(file, argv, { env } = {}) {
  return new Promise((res) => {
    const child = spawn(file, argv, { env: { ...process.env, ...env }, timeout: MATCHER_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (error) => res({ ok: false, stdout, stderr, error }));
    child.on('close', (code, signal) => res({ ok: code === 0, code, signal, stdout, stderr }));
  });
}

// Extract the FIRST balanced-looking JSON object carrying a boolean `hit`. Tolerant of the
// grok `--verbatim` envelope (a wrapper object with `.structuredOutput` = the schema object,
// and `.text` = its stringified form) AND of a bare `{hit, why}` (the test stub echoes that).
export function parseMatcherVerdict(stdout) {
  const take = (o) => (o && typeof o === 'object' && typeof o.hit === 'boolean' ? { hit: o.hit, why: String(o.why ?? '') } : null);
  const envelope = tryParse(stdout);
  if (envelope && typeof envelope === 'object') {
    return (
      take(envelope.structuredOutput) ?? // grok --verbatim: the schema-conforming object
      take(envelope) ?? // a bare {hit, why} (test stub)
      (typeof envelope.text === 'string' ? take(tryParse(envelope.text)) : null) // grok's stringified .text
    );
  }
  // Last resort: the first {...} span in raw stdout.
  const m = String(stdout).match(/\{[\s\S]*\}/);
  return m ? take(tryParse(m[0])) : null;
}

function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Run the matcher over a change. Returns { hit, why }. Throws when the child fails with no
// parseable verdict — the check pipeline records the error and moves on (a resolver/matcher
// failure never crashes the whole run).
export async function runMatcher(question, diff, snapshot, { matcherCmd = process.env.KANBENTO_WATCH_MATCHER_CMD } = {}) {
  const prompt = matcherPrompt(question, diff, snapshot);
  const res = matcherCmd
    ? await runProcess('sh', ['-c', matcherCmd], { env: { KANBENTO_WATCH_PROMPT: prompt } })
    : await runProcess('grok', ['-p', prompt, '--json-schema', JSON.stringify(MATCHER_SCHEMA), '--tools', '', '--max-turns', '1', '--verbatim']);
  const verdict = parseMatcherVerdict(res.stdout);
  if (!verdict) {
    const why = res.error?.message || res.stderr?.trim().split('\n')[0] || `exit ${res.code ?? res.signal ?? '?'}`;
    throw new Error(`watch matcher returned no parseable {hit, why} verdict (${why})`);
  }
  return verdict;
}

// --- the hit capture --------------------------------------------------------
// A matcher hit re-enters the ONE funnel: an inbox capture with lineage from the watching
// card (capture --from), carrying the watch question, the diff, and the matcher's why as the
// body evidence. Silence otherwise — no event, no capture.
function shortWhy(why) {
  const s = String(why ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

async function createHitCapture({ board, dir }, watch, diff, snapshot, verdict) {
  const title = `watch hit: ${watch.on} — ${shortWhy(verdict.why)}`;
  const body = [
    `# ${title}`,
    '',
    `A standing watch on \`${watch.on}\` fired (lineage: the watching card).`,
    '',
    '## Watched-for condition',
    watch.question,
    '',
    '## Why (matcher verdict)',
    verdict.why,
    '',
    '## Diff',
    '```json',
    JSON.stringify(diff, null, 2),
    '```',
    '',
    '## Snapshot',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
  ].join('\n');
  const { card } = await captureCard({ board, dir }, body, { from: watch.cardId, title, source: 'agent', richBody: true });
  return card;
}

// --- the check pipeline (per watch) -----------------------------------------
// FETCH → DIFF → MATCH over ONE watch, mutating `state[stateKey]` in place. Baseline (no
// prior snapshot) stores and stays silent; no change updates lastChecked and stays silent;
// a change spends the matcher and, on a hit, captures. A resolver/matcher failure is recorded
// in state and reported — never thrown out of the run. Returns a per-watch outcome for the CLI.
export async function checkWatch({ board, dir }, watch, state, { resolvers = RESOLVERS, matcherCmd } = {}) {
  const key = stateKey(watch.cardId, watch.on);
  const prev = state[key] ?? {};
  const at = new Date().toISOString();
  const entry = { ...prev, on: watch.on, cardId: watch.cardId, lastChecked: at };

  const { namespace, id } = parseOn(watch.on);
  const resolver = resolvers[namespace];
  if (!resolver) {
    entry.lastError = `no resolver for namespace "${namespace}"`;
    state[key] = entry;
    return { watch, status: 'error', error: entry.lastError };
  }

  // FETCH
  let snapshot;
  try {
    snapshot = await resolver.resolve(id);
  } catch (e) {
    entry.lastError = e.message;
    state[key] = entry;
    return { watch, status: 'error', error: e.message };
  }
  entry.lastError = null;

  // DIFF — first check is a baseline: store, no diff, no matcher.
  if (!('lastSnapshot' in prev)) {
    entry.lastSnapshot = snapshot;
    state[key] = entry;
    return { watch, status: 'baseline' };
  }
  const diff = diffSnapshots(prev.lastSnapshot, snapshot);
  entry.lastSnapshot = snapshot;
  if (!diff) {
    state[key] = entry;
    return { watch, status: 'unchanged' };
  }
  entry.lastDiffAt = at;

  // MATCH — only on a non-empty diff.
  let verdict;
  try {
    verdict = await runMatcher(watch.question, diff, snapshot, { matcherCmd });
  } catch (e) {
    entry.lastError = e.message;
    state[key] = entry;
    return { watch, status: 'error', error: e.message, diff };
  }
  entry.lastVerdict = verdict.why;
  entry.lastVerdictHit = verdict.hit;

  if (verdict.hit) {
    const card = await createHitCapture({ board, dir }, watch, diff, snapshot, verdict);
    state[key] = entry;
    return { watch, status: 'hit', why: verdict.why, diff, card };
  }
  state[key] = entry;
  return { watch, status: 'miss', why: verdict.why, diff };
}

// Run the check pipeline over EVERY active watch, sharing one state read/write. `watches`
// come folded from the log (board.watches()); state is board-qualified. Returns the per-watch
// results for the CLI to report.
export async function checkWatches({ board, dir }, { resolvers, matcherCmd } = {}) {
  const boardId = board.manifest?.board?.id;
  const watches = await board.watches();
  const state = await readWatchState(boardId);
  const results = [];
  for (const w of watches) {
    results.push(await checkWatch({ board, dir }, w, state, { resolvers, matcherCmd }));
  }
  await writeWatchState(boardId, state);
  return results;
}
