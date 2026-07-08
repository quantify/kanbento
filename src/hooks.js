import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stages, stageById } from './manifest.js';
import { stageAgreementPath } from './refs.js';
import { parseAgreement, SEVERITY } from './agreement.js';

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

// Synthesize the before-hooks that enforce stage agreements on a forward move — both ends
// of the one transition: the stage being *left* must be Done (exit), the stage being
// *entered* must be Ready (entry). Either, both, or neither fire, depending on which stages
// carry an agreement and which sections it fills. Declaring an `agreement` is enough — no
// manual `hooks:` entry. Forward-only: a loop-back/abandon is neither "done" nor a fresh
// pull. Non-agreement transitions cost only the lookup.
export function agreementHooks(manifest, event, phase, boardDir) {
  if (process.env.KANBENTO_NO_HOOKS === '1') return [];
  if ((event.cause?.depth ?? 0) >= MAX_DEPTH) return [];
  if (phase !== 'before' || event.type !== 'CardTransitioned' || !event.from) return [];
  if (!isForward(manifest, event.from, event.to)) return [];
  return [
    sectionHook(manifest, event.from, 'done', boardDir), // exit: the Definition of Done
    sectionHook(manifest, event.to, 'ready', boardDir), // entry: the Definition of Ready
  ].filter(Boolean);
}

// One hook for one section of one stage's agreement (its Done, or its Ready). null when the
// stage has no agreement or nothing in that section. The DoD judges the produced artifact;
// the DoR judges the item's readiness — same `claude -p` machinery, different evidence.
function sectionHook(manifest, stageId, section, boardDir) {
  // Only criteria with an explicit severity (MUST/SHOULD/MAY) are judged; one stated without
  // a keyword is open for interpretation, left to the agent — no value judging vague conditions.
  const criteria = stageCriteria(manifest, stageId, section, boardDir).filter((c) => c.severity);
  if (!criteria.length) return null;
  const dod = section === 'done';
  return {
    id: `agreement:${stageId}:${dod ? 'dod' : 'dor'}`,
    on: 'CardTransitioned',
    phase: 'before',
    evaluator: manifest.agreementEvaluator, // undefined -> default claude -p; a script/local model for determinism or tests
    policy: formatCriteria(stageId, section, criteria),
    evaluate: dod
      ? 'Judge whether the work satisfies the Definition of Done above. MUST items are blocking — ' +
        'answer approve:false if ANY MUST is unmet; SHOULD/MAY are advisory. The work to judge is the ' +
        "card's bound artifact (card.binding.path) — open and inspect it; do not range beyond it."
      : 'Judge whether the item is ready to start this stage per the Definition of Ready above. MUST ' +
        'items are blocking — answer approve:false if ANY MUST is unmet; SHOULD/MAY are advisory. Base ' +
        'the judgment on the card (its description, acceptance criteria, refs) and any bound artifact.',
  };
}

function formatCriteria(stageId, section, criteria) {
  const kind = section === 'done' ? 'Done' : 'Ready';
  const lines = criteria.map((c) => `- ${c.text}  [${SEVERITY[c.severity]}]`);
  return `Definition of ${kind} for "${stageId}":\n${lines.join('\n')}`;
}

// The DoR/DoD criteria for a stage's section as [{severity, text}], from the inline manifest
// form (`stage.entry`/`exit` = [[severity, text], ...]) or, failing that, the agreement doc's
// Ready/Done. entry == ready (DoR), exit == done (DoD).
function stageCriteria(manifest, stageId, section, boardDir) {
  const inline = stageById(manifest, stageId)?.[section === 'done' ? 'exit' : 'entry'];
  if (Array.isArray(inline)) return inline.map(normalizeCriterion);
  const rel = stageAgreementPath(manifest, stageId);
  if (!rel) return [];
  const path = resolve(boardDir ?? '.', rel);
  if (!existsSync(path)) return [];
  return parseAgreement(readFileSync(path, 'utf8'))[section] ?? [];
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
  return {
    body: agreementBody(manifest, stageId, boardDir),
    ready: stageCriteria(manifest, stageId, 'ready', boardDir),
    done: stageCriteria(manifest, stageId, 'done', boardDir),
  };
}

function agreementBody(manifest, stageId, boardDir) {
  const rel = stageAgreementPath(manifest, stageId);
  if (!rel) return '';
  const path = resolve(boardDir ?? '.', rel);
  if (!existsSync(path)) return '';
  return parseAgreement(readFileSync(path, 'utf8')).body ?? '';
}

// Forward = the target stage sits later in the declared order than the source.
function isForward(manifest, from, to) {
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
