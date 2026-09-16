import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stages, stageById } from './manifest.js';
import { stageAgreementPath, stageProcedurePath } from './refs.js';
import { parseAgreement } from './agreement.js';

// The reactive subsystem. The kernel engineers context for each event; a hook's
// evaluator judges it. The evaluator is an LLM by default (`claude -p`) but may
// be any command — a local model, another agent, or a plain script. Both LLM
// and script handlers are first-class. See docs/hooks.md.
//
//   before  the evaluator returns a verdict; approve:false VETOES the verb
//   after   the evaluator reacts; it may call verbs back via $KANBENTO_CLI
//
// Recursion is bounded by a causation depth carried on events (see kernel.js).

const MAX_DEPTH = Number(process.env.KANBENTO_MAX_HOOK_DEPTH ?? 4);
const DEFAULT_EVALUATOR = 'claude -p "$KANBENTO_PROMPT"';

export function matchingHooks(manifest, event, phase) {
  if (process.env.KANBENTO_NO_HOOKS === '1') return [];
  const depth = event.cause?.depth ?? 0;
  if (depth >= MAX_DEPTH) return []; // recursion guard — stop the cascade
  return (manifest.hooks ?? []).filter(
    (h) => (h.phase ?? 'after') === phase && h.on === event.type && whereMatches(h.where, event),
  );
}

function whereMatches(where, event) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => event[k] === v);
}

// The DoR/DoD criteria for a stage's section as [{severity, text}], from the inline manifest
// form (`stage.entry`/`exit` = [[severity, text], ...]) or, failing that, the agreement doc's
// Ready/Done. entry == ready (DoR), exit == done (DoD). These criteria feed the gate checklist
// injected on a forward transition (gateChecklistItems) — the specialist self-evaluates the
// injected list; no separate evaluator fires on the transition (the double-gating is gone).
export function stageCriteria(manifest, stageId, section, boardDir) {
  const inline = stageById(manifest, stageId)?.[section === 'done' ? 'exit' : 'entry'];
  if (Array.isArray(inline)) return inline.map(normalizeCriterion);
  const rel = stageAgreementPath(manifest, stageId);
  if (!rel) return [];
  const path = resolve(boardDir ?? '.', rel);
  if (!existsSync(path)) return [];
  return parseAgreement(readFileSync(path, 'utf8'))[section] ?? [];
}

// Per-stage gate checklist: list name + items seeded on a forward transition into `stageId`.
// entry → DoR items, exit → DoD items; role encoded as a `DoR:` / `DoD:` text prefix (checklist
// items have no role field). Strength carried as uppercase MUST/SHOULD/MAY when present.
// Returns null when the stage has neither entry nor exit criteria (do not create an empty list).
// De-dupes by final item text so a repeated criterion seeds once.
export function gateChecklistItems(manifest, stageId, boardDir) {
  const items = [];
  const seen = new Set();
  const push = (role, criteria) => {
    for (const c of criteria) {
      const text = formatGateItem(role, c);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ text, done: false });
    }
  };
  push('DoR', stageCriteria(manifest, stageId, 'ready', boardDir));
  push('DoD', stageCriteria(manifest, stageId, 'done', boardDir));
  if (!items.length) return null;
  return { listName: `${stageId} gate`, items };
}

const SEV_WORD = { must: 'MUST', should: 'SHOULD', may: 'MAY' };
// Leading RFC-2119 keyword already embedded in criterion text (agreement docs keep the word).
const LEADING_SEV = /^(?:MUST(?:\s+NOT)?|SHALL(?:\s+NOT)?|REQUIRED|SHOULD(?:\s+NOT)?|RECOMMENDED|MAY|OPTIONAL)\b/i;

function formatGateItem(role, { severity, text }) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // Agreement prose already carries the keyword ("MUST inputs are defined") — role-prefix only.
  // Inline tuples separate severity from text (['SHOULD', 'the card names']) — insert the word.
  if (LEADING_SEV.test(t)) return `${role}: ${t}`;
  const word = severity ? SEV_WORD[severity] : null;
  return word ? `${role}: ${word} ${t}` : `${role}: ${t}`;
}

// Normalize an inline criterion to {severity, text}: a ['MUST', 'text'] tuple, a
// {severity, text} object, or a bare string (defaulting to MUST — blocking unless softened).
function normalizeCriterion(c) {
  if (Array.isArray(c)) return { severity: normSeverity(c[0]), text: String(c[1] ?? '').trim() };
  if (c && typeof c === 'object') return { severity: normSeverity(c.severity), text: String(c.text ?? '').trim() };
  const text = String(c).trim();
  return { severity: normSeverity(text), text }; // a bare string: severity from its leading keyword
}

// MUST blocks, SHOULD warns, MAY informs. No recognized keyword -> null: the criterion is
// stated without a severity, so it's open to the judge's interpretation — never an auto-block.
function normSeverity(s) {
  const k = String(s ?? '').trim().toLowerCase();
  if (k.startsWith('must') || k.startsWith('shall') || k === 'required') return 'must';
  if (k.startsWith('should') || k === 'recommended') return 'should';
  if (k.startsWith('may') || k === 'optional') return 'may';
  return null; // no explicit severity -> open for interpretation
}

// The full contract an agent needs to WORK a stage (not merely judge it): the Body
// (the procedure prose) plus the Ready/Done criteria. The run engine's brief inlines
// this so the doer sees the SOP and the bar its work will be judged against. Body
// comes only from an agreement doc; inline entry/exit carry criteria but no prose.
export function stageContract(manifest, stageId, boardDir) {
  const contract = {
    body: agreementBody(manifest, stageId, boardDir),
    ready: stageCriteria(manifest, stageId, 'ready', boardDir),
    done: stageCriteria(manifest, stageId, 'done', boardDir),
  };
  // A stage may declare a distinct worker (`stage.procedure`) ALONGSIDE its agreement gate:
  // the agreement's Body is its own prose, the procedure is a separate SOP pointer. When both
  // are present, surface the worker pointer too (the agreement supplies body/ready/done). A
  // single-declaration stage is untouched — agreement-only or procedure-only returns exactly
  // {body, ready, done}, no `procedure` key, as before.
  const proc = stageProcedurePath(manifest, stageId);
  if (proc && stageAgreementPath(manifest, stageId)) contract.procedure = proc;
  return contract;
}

function agreementBody(manifest, stageId, boardDir) {
  const rel = stageAgreementPath(manifest, stageId);
  if (!rel) return '';
  const path = resolve(boardDir ?? '.', rel);
  if (!existsSync(path)) return '';
  return parseAgreement(readFileSync(path, 'utf8')).body ?? '';
}

// Forward = the target stage sits later in the declared order than the source.
// Used by the transition gate-checklist seed to inject DoR/DoD only on a forward move.
export function isForward(manifest, from, to) {
  const ids = stages(manifest).map((s) => s.id);
  const i = ids.indexOf(from);
  return i >= 0 && ids.indexOf(to) > i;
}

// Run a hook's evaluator over kernel-engineered context. The kernel builds
// `prompt` (rendered) and `context` (structured); the evaluator reads either.
export async function runEvaluator(hook, { event, prompt, context, boardDir }) {
  const command = hook.evaluator ?? hook.command ?? process.env.KANBENTO_EVALUATOR ?? DEFAULT_EVALUATOR;
  const depth = (event.cause?.depth ?? 0) + 1;
  return execCommand(command, {
    KANBENTO_PROMPT: prompt,
    KANBENTO_CONTEXT: JSON.stringify(context),
    KANBENTO_EVENT: JSON.stringify(event),
    KANBENTO_BOARD: boardDir,
    KANBENTO_HOOK_ID: hook.id ?? hook.on,
    KANBENTO_HOOK_DEPTH: String(depth),
    KANBENTO_CAUSE_EVENT: event.eventId ?? '',
  });
}

// stdout carries the verdict/answer; stderr is diagnostics. Keeping them apart
// means a verdict parser never trips over an evaluator that echoes its context.
// Exported: the run engine's invoker (kernel.js) is the same shell-out, a doer
// instead of a judge — `claude -p` by default, any command via manifest.runInvoker.
export function execCommand(command, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: String(e.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
