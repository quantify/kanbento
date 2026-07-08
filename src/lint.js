import { typeDef, vocabTerms } from './manifest.js';
import { refEdges, refTarget, relationDef, relationViolations, parseCurie, expandedRelations, resolveRelKey } from './refs.js';

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
export function lintDangling({ cards = [], records = [] }, manifest, { exists } = {}) {
  const known = new Set(records.map((r) => r.curie).filter(Boolean));
  const out = [];
  const scan = (refs, srcRef) => {
    for (const e of refEdges(refs)) {
      const t = refTarget(manifest, e.curie);
      if (t.type === 'file') { // path fallback: resolved by existence (fs injected; skipped when absent)
        if (exists && !exists(t.path)) out.push({ kind: 'dangling', ref: srcRef, message: `${e.rel} ${e.curie} — file not found` });
        continue;
      }
      if (known.has(e.curie)) continue;
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

// The full advisory pass: every check, one finding list.
export function lintRecords({ cards = [], records = [] }, manifest, { exists } = {}) {
  const findings = [
    ...lintStatus(records, manifest),
    ...lintDuplicates(records),
    ...lintDangling({ cards, records }, manifest, { exists }),
    ...lintProseEdges(records, manifest),
    ...lintRelations({ cards, records }, manifest),
  ];
  return { findings, ok: findings.length === 0 };
}
