import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

// Load a board source manifest (YAML or JSON). The kernel *interprets* this —
// nothing is compiled yet. Only the facets a verb actually needs are read.

export async function loadManifest(path) {
  const raw = await readFile(path, 'utf8');
  return (await parse(raw, path)) ?? {};
}

// Shallow overlay of two manifests: local overrides base per top-level facet
// (local key wins; omitted keys inherit). Used at install/vendor time to keep a
// board's own identity while taking a vendored workflow's stages/policies —
// workflows are copied once, not resolved live (docs/packages.md).
export function mergeManifests(base, local) {
  return { ...base, ...local };
}

async function parse(raw, path) {
  if (extname(path) === '.json') return JSON.parse(raw);
  try {
    const { default: yaml } = await import('js-yaml');
    return yaml.load(raw);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Reading a YAML manifest needs js-yaml. Run `npm install` in app/, ' +
          'or point --manifest at a .json manifest.',
      );
    }
    throw err;
  }
}

// --- inbox facet (capture) ---------------------------------------------------

// Which stage a freshly captured item lands in. Falls back to the first
// `options` stage, then to a literal 'pool' — so even a bare board works.
export function inboxLanding(manifest) {
  if (manifest.inbox?.landing) return manifest.inbox.landing;
  const firstOptions = stages(manifest).find((s) => s.role === 'options');
  return firstOptions?.id ?? 'pool';
}

export function allowedSources(manifest) {
  return manifest.inbox?.sources ?? null; // null = unrestricted
}

// The admitted-sources enumeration for error messages — every source-related
// rejection names the board's admitted kinds, so an agent gets its next move
// without a manifest lookup. One helper, so the phrasing cannot drift between
// errors. null when the inbox is open (nothing to enumerate).
export function admittedSourcesNote(manifest) {
  const sources = allowedSources(manifest);
  return sources ? `admitted sources: ${sources.join(', ')} (inbox.sources)` : null;
}

// --- stages / flows (transition, commit) -------------------------------------

export function stages(manifest) {
  return manifest.stages ?? [];
}

export function stageById(manifest, id) {
  return stages(manifest).find((s) => s.id === id) ?? null;
}

// The mainline forward step: the immediately following stage in declared order.
export function nextStageId(manifest, currentId) {
  const list = stages(manifest);
  const i = list.findIndex((s) => s.id === currentId);
  return i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
}

// A declared non-forward edge (loop / skip) between two stages, if any.
export function flowEdge(manifest, from, to) {
  return (manifest.flows ?? []).find((f) => f.from === from && f.to === to) ?? null;
}

export function flowsFrom(manifest, from) {
  return (manifest.flows ?? []).filter((f) => f.from === from);
}

// The commitment point: the stage whose role locates it.
export function commitStageId(manifest) {
  return stages(manifest).find((s) => s.role === 'commit')?.id ?? null;
}

// The Options set, definitionally: every stage whose role is `options` — the
// pre-commitment pool. Plural-aware (a board may declare several options stages)
// and role-derived, never a hardcoded stage id (this board renamed its options
// stage `pool`; others may name theirs anything). A card is an option iff its
// `state` is one of these. Returns a Set of stage ids.
export function optionsStageIds(manifest) {
  return new Set(stages(manifest).filter((s) => s.role === 'options').map((s) => s.id));
}

export function wipEnforcement(manifest) {
  return manifest.policies?.wip?.enforcement ?? 'advisory';
}

// The board's declared card types, or null = open. A type is just a label; the
// flow engine adds no per-type constraints (which stages it may use, per-type
// payload) unless the flow earns them — keep types simple.
export function cardTypes(manifest) {
  if (Array.isArray(manifest.types)) {
    // Only FLOW types close the set. A manifest that declares records alone (the
    // default init template: `procedure`, flow:false) still has open card types —
    // otherwise `capture --type bug` fails against an empty list.
    const flow = manifest.types.filter(isFlowType).map((t) => t.id);
    return flow.length ? flow : null;
  }
  const t = manifest.cardSchema?.types;
  return Array.isArray(t) ? t : null; // null = open / unrestricted
}

// A type with `flow: false` is a RECORD (knowledge), not a flowing card: it has no
// stage, so capture and the catch-up sync skip it — it lives in the knowledge
// layer (docs/knowledge.md), surfaced separately, never on the board.
export function isFlowType(def) {
  return def?.flow !== false;
}

// The rich definition for a type, or null. A type declares how it is embodied —
// folder | file | none — and where it materializes; capture creates that
// artifact, born tracked. (cardSchema.types is the legacy name-only form.)
// THE chokepoint for type resolution: the builtin `note` resolves here (unless a
// declared `note` shadows it), so every consumer — refTarget, capture's gate,
// lint, the fs scan — knows it without each remembering. The alternative was a
// week of "X doesn't know the builtin" bugs, one caller at a time.
export function typeDef(manifest, id) {
  const declared = (manifest.types ?? []).find((t) => t.id === id) ?? null;
  return declared ?? BUILTINS.find((b) => b.id === id) ?? null;
}

// The builtin note type — the knowledge layer's zero-declaration default, so
// `kanbento note` works on a bare board. A manifest that declares its own `note`
// type shadows it (custom path/marker — the usual progressive refinement).
export const BUILTIN_NOTE = Object.freeze({ id: 'note', embodiment: 'file', path: '.kanbento/notes/{slug}.md', flow: false });

// The builtin case type — case-based decisioning is a kanbento primitive (the
// `cases` command exists on every board), so its precedent files are first-class
// knowledge records, indexed like notes. This is what makes a precedent's `about`
// citation a real graph edge: refs/backlinks/maps surface the cases decided about a
// record. A declared `case` type shadows it (the usual progressive refinement).
export const BUILTIN_CASE = Object.freeze({ id: 'case', embodiment: 'file', path: '.kanbento/cases/{slug}.md', flow: false });

// The zero-declaration builtins, resolved by typeDef/embodiedTypes unless a manifest
// declares its own type of the same id (shadowing).
const BUILTINS = [BUILTIN_NOTE, BUILTIN_CASE];

// Every embodied type the fs scan should walk: the declared ones plus the builtins
// (`note`, `case`) not shadowed by a declaration — so bare-board notes and case
// precedents are visible to refs/maps/sweep.
export function embodiedTypes(manifest) {
  const declared = (manifest.types ?? []).filter((t) => t.embodiment && t.embodiment !== 'none');
  const declaredIds = new Set((manifest.types ?? []).map((t) => t.id));
  return [...declared, ...BUILTINS.filter((b) => !declaredIds.has(b.id))];
}

// The knowledge-record types among them (flow:false) — what sweep enriches and
// `note` may write to; flow cards are owned by the log, not the fs.
export function recordTypes(manifest) {
  return embodiedTypes(manifest).filter((t) => !isFlowType(t));
}

// Every DECLARED embodied type flagged `runnable: true` — the types whose records the
// runner serves (`do` / `--exec` / `--finalize`). Runnability is a declared type-level
// property, NOT the magic `procedure` name/path: any type with `runnable: true` and a
// file/folder embodiment gets the runner. A runtime flag can't express "the runner
// treats records of this type as executable" — it's a type-level capability parallel to
// `flow`. Declaration order is preserved, so it is the deterministic precedence order for
// a slug that collides across two runnable types (first-declared type wins). The package
// built-ins are NOT gated on this — they're kanbento internals, always runnable.
export function runnableDefs(manifest) {
  return (manifest.types ?? []).filter((t) => t.runnable === true && t.embodiment && t.embodiment !== 'none');
}

// The terms of a vocabulary (a status set, lane values, …). Accepts a bare list
// (terms only) or a described map (term -> description; descriptions are advisory,
// for agents to reason from). The `$ref` to a shared `vocabularies` block resolves
// here too, later — the seam that lets a vocab start inline and be extracted
// without breaking callers. Returns the normalized term list.
export function vocabTerms(values) {
  if (Array.isArray(values)) return values;
  if (values && typeof values === 'object') return Object.keys(values);
  return [];
}

// Which record type(s) a board treats as portfolio POSITIONS — standing bets the
// PORTFOLIO.md read-model orients around. Accepts one type or a list. The key's job
// is to tell the projection what to walk (the gates route via relations, not this);
// empty when undeclared — no portfolio view.
export function portfolioTypes(manifest) {
  const p = manifest.portfolio;
  if (!p) return [];
  return Array.isArray(p.types) ? p.types : p.type ? [p.type] : [];
}

// --- network facet (membership, docker-compose style) ------------------------

// Which networks this board declares membership in, and its handle on each.
// Member-declared, not host-owned — a board lists the networks it's on, the way a
// compose service lists its networks. Three forms, all degenerate cases of a map:
//   network: abc-host             -> on abc-host, as the board's own id
//   network: [abc-host, release]  -> on each, as the board's id
//   network: { abc-host: web-svc }-> on abc-host, "joined as" web-svc (an alias)
export function boardNetworks(manifest) {
  const n = manifest.network;
  if (!n) return [];
  const id = manifest.board?.id ?? null;
  const norm = (s) => String(s).replace(/^@/, '');
  const entry = (network, handle) => ({ network: norm(network), handle: norm(handle || id || network) });
  if (typeof n === 'string') return [entry(n, id ?? n)];
  if (Array.isArray(n)) return n.map((name) => entry(name, id ?? name));
  if (typeof n === 'object') return Object.entries(n).map(([net, h]) => entry(net, h));
  return [];
}

// --- lanes facet (orthogonal partitions) -------------------------------------

// The board's declared lane axes, normalized to [{ axis, from, name, values }].
// A lane partitions the board orthogonally to stage (a swimlane), and it is
// DERIVED, not stored: `from` names the card field to group by (default: the axis
// name, resolved against the card's payload), so the partition value is plain
// card data — one source of truth, not a parallel namespace. `values` (optional)
// closes the set: validation, stable ordering, and empty lanes.
// The axis name `scope` is RESERVED: scope is a card field with its own mechanics
// (vocabulary, cwd inference, storage), not a lane — an axis literally named
// `scope` would silently shadow it, so it is refused loudly here (every read
// path and compile normalize through this function).
export function lanes(manifest) {
  const out = (manifest.lanes ?? [])
    .filter((l) => l && l.axis)
    .map((l) => ({ axis: l.axis, from: l.from ?? l.axis, name: l.name ?? l.axis, values: l.values ?? null }));
  for (const l of out) {
    if (l.axis === 'scope') {
      throw new Error('lanes: axis "scope" is reserved — scope is a card field (assigned with capture --scope / inferred from cwd), a lane is a projection; for scope swimlanes declare a lane that projects the field, e.g. { axis: "product", from: "scope" }');
    }
  }
  return out;
}

// A card's value on one lane axis: read the `from` field (payload first, then the
// card root), falling back to the legacy `lane:{}` namespace. null = unset — the
// card sits in the "shared" lane, upstream of where the axis binds.
export function laneValue(card, def) {
  const from = def.from ?? def.axis;
  const v = getPath(card?.payload, from) ?? getPath(card, from) ?? card?.lane?.[def.axis];
  return v == null || v === '' ? null : v;
}

function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
