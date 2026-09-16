// The protocol's closed core — the only vocabulary the flow engine fixes. Single
// source of truth: the kernel, the projection, the operating guide, and the
// `kanbento schema` command all derive from this. Everything NOT named here is
// open (custom stage ids, card types, payload fields, policy keys). Small closed
// core, open everywhere else.

import { CORE_PATTERNS } from './collaborate.js';

export const ROLES = [
  { role: 'options', glyph: '○', meaning: 'uncommitted, discardable — the inbox / pool, left of the commitment point' },
  { role: 'commit', glyph: '◆', meaning: 'the commitment point; its entry gate is the Definition of Ready' },
  { role: 'active', glyph: '▶', meaning: 'committed work in progress' },
  { role: 'loop', glyph: '↻', meaning: 'a quality checkpoint (review / QA); rework re-dispatches in place — not a stage move' },
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
  out.push("               agreement: <ref|path>   # the doc form of entry/exit — a Ready(DoR)·Body·Done(DoD) markdown contract (use when a body/examples earn it); a criteria SOURCE for the stage's injected gate checklist, same as inline entry/exit — the dispatched specialist self-evaluates it (no independent evaluator)");
  out.push('  flows[]?:  { from, to, kind, trigger?, maxIterations? }   # ONLY non-forward edges (loop / skip)');
  out.push('  lanes[]?:  { axis, from?, name?, values? }    # orthogonal partition (swimlane), DERIVED from a card field (from) — a PROJECTION, display-side, no storage consequence; values? closes the set. The axis name "scope" is RESERVED (scope is a card field, not a lane) — scope swimlanes come from a lane that projects it, e.g. { axis: product, from: scope }');
  out.push("  scope?:    'apps/*' | ['apps/*', <name>…] | { <id>: <path|path[]> }    # product-scope vocabulary. DERIVED rung: each match of the pattern's final * segment that IS an existing directory is a scope (mkdir registers it; typos impossible); bare names declare directory-less (remote) scopes. ENUMERATED rung: a scope→paths map (keys = vocabulary; values = path grounding, string or list; empty list = directory-less); a map is exhaustive (unmapped dirs do not auto-register — lint names them) and cross-scope path overlap (including prefix) is a config error at resolve. Object discrimination: reserved keys pattern/patterns/declared keep the derived-rung object {pattern|patterns, declared}; any other object is the map; mixing reserved keys with map keys refuses. Impossible scope names: unscoped (null-queue filter sentinel), pattern, patterns, declared (derived-rung keys); node_modules never registers. Assignment: capture infers from cwd inside a scope root (overlapping roots within one scope or on the pattern rung: the deepest containing root wins), explicit --scope wins, existing cards assign/reassign/heal with kanbento scope <ref> [<s>], lint flags the underivable; a card carries at most ONE scope, a record zero-or-more via frontmatter scope: (zero = universal — records are never forced into scope folders). search --scope <s> is a STRICT filter (only pieces that explicitly carry <s>; drop the flag to search everything, including universal records). Storage: card docs MATERIALIZE on demand scope-major under the data/ zone — data/<scope>/cards/, with data/cards/ the visible unscoped queue (dirs appear on first use; docs bound before the declaration keep their stored paths — nothing moves retroactively). Scope is a card FIELD, not a lane (a lane is a projection — swimlanes by scope come from lanes[] with from: scope). NOT free tags (topic/recall stays with refs). Scope answers what this card changes (a subject with a system boundary); an initiative answers why — carry it with refs (advances=initiative:…), which also feeds lint inference. Directory-less scopes are for real boundaries without a local directory (a remote system), not cross-cutting intents. A scope whose FLOW diverges graduates to a nested board at <scope>/.kanbento");
  out.push('  types[]?:    { id, embodiment: folder|file|none, path?, marker?, status?, flow?, externalKey?, runnable? }   # capture materializes it; flow:false = a knowledge record, off the board — written by `note` (builtin: note → .kanbento/notes/{slug}.md, no declaration needed)');
  out.push('               runnable: true   # records of this type are durable process knowledge the runner serves — `do`/`--exec`/`--finalize` resolve + execute them (SKILL.md + params/artifacts/workspace/sandbox convention); `procedures` discovers across ALL runnable types (default: the `procedure` type ships runnable)');
  out.push('               externalKey: ["source","key"]   # an overlay constraint: instances must carry the natural key — capture REQUIRES --key (scoped by --source) — unique per board (best-effort); kanbento_id stays the primary key, and the natural key resolves to it (the sync/dedup seam). v1 supports only this compound — field pointers beyond the intake compound land later. Body-less: lives in the log, not in frontmatter');
  out.push('  relations[]?: { id, inverse?, symmetric?, range?, cardinality? }   # typed edges (a link is a reference-valued property). A READ+VALIDATE overlay on the stored forward edge: inverse/symmetric are derived at read; open by default, advisory when declared, reject undeclared only under strict');
  out.push('  relationVocabularies?: { <ns>: [{ id, inverse?, ... }] }   # namespaced relation sets -> dotted ids (epistemic.supports); the namespace is provenance, so vocabularies share without collision; a bare name resolves to its vocabulary when unambiguous');
  out.push(`  protocol?: { <pattern>: { agreement }, … }   # the COLLABORATE repertoire — a MAP keyed by pattern name (the games this board knows; core: ${CORE_PATTERNS.join(', ')}). OPEN + advisory like relationVocabularies — an unknown pattern key is allowed, only policies.protocol:strict rejects keys outside the core. Each entry's agreement refs the doc that declares the moves (roles/key/in-out adornments). Invocation picks the game (\`act --protocol <pattern>\`, or the sole entry); the opening move stamps the choice so each enactment is self-describing; enacted with \`act\`, projected with \`workspace\``);
  out.push('  cardSchema?: { core[], payload }             # invariant core + open payload (legacy: cardSchema.types name list)');
  out.push('  policies?: { wip, pull, ... }               # prose-first; codify a rule under pressure');
  out.push('  features?: { slugify?, ... }                # tool-behavior flags, not process policy (slugify: true -> heuristic slug at capture; default: id-led until the semantic slug lands)');
  out.push('  portfolio?: { type | types }                # which record type(s) are POSITIONS (standing bets) -> orient over their roots in views/PORTFOLIO.md, grouped by lifecycle status');
  out.push('');
  out.push('Open everywhere else: stage ids, card types, payload fields, policy keys.');
  out.push('A bare board is just `board` + one `options` stage; add facets as the flow earns them.');
  return out.join('\n');
}
