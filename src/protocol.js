// The protocol's closed core — the only vocabulary the flow engine fixes. Single
// source of truth: the kernel, the projection, the operating guide, and the
// `kanbento schema` command all derive from this. Everything NOT named here is
// open (custom stage ids, card types, payload fields, policy keys). Small closed
// core, open everywhere else.

export const ROLES = [
  { role: 'options', glyph: '○', meaning: 'uncommitted, discardable — the inbox / pool, left of the commitment point' },
  { role: 'commit', glyph: '◆', meaning: 'the commitment point; its entry gate is the Definition of Ready' },
  { role: 'active', glyph: '▶', meaning: 'committed work in progress' },
  { role: 'loop', glyph: '↻', meaning: 'a checkpoint with a feedback edge back (review / QA)' },
  { role: 'done', glyph: '✓', meaning: 'the delivery point (terminal); its entry gate is the Definition of Done' },
];

export const FLOW_KINDS = ['forward', 'loop', 'skip']; // forward is implicit (stage order)
export const ENFORCEMENT = ['advisory', 'strict'];

// Archival dispositions — the DERIVED, invariant meaning of freezing a card at a
// terminal. `archive <card> <stage>` names the stage to freeze at (the intent); the
// disposition is computed from that stage's role, framed by the commitment point:
// an uncommitted option is DISCARDED (triage), committed work ABANDONED (spillage),
// a card that reached done DELIVERED (throughput). Reaching the stage is a real,
// GATED transition — so a well-defined process cannot be circumvented (no freezing
// as `delivered` at `done` without passing its gate). The disposition is then frozen
// ON the card as an INVARIANT: stage ids get renamed/removed over time, but this
// semantic (and the throughput / spillage / discard-rate it feeds) must not drift.
export const DISPOSITIONS = [
  { disposition: 'discarded', roles: ['options'], meaning: 'dropped from the pool before commit — triage' },
  { disposition: 'abandoned', roles: ['commit', 'active', 'loop'], meaning: 'committed work stopped before done — spillage' },
  { disposition: 'delivered', roles: ['done'], meaning: 'reached a done terminal (gated) — throughput' },
];

export const GLYPH = Object.fromEntries(ROLES.map((r) => [r.role, r.glyph]));
export const ROLE_MEANING = Object.fromEntries(ROLES.map((r) => [r.role, r.meaning]));
export const ROLE_SET = new Set(ROLES.map((r) => r.role));

// The disposition a card frozen at a given role carries (1:1 with the commit-framed
// zones). null for an unknown role — a stage with no role has no disposition.
export function dispositionForRole(role) {
  return DISPOSITIONS.find((d) => d.roles.includes(role))?.disposition ?? null;
}

// The authoritative grammar an agent reads before editing a manifest
// (`kanbento schema`). The closed enums come straight from the constants above,
// so they cannot drift; the skeleton names the facets and marks what is open.
export function renderSchema() {
  const out = [];
  out.push('kanbento manifest — the closed core (the only fixed vocabulary; everything else is open)');
  out.push('');
  out.push('stage roles  (stages[].role):');
  for (const r of ROLES) out.push(`  ${r.glyph} ${r.role.padEnd(8)} ${r.meaning}`);
  out.push('');
  out.push(`flow kinds   (flows[].kind):   ${FLOW_KINDS.join(' · ')}   — forward is implicit (stage order)`);
  out.push(`enforcement  (gates/policies): ${ENFORCEMENT.join(' · ')}`);
  out.push('');
  out.push('archive dispositions  (archive <card> <stage>):   freeze at a stage (gated); disposition is derived from its role + frozen as an invariant');
  for (const d of DISPOSITIONS) out.push(`  ${d.disposition.padEnd(9)} ${d.meaning}  (role: ${d.roles.join('/')})`);
  out.push('');
  out.push('skeleton (JSON or YAML; ? = optional):');
  out.push('  manifestVersion: "1.0"');
  out.push('  board:     { id, name, revision }');
  out.push('  inbox?:    { sources[], landing: <stageId> }   # the entry boundary');
  out.push('  stages[]:  { id, role, wip?, entry?, exit?, procedure?, agreement? }   # ordered — forward flow is implied by order');
  out.push('               entry/exit: [ [MUST|SHOULD|MAY, "<criterion>"], ... ]   # inline DoR/DoD — RFC 2119 criteria, judged independently (entry on the way in, exit on the forward way out). Only an explicit MUST blocks; a keyword-less criterion is open for interpretation, not enforced. WIP capacity is the one computed gate, enforced inline on every transition');
  out.push("               procedure: <ref|path>   # the stage's execution instructions (may compose several steps — not 1:1 with one action); transition/commit surface its resolved path on entry");
  out.push("               agreement: <ref|path>   # the doc form of entry/exit — a Ready(DoR)·Body·Done(DoD) markdown contract (use when a body/examples earn it); judged the same way. claude -p by default; agreementEvaluator overrides");
  out.push('  flows[]?:  { from, to, kind, trigger?, maxIterations? }   # ONLY non-forward edges (loop / skip)');
  out.push('  lanes[]?:  { axis, from?, name?, values? }    # orthogonal partition (swimlane), DERIVED from a card field (from); values? closes the set');
  out.push('  types[]?:    { id, embodiment: folder|file|none, path?, marker?, status?, flow? }   # capture materializes it; flow:false = a knowledge record, off the board — written by `note` (builtin: note → .kanbento/notes/{slug}.md, no declaration needed)');
  out.push('  relations[]?: { id, inverse?, symmetric?, range?, cardinality? }   # typed edges (a link is a reference-valued property). A READ+VALIDATE overlay on the stored forward edge: inverse/symmetric are derived at read; open by default, advisory when declared, reject undeclared only under strict');
  out.push('  relationVocabularies?: { <ns>: [{ id, inverse?, ... }] }   # namespaced relation sets -> dotted ids (epistemic.supports); the namespace is provenance, so vocabularies share without collision; a bare name resolves to its vocabulary when unambiguous');
  out.push('  cardSchema?: { core[], payload }             # invariant core + open payload (legacy: cardSchema.types name list)');
  out.push('  policies?: { wip, pull, ... }               # prose-first; codify a rule under pressure');
  out.push('  features?: { slugify?, ... }                # tool-behavior flags, not process policy (slugify: true -> heuristic slug at capture; default: id-led until the semantic slug lands)');
  out.push('  portfolio?: { type | types }                # which record type(s) are POSITIONS (standing bets) -> orient over their roots in views/PORTFOLIO.md, grouped by lifecycle status');
  out.push('');
  out.push('Open everywhere else: stage ids, card types, payload fields, policy keys.');
  out.push('A bare board is just `board` + one `options` stage; add facets as the flow earns them.');
  return out.join('\n');
}
