import { typeDef, vocabTerms } from './manifest.js';
import { refEdges, refTarget, relationDef, relationViolations, parseCurie, expandedRelations, resolveRelKey } from './refs.js';
import { recordScopes, scopeIds, unmappedShelfPaths, missingMappedPaths, expectedCardDocPath } from './scope.js';

// Read-time, advisory validation of the INSTANCE graph (records) against the schema
// and conventions — the A-Box check to compile's T-Box build. kanbento does not own
// the filesystem write path, so records cannot be gated at write; lint observes at
// read and SUGGESTS — never blocks, never writes. Pure over already-loaded
// { cards, records }; the CLI wires it to an exit code so anything external can gate.

// A status declared on a record but outside its type's codified vocabulary.
export function lintStatus(records, manifest) {
  const out = [];
  for (const r of records) {
    if (r.status == null) continue;
    const terms = vocabTerms(typeDef(manifest, r.type)?.status?.values);
    if (terms.length && !terms.includes(r.status))
      out.push({ kind: 'status', ref: r.curie ?? r.path, message: `status "${r.status}" not in ${terms.join('|')}` });
  }
  return out;
}

// One CURIE claimed by more than one record — a uniqueness violation within a type
// (nesting derives the parent from the folder, so the leaf slug must stay unique).
export function lintDuplicates(records) {
  const seen = new Map();
  for (const r of records) if (r.curie) (seen.get(r.curie) ?? seen.set(r.curie, []).get(r.curie)).push(r.path);
  return [...seen]
    .filter(([, paths]) => paths.length > 1)
    .map(([curie, paths]) => ({ kind: 'duplicate', ref: curie, message: `claimed by ${paths.length}: ${paths.join(', ')}` }));
}

// A declared ref that resolves to nothing — no record carries it and it is not a
// best-effort handle (none-embodiment). The per-source view of the frontier.
// `knownExtra`: CURIEs resolvable outside the board record index (package built-ins,
// harness skills — the same board ▸ harness ▸ built-in chain `do` uses). Without it,
// about procedure:replenish false-dangles on plans (story:lint-builtin-procedure-refs).
// Every spelling a card→card edge may have stored for this card (see storedRelTarget).
export function cardHandles(c) {
  return [c.id, c.slug, c.type && c.slug ? `${c.type}:${c.slug}` : null].filter(Boolean);
}

export function lintDangling({ cards = [], records = [] }, manifest, { exists, knownExtra } = {}) {
  const known = new Set(records.map((r) => r.curie).filter(Boolean));
  if (knownExtra) for (const c of knownExtra) if (c) known.add(c);
  // A card→card edge stores the target's handle at link time — `type:slug` when it
  // has one, else the bare slug or id (an untyped card has no CURIE). Those handles
  // resolve to cards, not records, so they are known here too — never a dangle.
  for (const c of cards) for (const h of cardHandles(c)) known.add(h);
  const out = [];
  const scan = (refs, srcRef) => {
    for (const e of refEdges(refs)) {
      if (known.has(e.curie)) continue;
      const t = refTarget(manifest, e.curie);
      if (t.type === 'file') { // path fallback: resolved by existence (fs injected; skipped when absent)
        if (exists && !exists(t.path)) out.push({ kind: 'dangling', ref: srcRef, message: `${e.rel} ${e.curie} — file not found` });
        continue;
      }
      if (t.known && t.embodiment === 'none') continue; // a handle, not a dangle
      out.push({ kind: 'dangling', ref: srcRef, message: `${e.rel} ${e.curie} resolves to no record${t.known ? '' : ' (unknown type)'}` });
    }
  };
  for (const r of records) scan(r.refs, r.curie ?? r.path);
  for (const c of cards) scan(c.refs, c.id);
  return out;
}

// A CURIE of another record named in prose but never declared under refs: — a likely
// missing edge (the graph cannot see prose; only the sweep's extractor would). The
// generalized form of "the concept link is not a link". Conservative: a known type,
// the target resolves to a real record, it is not the record's own curie, and it is
// not already declared.
export function lintProseEdges(records, manifest) {
  const known = new Set(records.map((r) => r.curie).filter(Boolean));
  const types = (manifest.types ?? []).map((t) => t.id).filter(Boolean);
  if (!types.length) return [];
  const re = new RegExp(`\\b(${types.join('|')}):([a-z0-9][a-z0-9-]*)\\b`, 'g');
  const out = [];
  for (const r of records) {
    if (!r.body) continue;
    const declared = new Set(refEdges(r.refs).map((e) => e.curie));
    const flagged = new Set();
    for (const m of r.body.matchAll(re)) {
      const curie = `${m[1]}:${m[2]}`;
      if (curie === r.curie || declared.has(curie) || flagged.has(curie) || !known.has(curie)) continue;
      flagged.add(curie);
      out.push({ kind: 'prose-edge', ref: r.curie ?? r.path, message: `names ${curie} in prose but does not declare it under refs:` });
    }
  }
  return out;
}

// Declared-relation violations: a typed edge whose target type is outside the relation's
// `range`, or that exceeds a `cardinality: one`. Advisory — only DECLARED relations are
// checked; undeclared relations are legitimately open (that is the progressive model), so
// they are not flagged here (strict mode rejects them at write instead).
export function lintRelations({ cards = [], records = [] }, manifest) {
  if (!expandedRelations(manifest).length) return []; // no vocabulary — fully open
  const out = [];
  const scan = (refs, srcRef) => {
    const counts = {};
    for (const e of refEdges(refs)) counts[e.rel] = (counts[e.rel] ?? 0) + 1;
    const flagged = new Set();
    for (const e of refEdges(refs)) {
      const def = relationDef(manifest, e.rel);
      if (!def) {
        // A flat key shadowing a vocabulary's local name predates the vocabulary (new
        // writes resolve to the dotted id) — nudge the migration, don't block it.
        try {
          const dotted = resolveRelKey(manifest, e.rel);
          if (dotted !== e.rel && !flagged.has(e.rel)) {
            flagged.add(e.rel);
            out.push({ kind: 'relation', ref: srcRef, message: `flat "${e.rel}" shadows ${dotted} — new writes resolve to the vocabulary; migrate this edge` });
          }
        } catch { /* ambiguous across vocabularies — the write path errors; lint stays quiet */ }
        continue; // undeclared is open — not a lint concern
      }
      const tt = parseCurie(e.curie)?.type;
      for (const v of relationViolations(def, { targetType: tt, total: counts[e.rel] })) {
        if (v.constraint === 'range') out.push({ kind: 'relation', ref: srcRef, message: `"${e.rel}" range is ${v.allowed.join('|')}, but ${e.curie} is "${tt}"` });
        if (v.constraint === 'cardinality' && !flagged.has(e.rel)) {
          flagged.add(e.rel);
          out.push({ kind: 'relation', ref: srcRef, message: `"${e.rel}" is cardinality one but has ${counts[e.rel]}` });
        }
      }
    }
  };
  for (const r of records) scan(r.refs, r.curie ?? r.path);
  for (const c of cards) scan(c.refs, c.id);
  return out;
}

// Knowledge-doc SHAPE decay — cheap structural signals for append-drift (note:append-drift),
// judged without reading for meaning. Three reads, no body parsing beyond a line count and a
// literal marker scan: the accretion count (appends-since-consolidation, folded from the log's
// `Elaborated` events and INJECTED as opts.accretion — lint stays pure, never reads the log
// itself), the body line count (past the 300 ceiling), and meta-narration markers (dated
// "Update:"/"Reframed ("/"Correction (" blocks a well-maintained record folds in rather than
// stacks). Advisory like every other check — it points at consolidation (`elaborate --replace`),
// never blocks.
export function lintShape(records, { accretion } = {}) {
  const markers = ['Reframed (', 'Update:', 'Update (', 'Correction ('];
  const out = [];
  for (const r of records) {
    const ref = r.curie ?? r.path;
    // (a) Accretion — appends 1–2 are covered by the point-of-action nudge; fire from 3.
    const n = accretion?.get(r.curie ?? r.path) ?? 0;
    if (n >= 3)
      out.push({ kind: 'shape', ref, message: `${n} appends accreted — consolidate into the section structure via elaborate --replace` });
    if (typeof r.body === 'string' && r.body.length) {
      // (b) Line count — one finding past the 300 ceiling; the message carries the 500 gradation.
      const lines = r.body.split('\n').length;
      if (lines > 300)
        out.push({ kind: 'shape', ref, message: `${lines} lines — past the 300-line ceiling; over 500 you are fighting your own config. Point at records rather than compress in place` });
      // (c) Meta-narration markers — a hit names the literal marker that matched.
      for (const m of markers)
        if (r.body.includes(m))
          out.push({ kind: 'shape', ref, message: `carries the "${m}" meta-narration marker — fold the append into the section it revises` });
    }
  }
  return out;
}

// Product scope — advisory, only when the board declares a scope vocabulary
// (`scopes` is the RESOLVED set the CLI injects). Card/record checks stay fs-free;
// map world-checks (shelf unmapped + missing path) run when `dir` is provided.
//   - a card/record scope outside the resolved vocabulary (the world moved — a dir
//     was renamed/removed; re-scope or mkdir);
//   - a live card whose scope is NEITHER declared NOR inferable — inferable = its
//     parent card carries one, or a referenced record converges on exactly one scope
//     (the relation-derived fallback, demoted to lint per the decision). The gap is
//     made visible so the unscoped queue is worked down, never silently ignored.
//   - integrity: a bound path that does not follow the scope template (the worklist
//     `kanbento scope <ref>` heals).
//   - a declared map: unmapped siblings on a shelf (≥2 mapped children) and a
//     mapped value path that is no longer a directory.
export function lintScope({ cards = [], records = [] }, { scopes, manifest, dir } = {}) {
  if (!scopes) return []; // undeclared — the axis is off, nothing to hold anyone to
  const ids = new Set(scopeIds(scopes));
  const out = [];
  // Records re-scope via frontmatter + sweep; cards use the dedicated verb.
  // Vocabulary is hoisted to a CLI header, not per-row.
  const asymmetry = 'records re-scope via frontmatter scope: + kanbento sweep; cards re-scope with kanbento scope <ref> [<s>]';
  const recScopes = new Map();
  for (const r of records) {
    const list = recordScopes(r.scope);
    if (r.curie) recScopes.set(r.curie, list);
    for (const s of list) {
      if (!ids.has(s)) out.push({ kind: 'scope', ref: r.curie ?? r.path, title: r.title ?? '', message: `scope "${s}" is not in the resolved vocabulary — ${asymmetry}` });
    }
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) {
    if (c.archived) continue; // frozen history — the queue nudge is for live work
    if (c.scope != null) {
      if (!ids.has(c.scope)) out.push({ kind: 'scope', ref: scopeCardRef(c), title: c.title ?? '', message: `scope "${c.scope}" is not in the resolved vocabulary — ${asymmetry}` });
    } else {
      const inferred = new Set();
      const parent = c.parent != null ? byId.get(c.parent) : null;
      if (parent?.scope != null) inferred.add(parent.scope);
      for (const e of refEdges(c.refs)) {
        const list = recScopes.get(e.curie);
        if (list && list.length === 1) inferred.add(list[0]);
      }
      if (inferred.size !== 1) {
        out.push({
          kind: 'scope',
          ref: scopeCardRef(c),
          title: c.title ?? '',
          message: `card has no scope and none is inferable — assign one with kanbento scope <ref> <s> or work it down from the unscoped queue; ${asymmetry}`,
        });
      }
    }
    if (manifest && c.binding?.path) {
      const want = expectedCardDocPath(manifest, c, c.scope ?? null);
      if (c.binding.path !== want) {
        out.push({
          kind: 'integrity',
          ref: scopeCardRef(c),
          title: c.title ?? '',
          message: `bound path ${c.binding.path} does not follow the scope template (${want}) — kanbento scope ${scopeCardRef(c)}`,
        });
      }
    }
  }
  if (dir && manifest) {
    for (const p of unmappedShelfPaths(manifest, dir)) {
      out.push({
        kind: 'scope',
        ref: 'manifest.scope',
        title: '',
        message: `unmapped directory ${p} — a declared map is exhaustive; add it to the scope map or remove the directory`,
      });
    }
    for (const { id, path } of missingMappedPaths(manifest, dir)) {
      out.push({
        kind: 'scope',
        ref: 'manifest.scope',
        title: '',
        message: `mapped path ${path} does not exist (scope "${id}") — restore the directory or remove it from the map`,
      });
    }
  }
  return out;
}

// The worklist names a card by its handle (slug@id), falling back to the short
// id when the slug has not landed yet — scope assignment is a judgement about
// the subject, so the row must carry it.
function scopeCardRef(c) {
  return c.slug ? `${c.slug}@${String(c.id).slice(0, 8)}` : String(c.id).slice(0, 8);
}

// A bound-doc file whose kanbento_id no live card (archived included) answers —
// the file-side of dangling. Merge leftovers land here; live and archived docs do not.
export function lintOrphanDocs(docs = [], cards = []) {
  const live = new Set(cards.map((c) => c.id).filter(Boolean));
  const out = [];
  for (const d of docs) {
    if (!d?.identity || live.has(d.identity)) continue;
    out.push({
      kind: 'dangling',
      ref: d.path,
      message: `kanbento_id ${d.identity} resolves to no card — a merge leftover; delete the file or fold its body into the survivor`,
    });
  }
  return out;
}

// The full advisory pass: every check, one finding list.
export function lintRecords({ cards = [], records = [] }, manifest, { exists, knownExtra, accretion, scopes, dir, boundDocs } = {}) {
  const findings = [
    ...lintStatus(records, manifest),
    ...lintDuplicates(records),
    ...lintDangling({ cards, records }, manifest, { exists, knownExtra }),
    ...lintOrphanDocs(boundDocs, cards),
    ...lintProseEdges(records, manifest),
    ...lintRelations({ cards, records }, manifest),
    ...lintShape(records, { accretion }),
    ...lintScope({ cards, records }, { scopes, manifest, dir }),
  ];
  return { findings, ok: findings.length === 0 };
}
