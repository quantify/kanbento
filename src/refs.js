import { typeDef, stageById } from './manifest.js';

// Typed references between cards/records, as CURIEs — compact `type:slug` ids —
// stored under a node's `payload.refs` map (`{ about: [...], implements: [...] }`).
// This is the pure graph layer: parse + resolve a CURIE, list a node's edges,
// invert them (backlinks), and walk a neighborhood. The fs scan that loads record
// files lives in binding.js (indexRecords); the CLI wires the two together. Edges
// are resolved at READ — nothing here is enforced at write (progressive fidelity).

// A CURIE is `type:slug`. Split on the FIRST colon, so a slug may itself contain
// colons (`spec:auth:v2` -> type `spec`, slug `auth:v2`). Both sides required.
export function parseCurie(s) {
  if (typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const type = s.slice(0, i).trim();
  const slug = s.slice(i + 1).trim();
  return type && slug ? { type, slug } : null;
}

// Resolve a CURIE to where its record lives — the type's embodiment `path` with
// {slug} filled in. PURE (no fs): the caller checks existence. `known` is false for
// an undeclared type; `path` is null for a none-embodiment/unknown type; `templated`
// is true when a non-{slug} (lane) token remains, so the CURIE alone can't name one
// concrete file.
export function refTarget(manifest, curie) {
  const parsed = parseCurie(curie);
  const base = { curie, type: parsed?.type ?? null, slug: parsed?.slug ?? null, embodiment: null, known: false, path: null, templated: false, nested: false, fragment: null };
  if (!parsed) return base;
  if (parsed.type === 'file') {
    // the universal fallback: a raw path (+ optional #fragment) for files that are NOT
    // typed records (a frontmatterless doc). Fragile — the path can move — but resolved
    // by existence and caught by lint. Upgrade to a typed CURIE once the type is earned.
    const hash = parsed.slug.indexOf('#');
    const path = hash >= 0 ? parsed.slug.slice(0, hash) : parsed.slug;
    return { ...base, embodiment: 'file', known: true, path, fragment: hash >= 0 ? parsed.slug.slice(hash + 1) : null };
  }
  const def = typeDef(manifest, parsed.type);
  if (!def) return base;
  const embodiment = def.embodiment ?? 'none';
  if (!def.path || embodiment === 'none') return { ...base, embodiment, known: true };
  if (def.nested) return { ...base, embodiment, known: true, nested: true }; // file lives anywhere under the root — resolved by the index scan, not a computed path
  const path = def.path.replace('{slug}', parsed.slug);
  return { ...base, embodiment, known: true, path, templated: /\{[^}]+\}/.test(path) };
}

// The (relative) path of a stage's declared `procedure` artifact, or null. The ref is
// a CURIE (file: or typed) or a literal path — the stored, portable form; resolving it
// to an absolute path for an agent to open is the caller's delivery concern.
export function stageProcedurePath(manifest, stageId) {
  const ref = stageById(manifest, stageId)?.procedure;
  if (!ref) return null;
  return parseCurie(ref) ? refTarget(manifest, ref).path : ref;
}

// The (relative) path of a stage's declared `agreement` artifact, or null — same
// resolution as a procedure (CURIE or literal path). The agreement is the fuller form:
// a Ready·Body·Done contract whose body is the procedure.
export function stageAgreementPath(manifest, stageId) {
  const ref = stageById(manifest, stageId)?.agreement;
  if (!ref) return null;
  return parseCurie(ref) ? refTarget(manifest, ref).path : ref;
}

// Normalize a refs map into a flat edge list [{ rel, curie }]. Tolerates a string
// or string[] per relation; optional `rel` filter; stable (key-sorted) order.
export function refEdges(refsMap, { rel } = {}) {
  if (!refsMap || typeof refsMap !== 'object') return [];
  const out = [];
  for (const key of Object.keys(refsMap).sort()) {
    if (rel && key !== rel) continue;
    const v = refsMap[key];
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    for (const curie of list) if (typeof curie === 'string' && curie) out.push({ rel: key, curie });
  }
  return out;
}

// A declared relation: manifest.relations[] = [{ id, inverse?, symmetric?, range?, cardinality? }],
// plus namespaced vocabularies — manifest.relationVocabularies = { epistemic: [{ id: 'supports',
// inverse: 'supported-by' }, ...] } — whose entries expand to dotted ids (epistemic.supports,
// inverse epistemic.supported-by). The namespace is provenance: a board-local `extends`, an
// installed vocabulary's, and a peer's stay distinguishable, so vocabularies are shareable
// without collision. Typed links remain a READ + VALIDATE overlay — the stored forward edge
// (payload.refs[rel]) is the single source of truth; declaring adds interpretation, never storage.
export function expandedRelations(manifest) {
  const flat = manifest?.relations ?? [];
  const vocabs = manifest?.relationVocabularies ?? {};
  const expanded = Object.entries(vocabs).flatMap(([ns, defs]) =>
    (defs ?? []).map((d) => ({ ...d, id: `${ns}.${d.id}`, ...(d.inverse ? { inverse: `${ns}.${d.inverse}` } : {}), ns })),
  );
  return [...flat, ...expanded];
}

export function relationDef(manifest, id) {
  return expandedRelations(manifest).find((r) => r.id === id) ?? null;
}

// Write-time sugar for namespaced keys: a bare local name resolves to its vocabulary's
// dotted id when exactly ONE vocabulary declares it — two candidates is an error naming
// both, so a stored key is never ambiguous. A dotted key, a flat-declared key, or an
// undeclared key (open vocabulary) passes through unchanged. Files always carry the
// full key; only the CLI gets to be casual.
export function resolveRelKey(manifest, key) {
  if (!manifest || key.includes('.')) return key;
  if ((manifest.relations ?? []).some((r) => r.id === key)) return key; // board-local wins
  const candidates = Object.entries(manifest.relationVocabularies ?? {})
    .filter(([, defs]) => (defs ?? []).some((d) => d.id === key))
    .map(([ns]) => `${ns}.${key}`);
  if (candidates.length > 1) throw new Error(`refs: "${key}" is ambiguous — declared by ${candidates.join(' and ')}; use the dotted form`);
  return candidates[0] ?? key;
}

// How an INCOMING edge labeled `rel` reads at its target, using declared semantics. The
// reverse is DERIVED here at read, never stored:
//   symmetric        -> the same relation, both ways        (↔ sibling)
//   declared inverse -> the inverse's name                  (→ blocked-by, for an incoming `blocks`)
//   is some rel's inverse -> that relation's name           (→ blocks, for an incoming `blocked-by`)
//   otherwise        -> a plain, un-named backlink          (← rel)
export function presentIncoming(manifest, rel) {
  const defs = expandedRelations(manifest);
  const d = defs.find((r) => r.id === rel);
  if (d?.symmetric) return { glyph: '↔', label: rel, derived: true };
  if (d?.inverse) return { glyph: '→', label: d.inverse, derived: true };
  const asInverse = defs.find((r) => r.inverse === rel);
  if (asInverse) return { glyph: '→', label: asInverse.id, derived: true };
  return { glyph: '←', label: rel, derived: false };
}

// Is the relation vocabulary closed? Advisory by default (open — any relation works);
// `policies.relations: strict` closes it, so undeclared relations and range/cardinality
// violations are rejected at write. The advisory→strict dial, applied to edges.
export function relationsStrict(manifest) {
  return (manifest?.policies?.relations ?? 'advisory') === 'strict';
}

// The one place the relation constraints live. Judges a single edge (rel -> targetType)
// against a declared def, given the TOTAL edges the source would hold for that rel.
// Returns structured violations; the strict write gate and the advisory lint both render
// from it, so the two enforcement modes cannot drift.
export function relationViolations(def, { targetType, total = 0 } = {}) {
  const out = [];
  if (def.range && targetType && !def.range.includes(targetType)) out.push({ constraint: 'range', allowed: def.range });
  if (def.cardinality === 'one' && total > 1) out.push({ constraint: 'cardinality' });
  return out;
}

// The strict-mode write check for one edge (rel -> targetType), given how many edges the
// source already has for that rel. Returns an error string, or null if allowed. A no-op
// unless strict — advisory validation is lint's job (read-time), this one blocks the write.
export function checkRelationStrict(manifest, rel, targetType, existingCount = 0) {
  if (!relationsStrict(manifest)) return null;
  const def = relationDef(manifest, rel);
  if (!def) return `relation "${rel}" is not declared (strict vocabulary)`;
  for (const v of relationViolations(def, { targetType, total: existingCount + 1 })) {
    if (v.constraint === 'range') return `relation "${rel}" range is ${v.allowed.join('|')}, not "${targetType}"`;
    if (v.constraint === 'cardinality') return `relation "${rel}" is cardinality one — already set`;
  }
  return null;
}

// Build a payload.refs map from --rel pairs. A pair splits on the FIRST `=`
// when present (about=note:core-design — aligns with --lane and keeps the
// CURIE's colons intact), else on the FIRST colon (about:note:core-design, the
// original form). The relation key is open vocabulary — no key is privileged.
// Throws on a malformed CURIE, so capture fails loudly rather than storing a
// dangling string — with a hint when the pair was likely a bare CURIE missing
// its relation key.
export function refsFromArgs(relPairs) {
  const refs = {};
  for (const p of relPairs ?? []) {
    const str = String(p);
    const eq = str.indexOf('=');
    const i = eq > 0 ? eq : str.indexOf(':');
    // A --rel token must carry a key<sep>value shape. A bare word here almost always
    // means the variadic --rel swallowed a following positional token — name it and
    // teach the fix rather than blaming a "malformed CURIE".
    if (i <= 0) throw new Error(`refs: --rel "${p}" is not a key=type:slug pair (e.g. advances=capability:x · evidence=strategy:y · about=note:z) — --rel is variadic and likely swallowed following text; put positional text before --rel, or pass --rel last`);
    const rel = str.slice(0, i).trim();
    const curie = str.slice(i + 1).trim();
    if (!parseCurie(curie)) {
      const hint = !curie.includes(':') && parseCurie(`${rel}:${curie}`)
        ? ` — if "${rel}:${curie}" is the CURIE, it needs a relation key first: <key>=${rel}:${curie}`
        : '';
      throw new Error(`refs: "${curie}" is not a type:slug reference${hint}`);
    }
    (refs[rel] ??= []).push(curie);
  }
  return Object.keys(refs).length ? refs : undefined;
}

// Invert edges: every source (card or record) that points AT `targetCurie`, grouped
// by relation. PURE over already-loaded { cards, records } (each carrying `refs`).
// Dedupe: a born-tracked flow card appears both in the store and as a file — drop the
// record whose identity matches a card's id/identity (the card wins; pure-knowledge
// records, never on the board, survive as the only source for their edges).
export function collectBacklinks({ cards = [], records = [] }, targetCurie, { rel, type } = {}) {
  const cardIdentities = new Set();
  for (const c of cards) { cardIdentities.add(c.id); if (c.identity) cardIdentities.add(c.identity); }
  const groups = new Map();
  let total = 0;
  const consider = (src) => {
    if (type && src.type !== type) return;
    const seen = new Set();
    for (const e of refEdges(src.refs, { rel })) {
      if (e.curie !== targetCurie || seen.has(e.rel)) continue;
      seen.add(e.rel);
      (groups.get(e.rel) ?? groups.set(e.rel, []).get(e.rel)).push({ kind: src.kind, ref: src.ref, title: src.title, type: src.type, state: src.state });
      total++;
    }
  };
  for (const c of cards) consider({ kind: 'card', ref: c.id, title: c.title, type: c.type, state: c.state, refs: c.refs });
  for (const r of records) {
    if (cardIdentities.has(r.identity)) continue;
    consider({ kind: 'record', ref: r.path, title: r.title, type: r.type, state: r.status, refs: r.refs }); // a record's "state" is its status
  }
  const out = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([r, sources]) => ({ rel: r, sources }));
  return { groups: out, total };
}

// The frontier: CURIEs that are referenced but resolve to no record yet — the
// emergent entities open extraction has proposed, ranked by how many sources point
// at them. A high count is a promotion candidate ("worth a record of its own").
// PURE: "resolved" = some record carries that curie; everything else referenced is
// frontier. Recurrence here is what turns a dangling guess into an established node.
export function collectFrontier({ cards = [], records = [] }) {
  const have = new Set(records.map((r) => r.curie).filter(Boolean));
  const count = new Map();
  for (const src of [...cards, ...records]) {
    for (const e of refEdges(src.refs)) {
      if (have.has(e.curie)) continue;
      count.set(e.curie, (count.get(e.curie) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .map(([curie, refs]) => ({ curie, refs }))
    .sort((a, b) => b.refs - a.refs || (a.curie < b.curie ? -1 : 1));
}

// A node's outgoing edges, each resolved to a target descriptor. PURE — fs existence
// is added by the caller.
export function forwardEdges(manifest, refsMap, { rel, type } = {}) {
  const out = [];
  for (const e of refEdges(refsMap, { rel })) {
    const target = refTarget(manifest, e.curie);
    if (type && target.type !== type) continue;
    out.push({ rel: e.rel, curie: e.curie, target });
  }
  return out;
}

// Walk the graph around a CURIE, both directions, to `depth`. Builds adjacency once
// from every source's edges (a node key is a record's CURIE or a card's id), then
// BFS over forward (key -> targets) and inverted (targetCurie -> sources) edges.
// PURE. Returns { start, nodes, edges, label } for the caller to render.
export function neighborhood({ cards = [], records = [] }, manifest, startCurie, { depth = 2, rel } = {}) {
  const fwd = new Map(); // key -> [{rel, curie}]
  const inv = new Map(); // targetCurie -> [{key, rel}]
  const label = new Map(); // key -> {kind, title, type}
  const addNode = (key, meta, refs) => {
    if (!key) return;
    label.set(key, meta);
    const edges = refEdges(refs, { rel });
    fwd.set(key, edges);
    for (const e of edges) (inv.get(e.curie) ?? inv.set(e.curie, []).get(e.curie)).push({ key, rel: e.rel });
  };
  for (const c of cards) addNode(c.id, { kind: 'card', title: c.title, type: c.type }, c.refs);
  for (const r of records) addNode(r.curie, { kind: 'record', title: r.title, type: r.type }, r.refs);

  const visited = new Set([startCurie]);
  const edges = [];
  let frontier = [startCurie];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const node of frontier) {
      for (const e of fwd.get(node) ?? []) {
        edges.push({ from: node, rel: e.rel, to: e.curie });
        if (!visited.has(e.curie)) { visited.add(e.curie); next.push(e.curie); }
      }
      for (const s of inv.get(node) ?? []) {
        edges.push({ from: s.key, rel: s.rel, to: node });
        if (!visited.has(s.key)) { visited.add(s.key); next.push(s.key); }
      }
    }
    frontier = next;
  }
  return { start: startCurie, nodes: [...visited], edges, label };
}
