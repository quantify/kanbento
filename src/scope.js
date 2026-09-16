import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';

// Product scope — the ownership axis (missing-product-scope@b0d92d0d, note:scope-segregation).
// Two declaration rungs. DERIVED: the manifest names a pattern (`scope: apps/*`) and
// the vocabulary is whatever the glob matches AT READ TIME — closed by the world
// (`mkdir apps/gate` IS the registration). ENUMERATED: a scope→paths map names the
// products when product ≠ directory (`bridge` = apps/bridge + apps/cli + apps/gitbridge);
// closed by config, verified against the world (lint flags a value path that no
// longer exists; a missing path does not drop the id). A map is exhaustive —
// unmapped dirs do not auto-register. Cross-scope path overlap (including prefix)
// is a config error at resolve; deepest-wins stays within one scope's roots or
// on the pattern rung.
// ASSIGNMENT is inferred (cwd at capture crosses a scope root — every mapped path
// is a root), the explicit `--scope` override wins, and lint surfaces the underivable
// — a card resolves to at most one scope; a record carries zero-or-more via
// frontmatter (zero = universal).
// STORAGE is centralized scope-major: on a scope-declaring board, card docs live under
// the single dynamic zone `data/<scope>/cards/…`, with `data/cards/` as the visible
// unscoped queue (records never ride the folders — their scope is frontmatter).

const DERIVED_OBJECT_KEYS = new Set(['pattern', 'patterns', 'declared']);
const RESERVED_SCOPE_IDS = new Set(['unscoped', 'pattern', 'patterns', 'declared']);

// The declaration, normalized — or null when the board declares no scope (the
// whole axis is then inert; nothing changes). Accepted forms (progressive):
//   scope: 'apps/*'                            — one pattern (derived)
//   scope: ['apps/*', 'remote-x']              — patterns + directory-less names
//   scope: { pattern: 'apps/*', declared: [] } — the explicit derived-rung object
//   scope: { bridge: ['apps/bridge', 'apps/cli'], forge: 'apps/forge', x: [] }
//                                            — scope→paths map (enumerated)
// Object discrimination: reserved keys pattern/patterns/declared keep the
// derived-rung object; any other object is the map. Mixing refuses loudly.
export function scopeDecl(manifest) {
  const s = manifest?.scope;
  if (s == null) return null;
  const out = { patterns: [], declared: [] };
  const take = (entry) => {
    const str = String(entry).trim();
    if (!str) return;
    if (str.includes('*')) out.patterns.push(str);
    else out.declared.push(str);
  };
  if (typeof s === 'string') take(s);
  else if (Array.isArray(s)) s.forEach(take);
  else if (typeof s === 'object') {
    const keys = Object.keys(s);
    const reserved = keys.filter((k) => DERIVED_OBJECT_KEYS.has(k));
    const other = keys.filter((k) => !DERIVED_OBJECT_KEYS.has(k));
    if (reserved.length && other.length) {
      throw new Error(
        `scope: object mixes reserved keys (${reserved.join(', ')}) with map keys (${other.join(', ')}) — use either {pattern|patterns, declared} or a scope→paths map, not both`,
      );
    }
    if (other.length) {
      const map = {};
      for (const id of other.sort()) {
        assertSafeScopeId(id);
        map[id] = asMappedPaths(id, s[id]);
      }
      return { map };
    }
    for (const p of s.pattern ? [s.pattern] : s.patterns ?? []) take(p);
    for (const d of s.declared ?? []) out.declared.push(String(d).trim());
  }
  return out.patterns.length || out.declared.length ? out : null;
}

// A scope id becomes a path segment under data/ — reject anything unsafe loudly
// (pattern-derived ids are single dir names by construction; this guards declared
// entries, map keys, and any programmatic caller). Returns the id for chaining.
export function assertSafeScopeId(id) {
  const s = String(id ?? '');
  if (!s || /[/\\]/.test(s) || s.includes('..') || s.startsWith('.') || s.length > 128) {
    throw new Error(`scope "${s}" is unsafe — no path separators, "..", leading ".", or over 128 chars`);
  }
  if (s === 'unscoped') {
    throw new Error('scope "unscoped" is reserved — it is the filter sentinel for the null queue (pool/search --scope unscoped) and cannot name a real scope');
  }
  if (RESERVED_SCOPE_IDS.has(s)) {
    throw new Error(`scope "${s}" is reserved — "pattern", "patterns", and "declared" name the derived-rung object keys and cannot name a real scope`);
  }
  return s;
}

// Names a pattern match may never register as a scope: the reserved filter sentinel
// (a dir named `unscoped` would be unreachable through `--scope unscoped`), the
// derived-rung object keys (a dir named `pattern` must not become a scope), and
// well-known junk that a root-level `*` pattern would otherwise sweep in. Skipped,
// not errored — the world changing (npm install) must not brick every verb.
const NEVER_A_SCOPE = new Set(['unscoped', 'node_modules', 'pattern', 'patterns', 'declared']);

// Enumerate the vocabulary at read time.
// Derived rung — v1 pattern grammar: a relative path whose FINAL segment is a
// bare `*` (`apps/*`); the wildcard segment names the scope. Each match must be
// an existing directory (closed by the world); hidden dirs are skipped. Declared
// entries ride along with no directory.
// Enumerated rung — each map key is a scope; each value path is a root (a missing
// path still registers the id — lint flags it). Empty list = directory-less.
// Cross-scope overlap (exact or prefix) throws; within one scope, nested roots
// stay (deepest-wins at inference).
// Returns [{ id, dir }] (dir relative to the board root, null for directory-less).
// A map scope with N paths yields N entries sharing the id. Id-sorted; a declared
// id that also matches a pattern keeps its dir.
export function resolveScopes(manifest, dir) {
  const decl = scopeDecl(manifest);
  if (!decl) return null; // undeclared — the axis is off
  if (decl.map) return resolveScopeMap(decl.map);
  const byId = new Map();
  for (const pattern of decl.patterns) {
    for (const hit of matchScopePattern(pattern, dir)) byId.set(hit.id, hit);
  }
  for (const id of decl.declared) {
    assertSafeScopeId(id);
    if (!byId.has(id)) byId.set(id, { id, dir: null });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// The vocabulary as ids — for error messages and membership checks.
// A map scope with several roots appears once.
export function scopeIds(scopes) {
  const out = [];
  const seen = new Set();
  for (const s of scopes ?? []) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  return out;
}

// Validate an explicit scope value against the resolved vocabulary — closed by the
// world, so an unknown value is refused loudly, naming the set (teaching error).
export function assertScope(scopes, id, verb = 'scope') {
  if (!scopes.some((s) => s.id === id)) {
    const ids = scopeIds(scopes);
    throw new Error(
      `${verb}: scope "${id}" is not in the board's vocabulary${ids.length ? ` [${ids.join(', ')}]` : ' (none resolve yet)'} — a scope must resolve to an existing directory matching the manifest's scope pattern (mkdir registers it), or be a declared entry`,
    );
  }
  return id;
}

// Infer the scope a path sits in: the path (a cwd at capture) crossed a scope ROOT
// on its way down from the board dir. Exact membership — the scope's dir itself or
// anything under it. A map scope contributes every mapped path as a root. Overlapping
// roots within one scope or on the pattern rung (apps/* + apps/gate/sub/*): the MOST
// SPECIFIC (deepest) containing root wins. null when outside every scope root
// (the unscoped queue) — an unmapped dir infers nothing.
export function inferScopeFromPath(scopes, boardDir, path) {
  if (!scopes || !path) return null;
  let best = null;
  for (const s of scopes) {
    if (!s.dir) continue; // directory-less declared entry — nothing to be inside of
    const root = resolve(boardDir, s.dir);
    const rel = relative(root, resolve(path));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      if (!best || root.length > best.root.length) best = { id: s.id, root };
    }
  }
  return best?.id ?? null;
}

// A card's resolved scope — at most one, read off the card data (`--scope` and
// the cwd inference both land it at payload.scope; the legacy lane namespace rides
// along for cards stored before the dedicated flag). null = unscoped (a visible
// queue to work down, not a missing attribute).
export function cardScope(card) {
  const v = card?.payload?.scope ?? card?.lane?.scope;
  return v == null || v === '' ? null : String(v);
}

// A record's scopes — zero-or-more from its frontmatter `scope:` (string or list),
// where ZERO means UNIVERSAL, not unclassified. Records are never forced into scope
// folders; the frontmatter is the whole story.
export function recordScopes(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((s) => String(s).trim()).filter(Boolean);
}

// Where a card's bound doc materializes — the storage rule, as a {slug} template:
//   board declares no scope  →  .kanbento/cards/{slug}.md            (unchanged)
//   scoped card              →  .kanbento/data/<scope>/cards/{slug}.md
//   unscoped card            →  .kanbento/data/cards/{slug}.md       (the visible unscoped queue)
// Scope-major co-location: `ls data/<scope>/` is a product's working set; `data/` is
// the sole dynamic zone. `kanbento scope` is the mover: assign/reassign/heal all
// place the bound doc at this template (legacy pre-declaration bindings stay put
// until the verb runs).
export function cardDocTemplate(manifest, scope) {
  if (!scopeDecl(manifest)) return '.kanbento/cards/{slug}.md';
  if (scope == null) return '.kanbento/data/cards/{slug}.md';
  return `.kanbento/data/${assertSafeScopeId(scope)}/cards/{slug}.md`;
}

// The path the bound doc should occupy for `scope` — template directory + the
// current basename (placement follows scope; the filename is reslug's job).
// A headless card (no binding) names the file from the slug, same as ensureCardDoc.
export function expectedCardDocPath(manifest, card, scope) {
  const tmpl = cardDocTemplate(manifest, scope);
  const slug = card?.slug ?? String(card?.id ?? '').slice(0, 8);
  const name = card?.binding?.path
    ? card.binding.path.slice(card.binding.path.lastIndexOf('/') + 1)
    : `${slug}.md`;
  return tmpl.replace(/\{slug\}\.md$/, name);
}

// The one-line chip a scope wears on pool/search rows — `@<scope>` ("at gate").
export function scopeChip(scope) {
  return scope ? `@${scope}` : '';
}

// Does a piece pass a `--scope <id>` narrow? STRICT: only pieces that explicitly
// carry `<id>` survive — a card matches only its own scope (at most one); a
// record matches when its frontmatter list includes the id. Universal records
// (no scopes) apply everywhere when the flag is omitted, not inside a filter.
// The reserved literal `unscoped` selects the null QUEUE: cards with no scope —
// and no records, because a record without scopes is universal, never
// unclassified (the queue is a card concept).
export function matchesScope(kind, scopeOrScopes, id) {
  // '' counts as null: the search index stores a missing scope as an empty string
  // (extractField coerces), and cardScope treats '' the same way.
  if (id === 'unscoped') return kind === 'card' && (scopeOrScopes == null || scopeOrScopes === '');
  if (kind === 'card') return scopeOrScopes === id;
  return recordScopes(scopeOrScopes).includes(id);
}

// Enumerate directories matching one v1 pattern (`apps/*`). Throws on an
// unsupported pattern; a missing parent is an empty list, not an error.
function matchScopePattern(pattern, dir) {
  const segs = pattern.split('/');
  const last = segs.pop();
  if (last !== '*' || segs.some((s) => s.includes('*')) || isAbsolute(pattern)) {
    throw new Error(`scope: pattern "${pattern}" is not supported — v1 takes a relative path ending in a bare "*" segment (e.g. apps/*)`);
  }
  const base = segs.join('/');
  let entries = [];
  try { entries = readdirSync(resolve(dir, base || '.'), { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NEVER_A_SCOPE.has(e.name)) continue;
    out.push({ id: e.name, dir: base ? `${base}/${e.name}` : e.name });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Compile / CLI summary of the resolved vocabulary. null when the axis is off.
// Pattern-derived ids list as `a, b (from apps/*)`; a pattern matching nothing
// prints loudly (`none resolve from apps/*`); declared-only entries ride as
// `x (declared)`. A declared id that also matches a pattern is attributed to
// the pattern (it has a directory). A map prints per-scope coverage
// (`bridge ← apps/bridge, apps/cli`); directory-less map entries ride as
// `x (declared)`.
export function formatScopeSummary(manifest, dir) {
  const decl = scopeDecl(manifest);
  if (!decl) return null;
  if (decl.map) {
    const parts = Object.keys(decl.map).sort().map((id) => {
      const paths = decl.map[id];
      return paths.length ? `${id} ← ${paths.join(', ')}` : `${id} (declared)`;
    });
    return parts.length ? `scopes: ${parts.join(' + ')}` : null;
  }
  const parts = [];
  const seen = new Set();
  for (const pattern of decl.patterns) {
    const ids = matchScopePattern(pattern, dir).map((s) => s.id);
    for (const id of ids) seen.add(id);
    parts.push(ids.length ? `${ids.join(', ')} (from ${pattern})` : `none resolve from ${pattern}`);
  }
  const declaredOnly = decl.declared.filter((id) => id && !seen.has(id));
  if (declaredOnly.length) parts.push(`${declaredOnly.join(', ')} (declared)`);
  return parts.length ? `scopes: ${parts.join(' + ')}` : null;
}

// Map value → relative path list. String or list; empty list = directory-less.
// Rejects absolute paths, "..", and "*" (patterns belong on the derived rung).
function asMappedPaths(id, value) {
  if (typeof value === 'string') return asMappedPaths(id, [value]);
  if (!Array.isArray(value)) {
    throw new Error(`scope "${id}": value must be a path string or a list of paths (empty list = directory-less)`);
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const p = String(raw).trim().replace(/\/+$/, '');
    if (!p) continue;
    if (isAbsolute(p) || p.split('/').includes('..') || p.includes('*')) {
      throw new Error(`scope "${id}": path "${p}" is not a relative grounding — no absolute paths, "..", or "*" (use the derived-rung string/array form for patterns)`);
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function resolveScopeMap(map) {
  const claims = [];
  const out = [];
  for (const id of Object.keys(map).sort()) {
    const paths = map[id];
    if (!paths.length) {
      out.push({ id, dir: null });
      continue;
    }
    for (const p of paths) {
      claims.push({ id, path: p });
      out.push({ id, dir: p });
    }
  }
  assertNoCrossScopeOverlap(claims);
  return out;
}

// Exact match or prefix (apps vs apps/cli) is contested across two scopes.
// Same-scope nests are left for deepest-wins at inference.
function assertNoCrossScopeOverlap(claims) {
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      if (a.id === b.id) continue;
      if (a.path !== b.path && !a.path.startsWith(`${b.path}/`) && !b.path.startsWith(`${a.path}/`)) continue;
      const contested = a.path.length >= b.path.length ? a.path : b.path;
      const [x, y] = [a.id, b.id].sort();
      throw new Error(
        `scope overlap: "${x}" and "${y}" both claim ${contested} — cross-scope path overlap is a config error (deepest-wins applies only within one scope's roots or on the pattern rung)`,
      );
    }
  }
}

// Shelf lint (map only): a parent is a shelf when ≥2 of its immediate children
// are mapped roots. Flag each unclaimed sibling (skip hidden / node_modules /
// unscoped). A spot-grounding (one mapped child) does not judge siblings.
// No tree walk — only readdir the shelf parents. A child that contains a
// deeper mapped root is a container, not an unclaimed product.
export function unmappedShelfPaths(manifest, dir) {
  const decl = scopeDecl(manifest);
  if (!decl?.map || !dir) return [];
  const mapped = Object.values(decl.map).flat();
  const mappedSet = new Set(mapped);
  const byParent = new Map();
  for (const p of mapped) {
    const i = p.lastIndexOf('/');
    const parent = i === -1 ? '' : p.slice(0, i);
    const child = i === -1 ? p : p.slice(i + 1);
    if (!byParent.has(parent)) byParent.set(parent, new Set());
    byParent.get(parent).add(child);
  }
  const flagged = [];
  for (const [parent, kids] of byParent) {
    if (kids.size < 2) continue;
    let entries = [];
    try { entries = readdirSync(resolve(dir, parent || '.'), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'unscoped') continue;
      const rel = parent ? `${parent}/${e.name}` : e.name;
      if (mappedSet.has(rel)) continue;
      if (mapped.some((p) => p.startsWith(`${rel}/`))) continue;
      flagged.push(rel);
    }
  }
  return flagged.sort();
}

// Mapped value paths that are not directories on disk. The id still resolves;
// lint names the hole so the remedy is a one-line manifest edit (or restore).
export function missingMappedPaths(manifest, dir) {
  const decl = scopeDecl(manifest);
  if (!decl?.map || !dir) return [];
  const out = [];
  for (const id of Object.keys(decl.map).sort()) {
    for (const p of decl.map[id]) {
      let ok = false;
      try { ok = statSync(resolve(dir, p)).isDirectory(); } catch { ok = false; }
      if (!ok) out.push({ id, path: p });
    }
  }
  return out;
}
