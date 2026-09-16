import { join, resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rename, readdir, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { refsFromArgs, resolveRelKey, parseCurie, checkRelationStrict, refEdges, refTarget } from './refs.js';
import { typeDef, isFlowType, BUILTIN_NOTE, embodiedTypes, runnableDefs, vocabTerms } from './manifest.js';
import { slugify, titleSlug, explicitSlug } from './slug.js';
import { readType, writeBack, indexRecords, indexDocs, artifactIndex } from './binding.js';
import { casesDir } from './cases.js';
import { resolveScopes, assertScope, inferScopeFromPath, cardDocTemplate, cardScope, expectedCardDocPath } from './scope.js';
import { writeFrontmatterBlock, writeFrontmatterField, removeFrontmatterField, readFrontmatter } from './frontmatter.js';
import { readScheduleState, grantSummary } from './schedule.js';
import { runWitness } from './runner.js';
import { foldAccretion } from './accretion.js';

const execFileP = promisify(execFile);

// The verb bodies behind the CLI — everything a command DOES between parsing its
// arguments and printing its result. Each takes an opened board context
// ({ board, dir }) and returns data; stdio, exit codes, $EDITOR, and background
// spawns stay in cli.js (the transport). Testable against a MemoryLog board + tmp dir.

// Serialize a fresh frontmatter block for a materialized artifact.
export function newFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    lines.push(`${k}: ${/[:#"'\n]/.test(String(v)) ? JSON.stringify(String(v)) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// Resolve how a type's embodiment materializes for a given slug: the frontmatter
// file the card binds to (the file itself, or a folder's marker), plus the path
// to show the user. null when the type has no embodiment (a pure card).
export function embodimentArtifact(def, slug, id, dir, fields = {}, { pinned = false } = {}) {
  if (!def?.embodiment || def.embodiment === 'none') return null;
  // Interpolate lane/field tokens first (content/{website}/{slug}.md), so the
  // artifact is partitioned by the card's lane before the slug is placed.
  const tmpl = Object.entries(fields).reduce((p, [k, v]) => p.replaceAll(`{${k}}`, v), def.path);
  const unresolved = tmpl.replace('{slug}', '').match(/\{([^}]+)\}/);
  if (unresolved) throw new Error(`capture: ${def.path} has unresolved {${unresolved[1]}} — pass --lane ${unresolved[1]}=<value>`);
  // Uniqueness guard: a DERIVED slug is a hint — if its path is taken, disambiguate
  // with the card's short id so two same-named items coexist (cf. tobi/try's dating).
  // An EXPLICIT --slug (pinned) is the user's word, not a hint: a collision there is
  // an error, surfaced loudly, not silently suffixed behind their back.
  const taken = (s) => existsSync(resolve(dir, tmpl.replace('{slug}', s)));
  if (pinned && taken(slug)) throw new Error(`slug "${slug}" is taken — ${tmpl.replace('{slug}', slug)} already exists; choose another --slug (or omit it to auto-name)`);
  const unique = taken(slug) ? `${slug}-${id.slice(0, 8)}` : slug;
  const target = tmpl.replace('{slug}', unique);
  if (def.embodiment === 'folder') {
    return { path: join(target, def.marker ?? '.kanbento-space'), workspace: target, show: target + '/', slug: unique };
  }
  return { path: target, show: target, slug: unique };
}

export function parseLane(pairs) {
  if (!pairs?.length) return undefined;
  const lane = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    const k = i > 0 ? p.slice(0, i) : '';
    const v = i >= 0 ? p.slice(i + 1) : '';
    // A malformed pair is an error, not a silent drop — dropping let `--lane scope=`
    // slip past the scope-removal guard with no trace.
    if (!k || !v) throw new Error(`--lane: malformed pair "${p}" — expected key=value`);
    lane[k] = v;
  }
  return lane;
}

// The capture payload: lane fields (top-level) + typed references (under `refs`).
// Keys pass through resolveRelKey — a bare vocabulary name (supports) lands as its
// dotted id (epistemic.supports), so stored edges are never ambiguous.
export function capturePayload(opts, manifest) {
  const refs = namespacedRefs(refsFromArgs(opts.rel), manifest); // relations via --rel key=curie ('about' is just one key)
  const payload = { ...(parseLane(opts.lane) ?? {}), ...(refs ? { refs } : {}) };
  return Object.keys(payload).length ? payload : undefined;
}

function namespacedRefs(refs, manifest) {
  if (!refs || !manifest) return refs;
  return Object.fromEntries(Object.entries(refs).map(([k, v]) => [resolveRelKey(manifest, k), v]));
}

// Preferred stored spelling for a resolved knowledge piece — same policy as link:
// typed card → type:slug CURIE; untyped/slugless card → slug or id; record → its CURIE.
export function storedRelTarget(piece) {
  if (piece.kind === 'card') {
    const c = piece.card;
    return (c.type && c.slug) ? `${c.type}:${c.slug}` : (c.slug ?? c.id);
  }
  return piece.record.curie;
}

// Resolve one --rel RHS handle to the stable form stored on the edge. Accepts any
// unambiguous <ref> (slug, id, slug@id, CURIE, prefix). A well-formed CURIE that
// matches nothing is kept as a frontier/forward ref (knowledge capture). Anything
// else unresolvable fails loud — bare handles need a board match.
export async function resolveRelTarget({ board, dir }, raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('refs: empty target — pass key=<ref> (slug, id, CURIE, or prefix)');
  let piece;
  try {
    piece = await resolvePiece({ board, dir }, value);
  } catch (e) {
    const msg = e?.message ?? String(e);
    // resolvePiece / board.card throw on ambiguity — re-prefix so the --rel path is obvious
    if (/ambiguous/i.test(msg)) throw new Error(msg.startsWith('refs:') ? msg : `refs: ${msg}`);
    throw e;
  }
  if (piece) return storedRelTarget(piece);
  if (parseCurie(value)) return value; // frontier CURIE — typed forward-ref still allowed
  throw new Error(`refs: "${value}" not found as a handle; use a slug/id/CURIE the board knows, or type:slug for a frontier ref`);
}

// Resolve every value in a refs map. PURE over the map shape; resolution is
// board-backed. Undefined in → undefined out (no empty refs block).
export async function resolveRelTargets(ctx, refs) {
  if (!refs) return refs;
  const out = {};
  for (const [rel, values] of Object.entries(refs)) {
    const list = Array.isArray(values) ? values : values == null ? [] : [values];
    out[rel] = [];
    for (const v of list) out[rel].push(await resolveRelTarget(ctx, v));
  }
  return out;
}

// Capture one item: mint the card, materialize a typed artifact (born tracked), and
// bind a doc when the body is rich (the one-step capture + elaborate). Returns
// { card, artifact, boundDoc } for the caller to present.
export async function captureCard({ board, dir }, body, opts = {}) {
  if (!body.trim()) throw new Error(`capture: no text — pass inline text, -F <file>, or pipe stdin${opts.claimedHint ?? ''}`);
  const def = opts.type ? typeDef(board.manifest, opts.type) : null;
  if (def && !isFlowType(def)) {
    // reject before materializing — the kernel gates this too, but by then the artifact would exist
    throw new Error(`capture: "${opts.type}" is a record type (flow:false) — it lives in the knowledge layer, not the board; use note`);
  }
  // Embodiment materializes the artifact at capture, born tracked — a file binds
  // to itself, a folder to the marker carrying its frontmatter. The id is minted
  // up front so the artifact path can disambiguate by it.
  const id = randomUUID();
  // The title/slug source: an explicit title (inline text alongside -F) wins over
  // the body's first line.
  const firstLine = opts.title?.trim() || (body.split('\n').map((l) => l.trim()).find(Boolean) ?? body);
  // Heuristic naming is opt-in (features.slugify: true); by default an unnamed
  // artifact is born id-named and the semantic reslug renames it when it lands.
  // An explicit --slug always names.
  const derive = board.manifest.features?.slugify === true;
  const artifactSlug = opts.slug ? explicitSlug(opts.slug) : (derive ? titleSlug(firstLine) : id.slice(0, 8)); // names the artifact file (explicit --slug: sanitized, never capped)
  // Validate everything that can fail (the --rel shape, handle resolution, an
  // explicit-slug collision) BEFORE the capture event or the artifact write —
  // a failed verb leaves no trace (atomicity).
  // Scope is a card field, not a lane — the borrowed `--lane scope=` spelling was
  // removed (no alias; two spellings for one concept teach the wrong model). Refuse
  // it loudly with the pointer to the dedicated flag.
  // Raw-pair check so an empty value (`--lane scope=`) or bare key still gets THIS
  // teaching error rather than the generic malformed-pair one.
  if (opts.lane?.some((p) => p === 'scope' || p.startsWith('scope='))) {
    throw new Error('capture: --lane scope= was removed — scope is a card field, not a lane; assign it with --scope <s> (a board wanting scope swimlanes declares a lane with from: scope)');
  }
  let payload = capturePayload(opts, board.manifest); // throws on a malformed --rel pair
  if (payload?.refs) payload.refs = await resolveRelTargets({ board, dir }, payload.refs); // bare handles → stable stored form
  // Product scope (note:scope-segregation): the vocabulary resolves from the manifest's
  // declared topology at read time. An explicit `--scope` wins (validated — closed
  // by the world); else the cwd infers: capturing from inside a scope root assigns that
  // scope with zero per-capture tax. A board that declares no scope is untouched.
  const scopes = resolveScopes(board.manifest, dir);
  if (opts.scope != null && !scopes) {
    throw new Error('capture: --scope needs the board to declare a scope vocabulary (manifest `scope:`, e.g. scope: apps/*)');
  }
  if (scopes) {
    if (opts.scope != null) {
      assertScope(scopes, String(opts.scope), 'capture');
      (payload ??= {}).scope = String(opts.scope);
    } else {
      const inferred = inferScopeFromPath(scopes, dir, opts.cwd ?? process.cwd());
      if (inferred) (payload ??= {}).scope = inferred;
    }
  }
  const artifact = embodimentArtifact(def, artifactSlug, id, dir, parseLane(opts.lane) ?? {}, { pinned: !!opts.slug });
  const card = await board.capture({
    id,
    source: opts.source,
    body,
    title: opts.title,
    type: opts.type,
    from: opts.from,
    path: artifact?.path,
    idempotencyKey: opts.key,
    // store only an explicit handle; an auto slug is derived from the title at
    // render — dynamic (follows title/cap changes), since the id carries identity
    slug: opts.slug ? explicitSlug(opts.slug) : undefined,
    payload, // --lane fields + --rel relations (under payload.refs) — validated above
  });
  if (artifact) {
    const abs = resolve(dir, artifact.path);
    if (existsSync(abs)) throw new Error(`capture: ${artifact.path} already exists`);
    await mkdir(dirname(abs), { recursive: true }); // creates the workspace folder for a folder type
    const front = newFrontmatter({ kanbento_id: card.id, type: card.type, status: card.state, title: card.title });
    await writeFile(abs, `${front}${opts.richBody ? body.trim() + '\n' : ''}`, 'utf8'); // -F writes the body into the artifact
  }
  // A plain card (no typed artifact) with a rich body binds a doc — the one-step
  // capture+elaborate. Mirrors elaborate's materialize-on-demand.
  let boundDoc = null;
  if (opts.richBody && !artifact) {
    const rel = await ensureCardDoc({ board, dir }, card, body);
    boundDoc = rel;
  }
  return { card, artifact, boundDoc };
}

// `note` — capture a unit of knowledge into the knowledge layer: a frontmattered
// file, not a card. No event, no landing, never on the board (card = unit of
// tracking, status intrinsic; note = unit of knowledge, no status ever). The
// builtin `note` type works on a bare board; --type picks a declared record
// type (flow:false) instead — a flow type is capture's business.
// The freshness clock for a knowledge record — a revision date (day granularity),
// stamped at creation and reset on elaborate. Curation reads (now - revised) as
// decay: a prior on undetected refutation (see the curation capability).
function revisionStamp() {
  return new Date().toISOString().slice(0, 10);
}

// A record's content-change signal for `sweep`'s `revised:` refresh — PURE. mtime is
// NOT this signal: git checkout/merge and artifact materialization bump mtime without
// touching bytes, so keying the restamp off mtime (the old revisedStale predicate)
// falsely reset revised: on untouched records and corrupted curation's freshness clock
// (sweep-restamps-untouched@67325ca4). We hash the file's bytes instead: the digest
// moves only when content actually moves.
export function contentDigest(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

// Should `sweep` restamp `revised:` on this record? Content-change, not mtime:
//   - a prior digest that DIFFERS from the file's current digest → content genuinely
//     changed (a hand edit) → restamp (this preserves mtime-revised-drift@71692bd8 —
//     hand-edited records still get their edit clock reset).
//   - a prior digest that MATCHES → only the mtime moved (checkout/merge/materialize) →
//     leave revised: alone. THIS is the bug fix.
//   - NO prior digest (first sight) → there is no content baseline to compare against,
//     so restamping would be an mtime guess — exactly the false restamp (a fresh
//     checkout bumps every mtime). Seed the baseline silently, never restamp; a later
//     real edit trips the digest. The one-time cost: an edit made before a record's
//     first-ever sweep won't reset revised — acceptable next to corrupting the whole
//     corpus on every checkout, and the steady state (regular sweeps) catches all edits.
export function sweepShouldRestamp(priorDigest, currentDigest) {
  if (priorDigest == null) return false; // first sight — seed, never restamp off mtime
  return priorDigest !== currentDigest;
}

export async function noteCard({ board, dir }, body, opts = {}) {
  const text = (body ?? '').trim();
  if (!text) throw new Error(`note: no content (inline text, -F <file>, or piped stdin)${opts.claimedHint ?? ''}`);
  const typeId = opts.type ?? BUILTIN_NOTE.id;
  const def = typeDef(board.manifest, typeId); // resolves the builtin note too (the chokepoint)
  if (!def) throw new Error(`note: type "${typeId}" is not declared`);
  if (isFlowType(def)) throw new Error(`note: "${typeId}" is a flow type — it mints a card with a status; use capture`);
  if (!def.embodiment || def.embodiment === 'none') throw new Error(`note: type "${typeId}" has no embodiment — nowhere to write`);
  // Title: explicit --title (or inline text with -F) wins; else body's first line
  // (heading marker stripped). Auto-slug follows the resolved title so a short
  // --title is not forced to share the body's first-paragraph wording.
  const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim();
  const title = (opts.title != null && String(opts.title).trim()) ? String(opts.title).trim() : firstLine;
  const id = randomUUID();
  // Validate every arg that can fail BEFORE touching the filesystem, so a bad --rel
  // (or a swallowed positional token / unresolvable handle) never leaves an orphan
  // file behind (atomicity). Bare handles resolve to the stable stored form first.
  let refs = namespacedRefs(refsFromArgs(opts.rel), board.manifest); // throws on a malformed --rel pair
  if (refs) refs = await resolveRelTargets({ board, dir }, refs);
  // No reslug pipeline here (no card, no event) — the file needs its name NOW,
  // so the heuristic slug applies regardless of features.slugify. An explicit
  // --slug is pinned: a collision fails loudly rather than silently uniquifying.
  const slug = opts.slug ? explicitSlug(opts.slug) : (titleSlug(title) || id.slice(0, 8));
  // Record scopes (zero-or-more; zero = universal): validated against the resolved
  // vocabulary, written to frontmatter below. NEVER a folder placement — a record's
  // scope is many-valued and lives in its frontmatter (note:scope-segregation).
  const noteScopes = (Array.isArray(opts.scope) ? opts.scope : String(opts.scope ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (noteScopes.length) {
    const scopes = resolveScopes(board.manifest, dir);
    if (!scopes) throw new Error('note: --scope needs the board to declare a scope vocabulary (manifest `scope:`, e.g. scope: apps/*)');
    for (const s of noteScopes) assertScope(scopes, s, 'note');
  }
  const artifact = embodimentArtifact(def, slug, id, dir, {}, { pinned: !!opts.slug });
  const abs = resolve(dir, artifact.path);
  await mkdir(dirname(abs), { recursive: true });
  const front = { kanbento_id: id, title };
  if (opts.type) front.type = def.id; // a typed record self-describes; a bare note stays type-less
  if (def.status?.values) front[def.status.field ?? 'status'] = vocabTerms(def.status.values)[0]; // seed the lifecycle at its first declared state (capability -> idea)
  await writeFile(abs, `${newFrontmatter(front)}${text}\n`, 'utf8');
  if (refs && Object.keys(refs).length) await writeFrontmatterBlock(abs, 'refs', refs);
  if (noteScopes.length) await writeFrontmatterBlock(abs, 'scope', noteScopes); // zero-or-more; absent = universal
  await writeFrontmatterField(abs, 'revised', revisionStamp()); // start the freshness clock
  return { id, artifact, curie: `${def.id}:${artifact.slug}` };
}

// Merge relations into a file's `refs` frontmatter (union per relation, valid
// CURIEs only). Returns true if anything new was written — idempotent, so a
// re-run with the same edges is a no-op. Shared by `sweep` (extracted edges)
// and `link` (a record's outgoing edge — the FS owns record edges).
export async function mergeRefs(absPath, existing, rels) {
  const merged = { ...(existing ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(rels)) {
    const incoming = (Array.isArray(v) ? v : [v]).filter((c) => typeof c === 'string' && parseCurie(c));
    if (!incoming.length) continue;
    const cur = new Set(Array.isArray(merged[k]) ? merged[k] : merged[k] ? [merged[k]] : []);
    const before = cur.size;
    for (const c of incoming) cur.add(c);
    if (cur.size !== before) changed = true;
    merged[k] = [...cur];
  }
  if (!changed) return false;
  await writeFrontmatterBlock(absPath, 'refs', merged);
  return true;
}

// The inverse of mergeRefs — remove targets from a file's `refs` frontmatter. Idempotent:
// removing an absent edge is a no-op (returns false, nothing written). An emptied relation
// key is dropped, and if `refs` empties out entirely the whole block is removed (no bare
// `refs: {}` left behind). The FS owns record edges, so retraction rewrites the file.
export async function unmergeRefs(absPath, existing, rels) {
  const merged = { ...(existing ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(rels)) {
    if (!(k in merged)) continue;
    const drop = new Set(Array.isArray(v) ? v : [v]);
    const cur = (Array.isArray(merged[k]) ? merged[k] : merged[k] == null ? [] : [merged[k]]);
    const next = cur.filter((c) => !drop.has(c));
    if (next.length === cur.length) continue; // nothing matched — no-op for this rel
    changed = true;
    if (next.length) merged[k] = next;
    else delete merged[k]; // an emptied relation leaves no bare key
  }
  if (!changed) return false;
  if (Object.keys(merged).length === 0) await removeFrontmatterField(absPath, 'refs');
  else await writeFrontmatterBlock(absPath, 'refs', merged);
  return true;
}

// `link`, routed by what `from` resolves to — the ownership model applied to
// edges: a card's edges live in the log (CardLinked, unchanged), a record's in
// its file (frontmatter refs, merged idempotently). `to` may be either; a
// record is addressed by its CURIE (records have no ids to prefix-match).
export async function linkRefs({ board, dir }, fromRef, rel, toRef) {
  rel = resolveRelKey(board.manifest, rel); // bare vocabulary name -> dotted id
  const from = await resolvePiece({ board, dir }, fromRef);
  if (!from) throw new Error(`link: "${fromRef}" matches no card or record`);
  if (from.kind === 'card') {
    // card -> anything: resolve the target ourselves (card OR record) and hand the
    // kernel a pre-resolved target string, so a card can point at a position record.
    const to = await resolvePiece({ board, dir }, toRef);
    if (!to) throw new Error(`link: "${toRef}" matches no card or record`);
    if (to.kind === 'card' && to.card.id === from.card.id) throw new Error('link: a card cannot link to itself');
    const target = storedRelTarget(to);
    const targetType = to.kind === 'card' ? to.card.type : to.record.type;
    const res = await board.link(fromRef, rel, target, { target, targetType });
    return { kind: 'card', from: res.from, rel: res.rel, target: res.target, card: res.card };
  }
  // The target must exist too — a card (by its CURIE) or a record (its CURIE);
  // linking to nothing fails loudly, as with cards.
  const to = await resolvePiece({ board, dir }, toRef);
  if (!to) throw new Error(`link: "${toRef}" matches no card or record`);
  if (to.kind === 'card' && !(to.card.type && to.card.slug)) {
    // A record's edge lives in frontmatter, which holds only CURIEs; a slugless or
    // untyped card has no CURIE handle, so the edge can't be stored. Refuse loudly
    // rather than drop it and report success (the old phantom).
    throw new Error(`link: card ${to.card.id.slice(0, 8)} has no CURIE handle (needs type:slug) — a record can only reference a slugged, typed card; give it a slug first`);
  }
  const target = storedRelTarget(to);
  const targetType = to.kind === 'card' ? to.card.type : to.record.type;
  const record = from.record;
  const existing = refEdges(record.refs, { rel }).length;
  const strictErr = checkRelationStrict(board.manifest, rel, targetType, existing);
  if (strictErr) throw new Error(`link: ${strictErr}`);
  const wrote = await mergeRefs(resolve(dir, record.path), record.refs, { [rel]: [target] });
  return { kind: 'record', from: record, rel, target, wrote };
}

// `unlink`, symmetric to linkRefs — retract a typed edge, routed by what `from` owns:
// a card's edge is dropped via a CardUnlinked event (the log fold retracts it, still
// append-only); a record's edge is removed from its frontmatter (the FS owns it). Both
// are idempotent — retracting an absent edge is an honest no-op, never a throw.
export async function unlinkRefs({ board, dir }, fromRef, rel, toRef) {
  rel = resolveRelKey(board.manifest, rel); // bare vocabulary name -> dotted id
  const from = await resolvePiece({ board, dir }, fromRef);
  if (!from) throw new Error(`unlink: "${fromRef}" matches no card or record`);
  // Resolve the target to its CURRENT spelling when we can — but DON'T require it.
  // `link` stored the target's resolution-time spelling (a raw uuid before slugging,
  // a `type:slug` after, or a verbatim string for an unresolvable CURIE like
  // `file:...`), so resolve-then-compare misses stored spellings. The verbatim toRef
  // is the fallback: retraction must reach a stale-uuid or `file:` edge that resolves
  // to nothing today.
  let resolved = null;
  try {
    const to = await resolvePiece({ board, dir }, toRef);
    if (to) resolved = storedRelTarget(to);
  } catch { /* an ambiguous ref — fall back to the verbatim toRef */ }
  if (from.kind === 'card') {
    // Hand the kernel both the resolved spelling and the verbatim toRef; it retracts
    // whichever the stored edge actually carries (see unlink in kernel.js).
    const res = await board.unlink(from.card.id, rel, toRef, { target: resolved });
    return { kind: 'card', from: res.from, rel: res.rel, target: res.target, removed: res.removed, card: res.card };
  }
  const record = from.record;
  const targets = [...new Set([resolved, String(toRef)].filter(Boolean))]; // resolved spelling + verbatim fallback
  const wrote = await unmergeRefs(resolve(dir, record.path), record.refs, { [rel]: targets });
  return { kind: 'record', from: record, rel, target: resolved ?? String(toRef), wrote };
}

// THE card-or-record resolver — cards and records are both knowledge pieces, so a
// verb taking a <ref> resolves both and routes by ownership (log vs fs) internally.
// Cards win (the store is authoritative for tracked work); a record is addressed by
// its CURIE, or a bare slug when exactly one embodied type has it.
export async function resolvePiece({ board, dir }, ref) {
  const card = await board.card(ref);
  if (card) return { kind: 'card', card };
  const curie = parseCurie(ref);
  const defs = embodiedTypes(board.manifest).filter((t) => (curie ? t.id === curie.type : true));
  const matches = [];
  for (const def of defs) {
    for (const r of await indexRecords(def, dir)) {
      if (curie ? r.curie === ref : r.curie?.endsWith(`:${ref}`)) matches.push(r);
    }
  }
  if (matches.length > 1) throw new Error(`"${ref}" is ambiguous — ${matches.map((m) => m.curie).join(', ')}`);
  return matches[0] ? { kind: 'record', record: matches[0] } : null;
}

// The card's doc: an existing binding, or a freshly materialized cards/{slug}.md.
// The slug leads (mirrors the slug@id handle); a short id is appended only on a
// name clash — reusing exactly how a typed card materializes its artifact.
// On a scope-declaring board the doc rides the scope-major layout instead:
// data/<scope>/cards/{slug}.md, with data/cards/ as the visible unscoped queue
// (cardDocTemplate). `kanbento scope` is the mover; this only materializes a
// headless card at the current template.
export async function ensureCardDoc({ board, dir }, card, body = '') {
  let rel = card.binding?.path;
  if (rel) return rel;
  const doc = embodimentArtifact({ embodiment: 'file', path: cardDocTemplate(board.manifest, cardScope(card)) }, card.slug ?? card.id.slice(0, 8), card.id, dir, {});
  rel = doc.path;
  const abs = resolve(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${newFrontmatter({ kanbento_id: card.id, title: card.title })}${body.trim() ? body.trim() + '\n' : ''}`, 'utf8');
  await board.bind(card.id, rel); // append-only: the card now has a doc
  return rel;
}

// Give a card a body: materialize its doc on demand and (when content is given)
// APPEND to it — a card's body accretes like everything else in the ontology
// (events, records, precedents), so a fresh-session agent can't nuke a body it
// never saw; the rare deliberate rewrite passes --replace. --title corrects the
// card's title in the same breath — titles rot as understanding improves, and
// elaboration is exactly when they do; a CardRetitled event lands the correction
// (titles are log-owned) and the doc's frontmatter follows. Returns { card, rel,
// wrote, retitled } — with empty content the doc is only ensured, for the
// caller's interactive $EDITOR path.
export async function elaborateCard({ board, dir }, ref, content = '', { title, replace } = {}) {
  let card = await board.card(ref);
  if (!card) {
    // A record (a knowledge piece — e.g. a capability position) can be elaborated
    // too: it ACCRETES by default like everything else; --replace is the deliberate
    // consolidation/correction path (the frontmatter — identity, status, refs —
    // survives; only the body is rewritten). --title corrects the record's title in
    // the same breath (written to the frontmatter, not the log — see below).
    const piece = await resolvePiece({ board, dir }, ref);
    if (piece?.kind === 'record') {
      const relPath = piece.record.path;
      const abs = resolve(dir, relPath);
      const target = piece.record.curie ?? relPath;
      // --title now follows the body on a RECORD too — the moment a --replace
      // consolidation lands is exactly when the title most needs to catch up (the same
      // rationale the card path names). The asymmetry was only mechanical: a card title
      // is log-owned (CardRetitled), a record title is file-owned frontmatter — one
      // writeFrontmatterField next to `revised`. The retitle is still WITNESSED, not a
      // silent file write: the Elaborated event carries it (a `retitle` mode when
      // title-only, a `retitled` flag when it rides a body write). foldAccretion ignores
      // a `retitle` event — a retitle is a revision, not a body append, so it must never
      // inflate the accretion nudge.
      const newTitle = title?.trim();
      const retitled = !!(newTitle && newTitle !== piece.record.title);
      if (!content.trim()) {
        // Title-only (or a pure no-op) — no body write. A real retitle still resets the
        // freshness clock and lands a witnessed `retitle` event; it does NOT accrete.
        if (retitled) {
          await writeFrontmatterField(abs, 'title', JSON.stringify(newTitle)); // record title lives in frontmatter
          await writeFrontmatterField(abs, 'revised', revisionStamp()); // a retitle is a revision
          await board.elaborated(target, 'record', 'retitle');
        }
        return { record: piece.record, rel: relPath, wrote: false, retitled };
      }
      const prev = await readFile(abs, 'utf8');
      // Append-drift accretion (note:append-drift): appends-since-last-consolidation.
      // The count lives in the LOG now — each body write witnesses an `Elaborated`
      // event (below), and foldAccretion derives the signal on demand; the retired
      // `appends` frontmatter counter is gone (a bare counter in every .md file has no
      // semantic value to a cold reader — initiative:counter-append-drift). The nudge
      // is an ADVISORY hint at the decision point — never a block, prompt, or exit-code
      // change; it fires from the fold once accretion has built up.
      if (replace) {
        const m = prev.match(/^---\n[\s\S]*?\n---\n?/);
        const head = m ? m[0] : '';
        await writeFile(abs, `${head}${content.trim()}\n`, 'utf8');
      } else {
        await writeFile(abs, `${prev.replace(/\s+$/, '')}\n\n${content.trim()}\n`, 'utf8');
      }
      if (retitled) await writeFrontmatterField(abs, 'title', JSON.stringify(newTitle)); // the retitle rides the same consolidation
      await writeFrontmatterField(abs, 'revised', revisionStamp()); // revisiting resets the freshness clock
      await board.elaborated(target, 'record', replace ? 'replace' : 'append', { retitled });
      // Accretion for this ref, folded from the log (includes the event just written).
      const accretion = foldAccretion(await board.events()).get(target) ?? 0;
      return { record: piece.record, rel: relPath, wrote: true, replaced: !!replace, retitled, accretion };
    }
    throw new Error(`elaborate: "${ref}" not found`);
  }
  const retitled = !!(title?.trim() && title.trim() !== card.title);
  if (retitled) card = await board.retitle(card.id, title.trim(), { pinned: true });
  const wasBound = !!card.binding?.path;
  const rel = await ensureCardDoc({ board, dir }, card);
  // ensureCardDoc may have just bound — the in-memory card still lacks binding.path.
  // Refresh so same-call follow-ups (CLI elaborate --slug → applyReslug) can rename
  // the freshly materialized doc; without this, applyReslug sees no binding and
  // only re-pins the handle while the file stays at the old slug path.
  if (!wasBound) card = (await board.card(card.id)) ?? card;
  const abs = resolve(dir, rel);
  if (retitled) await writeFrontmatterField(abs, 'title', JSON.stringify(card.title)); // the doc's frontmatter follows the correction
  if (content.trim()) {
    if (replace) {
      // Deliberate rewrite: rebuild the doc fresh, dropping the prior body (the old default).
      await writeFile(abs, `${newFrontmatter({ kanbento_id: card.id, title: card.title })}${content.trim()}\n`, 'utf8');
    } else {
      // Append — read-then-add, mirroring the record branch (frontmatter is preserved
      // as part of prev; a bodyless card gains one clean separator, no leading blanks).
      // AC#4 decision: the append-drift nudge is EXCLUDED here. It scopes to knowledge-
      // layer records (capability/strategy/…) — durable, context-served docs that decay
      // (note:append-drift). A card's bound doc is an ephemeral working artifact tied to
      // the card's lifecycle (archived/removed with the card), so consolidation pressure
      // doesn't apply; no nudge. The body write is still witnessed (below) so the log
      // carries the audit dimension for card elaborations too.
      const prev = await readFile(abs, 'utf8');
      await writeFile(abs, `${prev.replace(/\s+$/, '')}\n\n${content.trim()}\n`, 'utf8');
    }
    // Witness the body write ONCE per elaborate call — append or --replace alike. A call
    // that also retitles/binds still fires its CardRetitled/CardBound (different facts,
    // not double-witnessing); this is the single Elaborated event for the body itself.
    await board.elaborated(card.id, 'card', replace ? 'replace' : 'append');
  }
  return { card, rel, wrote: !!content.trim(), retitled, replaced: !!(replace && content.trim()) };
}

// The world-state a reaffirmation was checked against: the full HEAD sha, namespaced
// `git:<sha>`. Fail-soft (no git binary / not a repo / empty repo → null), following
// the gitObserver idiom — git is enrichment, never required, so the caller degrades to
// a calendar date rather than erroring. execFile (no shell) — dir is untrusted input.
async function gitHead(dir) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: dir });
    const sha = stdout.trim();
    return sha ? `git:${sha}` : null;
  } catch {
    return null; // git absent / not a repo / empty repo — degrade to the calendar clock
  }
}

// `reaffirm` — the performative "checked against the scope, still true." Stamps a
// record's `verified` frontmatter field with the world-state it was checked against:
// `verified: git:<sha>` (HEAD at reaffirmation), or the fail-soft `verified: date:<ISO>`
// when there's no shared git history. Records only (fs-owned); a flow card's verification
// is its done gate, so reaffirming one is an error that teaches. Does NOT touch `revised`
// — the two clocks stay distinct (edit clock vs check clock). No event (consistent with
// note/elaborate: the frontmatter field is the store). Idempotent: re-running updates in place.
export async function reaffirmCard({ board, dir }, ref) {
  const piece = await resolvePiece({ board, dir }, ref);
  if (!piece) throw new Error(`reaffirm: "${ref}" matches no record`);
  if (piece.kind === 'card') {
    throw new Error(`reaffirm: "${ref}" is a flow card — a card's verification is its done gate; reaffirm is for records`);
  }
  const record = piece.record;
  const abs = resolve(dir, record.path);
  const verified = (await gitHead(dir)) ?? `date:${revisionStamp()}`;
  await writeFrontmatterField(abs, 'verified', verified);
  return { record, verified };
}

// `graduate` — flip a flow:false record's status through the CLI, appending an
// identity-stamped witness instead of a bare frontmatter hand-edit. The status
// field is fs-owned (like a record's whole frontmatter), so the WRITE is the store;
// the RecordGraduated event is the AUDIT TRAIL — "who armed procedure:issue-dedup to
// `trusted`, and when" answerable from the log alone (the instructor effect gate greps
// `status: trusted`, so provenance matters). Mirrors reaffirm: records only (a flow
// card's status is its stage/transition — reaffirm's card guard teaches the same). The
// target is validated against the record TYPE's declared status vocabulary — an unknown
// status is refused, never written. Does NOT touch `verified` (the reaffirm check clock)
// or `revised` (the elaborate edit clock): graduation is its own axis, distinct from
// both. Idempotent no-op when already at the target (no event, no write).
export async function graduateRecord({ board, dir }, ref, toStatus) {
  const to = String(toStatus ?? '').trim();
  if (!to) throw new Error('graduate: a target status is required — graduate <record> <status>');
  const piece = await resolvePiece({ board, dir }, ref);
  if (!piece) throw new Error(`graduate: "${ref}" matches no record`);
  if (piece.kind === 'card') {
    throw new Error(`graduate: "${ref}" is a flow card — a card's status is its stage; move it with transition/commit, not graduate (graduate is for records)`);
  }
  const record = piece.record;
  const def = typeDef(board.manifest, record.type);
  const vocab = vocabTerms(def?.status?.values);
  if (!vocab.length) {
    throw new Error(`graduate: type "${record.type}" declares no status vocabulary — nothing to graduate against`);
  }
  if (!vocab.includes(to)) {
    throw new Error(`graduate: "${to}" is not a valid ${record.type} status — declared: ${vocab.join(', ')}`);
  }
  const field = def.status?.field ?? 'status';
  const from = record.status ?? null;
  if (from === to) return { record, from, to, changed: false }; // already there — no witness, no write
  const event = await board.graduate(record.curie, from, to, { field });
  const abs = resolve(dir, record.path);
  await writeFrontmatterField(abs, field, to); // the store; verified/revised untouched
  return { record, from, to, changed: true, event };
}

// `scope` — assign, reassign, or heal a card's product scope. One verb, one
// invariant: placement follows scope. With a value: set the field (validated
// against the resolved vocabulary) and move the bound doc to the current
// template. Without a value: HEAL — place the bound doc for the card's current
// scope (null → data/cards/ on a scope-declaring board). Idempotent no-op when
// the field and the path are already right. A headless card still takes the
// field (next ensureCardDoc lands in the right place); heal with no doc is a
// teaching error. `unscoped` and `*` are not assignable.
export async function scopeCard({ board, dir }, ref, value) {
  const scopes = resolveScopes(board.manifest, dir);
  if (!scopes) {
    throw new Error('scope: this board declares no scope vocabulary (manifest `scope:`, e.g. scope: apps/*) — the axis is off; there is nothing to assign or place');
  }
  const card = await board.card(ref);
  if (!card) {
    const piece = await resolvePiece({ board, dir }, ref);
    if (piece?.kind === 'record') {
      throw new Error(`scope: "${ref}" is a record — records re-scope via frontmatter scope: + kanbento sweep (this verb is for cards)`);
    }
    throw new Error(`scope: card "${ref}" not found`);
  }
  if (card.archived) throw new Error(`scope: card is archived (${card.disposition ?? 'frozen'}) — read-only`);

  const raw = value == null ? '' : String(value).trim();
  const assign = raw !== '';
  let next = cardScope(card);

  if (assign) {
    if (raw === '*') {
      throw new Error('scope: "*" is star-scope (the whole axis), not a card assignment — a card carries at most one scope; pick a vocabulary id');
    }
    if (raw === 'unscoped') {
      throw new Error('scope: "unscoped" is not assignable — it is the null-queue sentinel. Assign a vocabulary id, or run `kanbento scope <ref>` (no value) to place an unscoped card');
    }
    assertScope(scopes, raw, 'scope');
    next = raw;
  }

  const dest = card.binding?.path ? expectedCardDocPath(board.manifest, card, next) : null;
  const from = cardScope(card);
  const alreadyScoped = from === next;
  const alreadyPlaced = !card.binding?.path || card.binding.path === dest;

  if (!assign && !card.binding?.path) {
    throw new Error(`scope: "${ref}" has no bound doc to place — assign a scope with \`kanbento scope <ref> <s>\` (the field still sets; the next materialize lands in the right place), or elaborate first so there is a doc to move`);
  }
  if (alreadyScoped && alreadyPlaced) {
    return { card, scope: next, from, path: card.binding?.path ?? null, changed: false };
  }

  let path;
  if (card.binding?.path && dest && dest !== card.binding.path) {
    const srcAbs = resolve(dir, card.binding.path);
    const destAbs = resolve(dir, dest);
    if (!existsSync(srcAbs)) {
      throw new Error(`scope: bound doc ${card.binding.path} is missing on disk`);
    }
    if (existsSync(destAbs)) {
      throw new Error(`scope: ${dest} already exists — not overwriting`);
    }
    await mkdir(dirname(destAbs), { recursive: true });
    await rename(srcAbs, destAbs);
    path = dest;
  }

  const updated = await board.scope(card.id, next, { path });
  return { card: updated, scope: next, from, path: path ?? updated.binding?.path ?? null, changed: true };
}

// Apply a refined slug: rename the one bound doc to match when it safely can (a
// single fresh file, never an --all sweep), then re-slug the card. Returns the
// updated card and the new doc path (undefined when the doc stayed put).
//
// Two modes:
//   - default (model auto-sharpener): soft on collision — leave the doc, still
//     sharpen the handle (the slug is advisory; id is the key).
//   - pinned:true (explicit elaborate --slug, mirrors capture --slug): the
//     operator's word is sacred — sanitize via explicitSlug (never cap), a
//     target-path collision fails loudly (never silent uniquify), and the
//     CardSlugged event carries the pinned slug even when overriding a prior pin.
export async function applyReslug({ board, dir }, card, slug, { pinned = false } = {}) {
  if (pinned) slug = explicitSlug(slug); // operator's word: sanitize charset, never silently cap
  let path;
  if (card.binding?.path) {
    const oldRel = card.binding.path;
    const newRel = join(dirname(oldRel), slug + (extname(oldRel) || '.md'));
    if (newRel !== oldRel) {
      if (existsSync(resolve(dir, newRel))) {
        // Pinned collision is loud (capture --slug precedent at embodimentArtifact);
        // model-derived stays soft — leave the doc, still sharpen the handle below.
        if (pinned) throw new Error(`slug "${slug}" is taken — ${newRel} already exists; choose another --slug`);
      } else {
        try {
          await rename(resolve(dir, oldRel), resolve(dir, newRel));
          path = newRel;
        } catch (err) {
          if (pinned) throw err; // pinned: rename failure is the user's problem, not silent
          /* model path: leave the doc; still sharpen the handle */
        }
      }
    }
  }
  const updated = await board.reslug(card.id, slug, { path, pinned });
  return { updated, path };
}

// Fold one card into another and dispose the loser's bound doc. Kernel merge is
// append-only (CardsMerged; the loser folds out of the projection). The file is
// this layer's job, same split as applyReslug.
//
// Empty / frontmatter-only loser docs are deleted. A doc with a real body fails
// loudly and atomically (no event, file untouched) unless discardDoc — unique
// uncommitted prose is not recoverable from git. Never concatenates bodies.
export async function mergeCards({ board, dir }, from, into, { title, discardDoc = false } = {}) {
  const loser = await board.card(from);
  if (!loser) throw new Error(`merge: card "${from}" not found`);
  const rel = loser.binding?.path;
  const abs = rel ? resolve(dir, rel) : null;
  if (abs && existsSync(abs) && !discardDoc) {
    const { body } = await readFrontmatter(abs);
    if (String(body ?? '').trim()) {
      throw new Error(`merge: ${rel} still holds body — fold it into the survivor by hand, or re-run with --discard-doc`);
    }
  }
  const card = await board.merge(from, into, { title });
  let dropped = null;
  if (abs && existsSync(abs)) {
    await unlink(abs);
    dropped = rel;
  }
  return { card, dropped };
}

// Files that claim to be card bound docs: untyped card paths plus embodied flow
// artifacts. Used by lint to find a kanbento_id no live card answers (a merge leftover).
export async function indexCardBoundDocs(manifest, root) {
  const out = [];
  const seen = new Set();
  const take = async (pattern, exclude) => {
    for (const path of await indexDocs(root, pattern, exclude)) {
      if (seen.has(path)) continue;
      seen.add(path);
      let data;
      try {
        ({ data } = await readFrontmatter(join(root, path)));
      } catch {
        continue; // advisory: one corrupt file must not abort the walk
      }
      const id = data?.kanbento_id;
      if (id) out.push({ path, identity: String(id) });
    }
  };
  await take('.kanbento/cards/*.md');
  await take('.kanbento/data/cards/*.md');
  await take('.kanbento/data/*/cards/*.md');
  for (const def of embodiedTypes(manifest).filter(isFlowType)) {
    const { pattern, exclude } = artifactIndex(def);
    await take(pattern, exclude);
  }
  return out;
}

// --- procedures: the third command class (skills / do) ----------------------
// Procedures are records (a `procedure` type, flow:false), not effects: `skills`
// lists them, `do` assembles one into a prompt-shaped brief the invoking agent
// executes with judgment. Assembly lives here (not cli.js) so it's testable against
// a tmp dir without spawning the CLI — the same split as every other verb body.
//
// SETTLED DECISION (do-verbs@91f080e8): the verb SUMMARIES ride the generated guide
// (describeVerbs bakes them in like any verb), but the live procedure LIST does NOT —
// records change without a `compile`, so a baked list would rot. The guide teaches the
// verb; `kanbento skills` is the live index. Keep it that way.
export const PROCEDURE_TYPE = 'procedure';

// The package ships its own procedures (app/procedures/*.md) — kanbento internals,
// not board records: versioned with the tool, refreshed by `upgrade` (the generated-
// guide lifecycle), off any board (no kanbento_id, no status flow). Resolved relative
// to THIS module, never the board dir — they travel with the install, not the repo.
const BUILTIN_PROCEDURES_DIR = fileURLToPath(new URL('../procedures/', import.meta.url));

// Every board-local runnable record, merged across ALL runnable types (each type has
// its own path/embodiment; a record's curie stays <type>:<slug>). Within a type the
// folder-shadows-file rule still applies (localProcedures); ACROSS two runnable types a
// slug collision resolves by declaration order — first-declared runnable type wins
// (deterministic manifest order). Empty when no type is flagged runnable.
async function localRunnables(manifest, dir, opts = {}) {
  const out = [];
  const seen = new Set(); // slug already claimed by an earlier (higher-precedence) runnable type
  for (const def of runnableDefs(manifest)) {
    for (const r of await localProcedures(def, dir, opts)) {
      const slug = parseCurie(r.curie)?.slug;
      if (slug && seen.has(slug)) continue; // an earlier-declared runnable type already owns this slug
      if (slug) seen.add(slug);
      out.push(r);
    }
  }
  return out;
}

// Read the package's built-in procedures into the same record shape indexRecords
// yields (curie, title, status, refs, body) plus a `builtin` marker. Empty if the
// dir is missing. Two shapes: a flat `<slug>.md`, or a `<slug>/procedure.md` folder
// that co-locates scripts alongside the prose (`home` = the folder's absolute path).
// Either way slug = the file's/folder's name; the frontmatter supplies title/status/refs.
export async function readBuiltins() {
  let entries;
  try { entries = await readdir(BUILTIN_PROCEDURES_DIR, { withFileTypes: true }); }
  catch { return []; } // no built-ins shipped (or dir absent) — degrade to board-only
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // A folder built-in materializes when it holds a procedure.md; slug = folder name,
    // home = its absolute path (the anchor the ## Scripts section lists against). A folder
    // without procedure.md is silently skipped — same fail-soft as a missing dir.
    let slug, file, home = null;
    if (e.isDirectory()) {
      const md = join(BUILTIN_PROCEDURES_DIR, e.name, 'procedure.md');
      if (!existsSync(md)) continue;
      slug = e.name; file = md; home = join(BUILTIN_PROCEDURES_DIR, e.name);
    } else {
      if (extname(e.name) !== '.md') continue;
      slug = e.name.slice(0, -extname(e.name).length);
      file = join(BUILTIN_PROCEDURES_DIR, e.name);
    }
    const { data, body } = await readFrontmatter(file);
    out.push({
      path: file, home, identity: `builtin:${slug}`,
      curie: `${PROCEDURE_TYPE}:${slug}`,
      title: data.title ?? slug,
      type: PROCEDURE_TYPE,
      status: data.status ?? null,
      refs: data.refs ?? null,
      cadence: data.cadence ?? null, // the built-in's rhythm, if it declares one — same as a board record
      runner: data.runner ?? null, // the built-in's declared runner grant, if it declares one — same as a board record
      params: data.params ?? null, // declared params — engages the runner (validation + interpolation)
      artifacts: data.artifacts ?? null, // declared run deliverables — validated + disposed at finalize
      sandbox: data.sandbox ?? null, // --exec sandbox grants — merged over the floor
      workspace: data.workspace ?? null, // intake mode: fs (default) | worktree — the runner materializes a git checkout + diff-for-free
      lineage: data.lineage ?? null, // observe-capture source template
      builtin: true,
      body,
    });
  }
  return out;
}

// The harness directories we probe for inbound agent skills — the SEED OF THE ADAPTER
// REGISTRY. Each agent harness (Claude, Codex, Cursor, Grok, …) parks skills under its own
// convention dir; the bare `skills/` is the generic fallback, safe because we only admit a
// subfolder that holds a SKILL.md. Probe order is precedence order: on a slug collision the
// FIRST dir wins (the symlink convention parks one skill under several harness dirs at once).
export const HARNESS_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
  '.grok/skills',
  'skills',
];

// Discover agent skills living in harness directories under the board root `dir`, into the
// same record shape readBuiltins yields — so `procedures`/`do` serve them with ZERO install.
// A skill is a subfolder holding a SKILL.md; slug = folder name; title = frontmatter `name`
// (folder name if absent). Deduped by slug across probe dirs (first dir wins) AND by the
// SKILL.md's realpath (the symlink convention fans one file across many dirs). A probe dir
// that is a symlink resolving INTO the store is skipped, so a future OUTBOUND projection
// (a skills/ symlink into .kanbento) is never re-discovered as inbound. Fail-soft throughout:
// a missing/unreadable dir or file is silently skipped, same posture as readBuiltins.
export async function readHarnessSkills(dir) {
  // Realpath the store so the symlink-into-store guard compares resolved paths on both sides
  // (a tmpdir like /var → /private/var would otherwise never match). Fail-soft to the plain path.
  const store = await realpath(resolve(dir, '.kanbento')).catch(() => resolve(dir, '.kanbento'));
  const out = [];
  const bySlug = new Set(); // slug already claimed by an earlier (higher-precedence) probe dir
  const byReal = new Set(); // SKILL.md realpath already served (symlink fan-out across dirs)
  for (const probe of HARNESS_SKILL_DIRS) {
    const base = resolve(dir, probe);
    // A probe dir that is a symlink pointing into the store is an outbound projection, not an
    // inbound source — never double-discover it. (realpath throws on a non-symlink/missing path;
    // that just means probe it normally.)
    try {
      const real = await realpath(base);
      if (real === store || real.startsWith(store + sep)) continue;
    } catch { /* not a symlink into the store — probe normally */ }
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch { continue; } // missing / unreadable dir — degrade to the other probe dirs
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue; // a bare file is not a skill folder
      const slug = e.name;
      if (bySlug.has(slug)) continue; // an earlier probe dir already owns this slug
      const skillMd = join(base, slug, 'SKILL.md');
      if (!existsSync(skillMd)) continue; // a folder without SKILL.md is silently skipped
      let realMd;
      try { realMd = await realpath(skillMd); } catch { realMd = skillMd; }
      if (byReal.has(realMd)) continue; // same file reached via a symlink under another slug/dir
      let parsed;
      try { parsed = await readFrontmatter(skillMd); } catch { continue; } // unreadable — skip
      const { data, body } = parsed;
      bySlug.add(slug); byReal.add(realMd);
      out.push({
        path: skillMd, home: join(base, slug),
        identity: `harness:${probe}/${slug}`,
        curie: `skill:${slug}`, // a skill: CURIE — bare-slug and CURIE matching both fall out for free
        title: data.name ?? slug,
        description: data.description ?? null, // carried for provenance; not otherwise required
        type: 'skill',
        status: null, // a harness skill has no kanbento status axis (trial/trusted is for our procedures)
        refs: data.refs ?? null,
        cadence: data.cadence ?? null,
        runner: data.runner ?? null,
        params: data.params ?? null, // declared params — engages the runner (validation + interpolation)
        artifacts: data.artifacts ?? null, // declared run deliverables — validated + disposed at finalize
        sandbox: data.sandbox ?? null, // --exec sandbox grants — merged over the floor
        workspace: data.workspace ?? null, // intake mode: fs (default) | worktree — the runner materializes a git checkout + diff-for-free
        lineage: data.lineage ?? null, // observe-capture source template
        harness: probe, // the probe dir it was found under (e.g. '.grok/skills') — the origin badge
        body,
      });
    }
  }
  return out;
}

// Discover the board's FOLDER-FORM procedures: .kanbento/procedures/<slug>/SKILL.md —
// the mini-app shape (frontmatter in SKILL.md, same schema as the file form; a sibling
// hooks/init and any scripts/references ride along in the folder). The base dir derives
// from the declared type's path template (the prefix before {slug}), so a board that
// relocates its procedures keeps both forms co-located. Record discovery (indexRecords)
// globs only *.md files, so lint/sync/map/sweep simply never see a folder procedure —
// this reader is the accommodation, feeding listSkills/resolveProcedure directly.
// Fail-soft like readBuiltins: a folder without SKILL.md is silently skipped.
// `home` is ABSOLUTE (hooks + the run-dir copy resolve against it); `folder: true`
// is the runner's gate.
export async function readFolderProcedures(def, dir) {
  const cut = (def?.path ?? '').indexOf('{slug}');
  if (cut < 0) return []; // no {slug} template — nowhere to look for folder siblings
  const base = def.path.slice(0, cut); // e.g. '.kanbento/procedures/'
  let entries;
  try { entries = await readdir(resolve(dir, base), { withFileTypes: true }); }
  catch { return []; } // no procedures dir yet — nothing authored
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const home = resolve(dir, base, e.name);
    const md = join(home, 'SKILL.md');
    if (!existsSync(md)) continue;
    const { data, body } = await readFrontmatter(md);
    out.push({
      path: join(base, e.name, 'SKILL.md'),
      home,
      identity: data[def.identity ?? 'kanbento_id'] ?? join(base, e.name),
      curie: `${def.id}:${e.name}`,
      // The frontmatter is a UNION of vocabularies (kanbento record keys + Agent Skills
      // keys like name/description/allowed-tools) — unknown keys are tolerated and, since
      // the run-dir copy is a byte-for-byte fs.cp and nothing rewrites SKILL.md, preserved.
      // Display falls back to the Agent Skills `name` when no kanbento `title` is set.
      title: data.title ?? data.name ?? e.name,
      description: data.description ?? null,
      type: def.id,
      status: data[def.status?.field ?? 'status'] ?? null,
      verified: data.verified ?? null,
      revised: data.revised ?? null,
      refs: data.refs ?? null,
      cadence: data.cadence ?? null,
      runner: data.runner ?? null,
      params: data.params ?? null,
      artifacts: data.artifacts ?? null, // declared run deliverables — validated + disposed at finalize
      sandbox: data.sandbox ?? null, // --exec sandbox grants — merged over the floor
      workspace: data.workspace ?? null, // intake mode: fs (default) | worktree — the runner materializes a git checkout + diff-for-free
      lineage: data.lineage ?? null, // observe-capture source template
      folder: true, // folder-form — `do` engages the runner (run dir, hooks, interpolation)
      marker: 'SKILL.md',
      body,
    });
  }
  return out;
}

// The board's local procedures, both forms merged: a folder (<slug>/SKILL.md) SHADOWS
// a same-slug file (<slug>.md) — `do` resolves the folder form first, the file form
// is the unchanged legacy fallback.
async function localProcedures(def, dir, { withBody = false } = {}) {
  if (!def) return [];
  const folders = await readFolderProcedures(def, dir);
  const folderSlugs = new Set(folders.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  const files = (await indexRecords(def, dir, { withBody })).filter((r) => !folderSlugs.has(parseCurie(r.curie)?.slug));
  return [...folders, ...files];
}

// Every file co-located under a folder record's `home`, except its marker (procedure.md for a
// folder built-in, SKILL.md for a harness skill) — the scripts/files the brief points the runner
// at. Recursive, sorted, returned as { rel, abs } (relative to home for reading, absolute for
// running). Fail-soft: an unreadable home yields nothing (the section just omits).
async function folderFiles(home, marker = 'procedure.md') {
  const out = [];
  const walk = async (rel) => {
    let ents;
    try { ents = await readdir(join(home, rel), { withFileTypes: true }); }
    catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? join(rel, e.name) : e.name;
      if (!rel && e.name === 'hooks' && e.isDirectory()) continue; // runner machinery (hooks/init runs automatically) — not a script for the consumer
      if (e.isDirectory()) { await walk(r); continue; }
      if (!rel && e.name === marker) continue; // the prose itself, not a co-located file
      out.push({ rel: r, abs: join(home, r) });
    }
  };
  await walk('');
  return out;
}

// Parse a procedure's `cadence:` frontmatter into { kind, n }. Two forms:
//   '50 commits' — evidence-time: due when N commits have landed since the last run
//                  (a dormant repo accrues no due-ness — the preferred heartbeat)
//   '14d'        — calendar days: due when N days have elapsed since the last run
// Absent or unparseable → null: the procedure is listed, never "due" (no cadence,
// no heartbeat).
export function parseCadence(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^(\d+)\s*commits?$/);
  if (m) return { kind: 'commits', n: Number(m[1]) };
  m = s.match(/^(\d+)\s*d(ays?)?$/);
  if (m) return { kind: 'days', n: Number(m[1]) };
  return null;
}

// Is a procedure due? Due = a cadence is declared AND exceeded since the last run.
// No cadence, or never run, → not due (never-ran is its own state, not overdue —
// there's no baseline to exceed). Calendar math for '<n>d'; a commit count for
// '<n> commits' via git (fail-soft — no repo degrades to not-due, never an error).
async function procedureDue(cadence, lastRan, dir, nowMs = Date.now()) {
  if (!cadence || !lastRan) return false;
  const since = new Date(lastRan).getTime();
  if (!Number.isFinite(since)) return false;
  if (cadence.kind === 'days') return nowMs - since >= cadence.n * 86400000;
  if (cadence.kind === 'commits') {
    try {
      const { stdout } = await execFileP('git', ['rev-list', '--count', `--since=${lastRan}`, 'HEAD'], { cwd: dir });
      const count = Number(stdout.trim());
      return Number.isFinite(count) && count >= cadence.n;
    } catch {
      return false; // no git / not a repo — a commit cadence has no evidence to read, so not due
    }
  }
  return false;
}

// Fold the log's ProcedureInvoked events into curie -> ISO of the LATEST invocation (later
// events win — the register read model behind the last-ran/due column).
function lastRuns(events) {
  const runs = new Map();
  for (const e of events) if (e.type === 'ProcedureInvoked' && e.curie) runs.set(e.curie, e.at);
  return runs;
}

// List the board's procedures — one entry per file, slug-sorted:
// { curie, slug, status, title, builtin, lastRan, due }. Local-first: board records
// SHADOW a built-in of the same slug (the install-a-workflow precedent — ship, then
// let the board own its override). Empty when the type is undeclared; when declared,
// the built-ins ride the type even with no board records authored yet. lastRan/due
// fold the ProcedureInvoked log against each record's `cadence:`.
export async function listSkills({ board, dir }) {
  // Built-ins are versioned with the tool and ride ANY board — even one that declares no
  // runnable type. Only board-local records need a runnable type (nothing to index
  // without one). A local record still SHADOWS a same-slug built-in when a runnable type
  // IS declared. Discovered across EVERY runnable type, not the hardcoded `procedure`.
  const local = await localRunnables(board.manifest, dir); // all runnable types; folder shadows same-slug file within each
  const localSlugs = new Set(local.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  // Three tiers, slug-keyed: local procedure records > harness skills > built-ins. A harness
  // skill shadows a same-slug built-in; a local record shadows both (the install-a-workflow
  // precedent — ship/discover, then let the board own its override).
  const harness = (await readHarnessSkills(dir)).filter((h) => !localSlugs.has(parseCurie(h.curie).slug));
  const harnessSlugs = new Set(harness.map((h) => parseCurie(h.curie).slug));
  const builtins = (await readBuiltins()).filter((b) => {
    const slug = parseCurie(b.curie).slug;
    return !localSlugs.has(slug) && !harnessSlugs.has(slug);
  });
  const runs = lastRuns(await board.events());
  const out = [];
  for (const r of [...local.map((r) => ({ ...r, builtin: false })), ...harness, ...builtins]) {
    const lastRan = runs.get(r.curie) ?? null;
    const slug = parseCurie(r.curie)?.slug ?? null;
    out.push({
      curie: r.curie,
      slug,
      status: r.status ?? null,
      title: r.title,
      builtin: !!r.builtin,
      harness: r.harness ?? null, // the harness dir a discovered skill rode in on (null for locals/builtins)
      lastRan, // ISO of the latest ProcedureInvoked for this curie, or null (never invoked)
      due: await procedureDue(parseCadence(r.cadence), lastRan, dir),
      schedule: await readScheduleState(slug, board.manifest?.board?.id, dir), // this board's OS-scheduler stamp, if registered
      runs: slug ? await runWitness(dir, slug) : { count: 0, last: null }, // runner invocations witnessed under .kanbento/runs/<slug>/
    });
  }
  return out.sort((a, b) => (a.slug ?? a.curie ?? '').localeCompare(b.slug ?? b.curie ?? ''));
}

// CURIEs the runner can resolve (board-local runnables ▸ harness skills ▸ package
// built-ins), same three-tier shadow chain as listSkills/resolveProcedure. Used by
// lint's dangling check so a plan's `about procedure:replenish` is not a false
// positive when replenish is a package built-in (story:lint-builtin-procedure-refs).
// Local same-slug records shadow harness and built-ins (one curie in the set).
export async function runnableKnownCuries(manifest, dir) {
  const local = await localRunnables(manifest, dir);
  const localSlugs = new Set(local.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  const harness = (await readHarnessSkills(dir)).filter((h) => !localSlugs.has(parseCurie(h.curie).slug));
  const harnessSlugs = new Set(harness.map((h) => parseCurie(h.curie).slug));
  const builtins = (await readBuiltins()).filter((b) => {
    const slug = parseCurie(b.curie).slug;
    return !localSlugs.has(slug) && !harnessSlugs.has(slug);
  });
  return new Set([...local, ...harness, ...builtins].map((r) => r.curie).filter(Boolean));
}

// Resolve a procedure <name> (CURIE or bare slug) to its record — board-first, then
// the package built-ins (a local record shadows a same-slug built-in). Shared by `do`
// (assembleBrief) and `did` (registerRun) so both resolve identically and error the
// same teaching way on an unknown name. withBody so a brief renderer gets the text.
export async function resolveProcedure({ board, dir }, name, { verb = 'do' } = {}) {
  // Built-ins resolve on ANY board (they ship with the tool). Only board-local records
  // need a runnable type; a local record shadows a same-slug built-in. Resolved across
  // EVERY runnable type, not the hardcoded `procedure` — a wider search set, same mechanics.
  const local = await localRunnables(board.manifest, dir, { withBody: true }); // all runnable types; folder shadows same-slug file within each
  const localSlugs = new Set(local.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  // Same three-tier shadow chain as listSkills: local records > harness skills > built-ins.
  // Harness skills resolve on ANY board (like built-ins — a `skill:` CURIE, no declared type).
  const harness = (await readHarnessSkills(dir)).filter((h) => !localSlugs.has(parseCurie(h.curie).slug));
  const harnessSlugs = new Set(harness.map((h) => parseCurie(h.curie).slug));
  const builtins = (await readBuiltins()).filter((b) => {
    const slug = parseCurie(b.curie).slug;
    return !localSlugs.has(slug) && !harnessSlugs.has(slug);
  });
  const curie = parseCurie(name);
  const match = (recs) => recs.filter((r) => (curie ? r.curie === name : r.curie?.endsWith(`:${name}`) || r.curie === name));
  // board-first: a local record shadows a harness skill / built-in of the same slug — resolve
  // against the board, fall through to harness skills, then built-ins, in precedence order.
  let matches = match(local);
  if (!matches.length) matches = match(harness);
  if (!matches.length) matches = match(builtins);
  if (matches.length > 1) throw new Error(`${verb}: "${name}" is ambiguous — ${matches.map((m) => m.curie).join(', ')}`);
  if (!matches.length) {
    const avail = [...local, ...harness, ...builtins].map((r) => r.curie).filter(Boolean).sort();
    throw new Error(
      `${verb}: "${name}" matches no procedure — ${avail.length ? `available: ${avail.join(', ')}` : 'none authored yet (write one with `kanbento note --type procedure`)'}`,
    );
  }
  return matches[0];
}


// Every `case:<slug>` CURIE mentioned in a record's refs AND its body — the
// knowing-when the brief pulls in. De-duplicated, refs before body-only mentions.
function caseCuriesIn(rec) {
  const seen = new Set();
  const out = [];
  const add = (curie) => { if (parseCurie(curie)?.type === 'case' && !seen.has(curie)) { seen.add(curie); out.push(curie); } };
  for (const e of refEdges(rec.refs)) add(e.curie);
  for (const m of String(rec.body ?? '').matchAll(/\bcase:[a-z0-9][a-z0-9-]*/gi)) add(m[0]);
  return out;
}

// Assemble a procedure for serving: header (title · status, a loud warning
// when deprecated), the body verbatim, a Precedents section carrying each resolvable
// case file's content (the knowing-when), and a footer of the record's other refs as
// pointers. Resolves <name> by CURIE or bare slug, mirroring resolvePiece's idiom.
// Returns { record, text, cases, pointers } so a test can assert on the parts.
// `record` (optional) skips re-resolution — the runner passes the already-resolved
// record back with its ${...} slots interpolated, keeping the served shape identical.
export async function assembleProcedure({ board, dir }, name, { record = null } = {}) {
  const rec = record ?? await resolveProcedure({ board, dir }, name);
  const deprecated = rec.status === 'deprecated';

  // Pull the content of every case file the procedure cites (refs or body). A CURIE that
  // doesn't resolve to a file on disk is skipped — the output carries what's grounded.
  const cases = [];
  for (const cc of caseCuriesIn(rec)) {
    const slug = parseCurie(cc).slug;
    const abs = join(casesDir(dir), `${slug}.md`);
    if (existsSync(abs)) cases.push({ curie: cc, content: (await readFile(abs, 'utf8')).trim() });
  }

  // The other refs (not the cases, which the Precedents section already carried) become
  // footer pointers — where to look next, resolved to a path when the type embodies one.
  const caseSet = new Set(cases.map((c) => c.curie));
  const pointers = refEdges(rec.refs)
    .filter((e) => !caseSet.has(e.curie) && parseCurie(e.curie)?.type !== 'case')
    .map((e) => {
      const t = refTarget(board.manifest, e.curie);
      const where = t.path ? (existsSync(resolve(dir, t.path)) ? t.path : `${t.path} (unresolved)`) : null;
      return { rel: e.rel, curie: e.curie, where };
    });

  const isSkill = rec.type === 'skill';
  const out = [];
  out.push(`# ${rec.title}`);
  // A harness skill shows its inbound provenance (skill @ <harness>/<slug>) in place of the
  // trial/trusted status a kanbento procedure carries — a skill has no such status axis.
  if (isSkill) out.push(`${rec.curie} · skill @ ${rec.harness}/${parseCurie(rec.curie).slug}`);
  else out.push(`procedure: ${rec.curie}${rec.status ? ` · status: ${rec.status}` : ''}`);
  if (deprecated) out.push('', '⚠ DEPRECATED — do NOT follow this procedure as-is; it has been superseded. See its replacement before acting.');
  out.push('', String(rec.body ?? '').trim());
  // A folder record ships co-located files next to the prose — list them so the executing agent
  // can find them. A folder built-in calls them Scripts (deterministic extraction, run verbatim);
  // a harness skill calls them Files (ENVIRONMENT.md, scripts/, … read/run as the skill directs).
  if (rec.home) {
    const files = await folderFiles(rec.home, rec.marker ?? (isSkill ? 'SKILL.md' : 'procedure.md'));
    if (files.length) {
      if (isSkill) out.push('', '## Files', '', 'Co-located files in the skill folder — read or run them as the skill directs (e.g. ENVIRONMENT.md, scripts/).');
      else out.push('', '## Scripts', '', 'Co-located scripts — run them verbatim (they exist so extraction is deterministic); do not reimplement them.');
      for (const f of files) out.push(`- ${f.rel} — ${f.abs}`);
    }
  }
  if (cases.length) {
    out.push('', '## Precedents', '', '_The knowing-when: precedents this procedure cites. Weigh each against the situation before acting._');
    for (const c of cases) out.push('', `### ${c.curie}`, '', c.content);
  }
  if (pointers.length) {
    out.push('', '## Pointers', '');
    for (const p of pointers) out.push(`- ${p.rel}  ${p.curie}${p.where ? `  → ${p.where}` : ''}`);
  }
  // A scheduled routine advertises its rhythm — cadence, time-of-day, last run, and the
  // plist backing it — so the served brief carries its own operating status.
  const sched = await readScheduleState(parseCurie(rec.curie)?.slug, board.manifest?.board?.id, dir);
  if (sched) {
    out.push('', '## Schedule', '', 'Registered with the OS scheduler (launchd) — fires daily; the guard enforces the cadence window.');
    out.push(`- cadence: ${sched.cadence}`);
    out.push(`- at: ${sched.at}`);
    out.push(`- last run: ${sched.lastRun ?? 'never'}`);
    if (sched.grant) out.push(`- grant: ${grantSummary(sched.grant)}`); // the frozen runner grant — what --fire will hand the harness
    out.push(`- plist: ${sched.plist}`);
  }
  // The epistemic contract travels with the served procedure, status-aware: deviation is a
  // contradiction detector (instruction vs context can't both be right), not
  // disobedience — a draft invites deviation-plus-report (it's on trial); a trusted
  // procedure asks for escalation first. Deprecated already warned above the body. A harness
  // skill is external code with no kanbento status axis — the trial/trusted contract is about
  // OUR authored procedures, so it does not apply (the skill's own body governs it).
  if (!deprecated && !isSkill) {
    out.push('', '---', '');
    out.push(
      rec.status === 'trusted'
        ? '_This procedure is **trusted**. Deviation should be rare: if actual board state contradicts these instructions, report it and escalate before acting against them._'
        : '_This procedure is **on trial**. If actual board state contradicts these instructions, the deviation is a **finding** — report the contradiction explicitly; it revises the procedure._',
    );
  }
  return { record: rec, text: out.join('\n') + '\n', cases, pointers };
}

// Catch-up sync over every EMBODIED type — discovered through the shared
// `embodiedTypes` (the one source of truth), not a private re-filter that quietly
// dropped record types and the builtin note (the bug that reported "no embodied
// types to sync" while capability/strategy sat right there). Flow types reconcile
// into the card store (read) or push board state back to frontmatter (write). Record
// types (flow:false) are FS-owned knowledge — never cards; sync walks them so the
// corpus is visible, but reconciliation is file-resolution (sweep enriches them),
// so nothing enters the card store. Returns one result per type that has artifacts.
export async function syncBoard({ board }, root, { write = false } = {}) {
  const results = [];
  for (const def of embodiedTypes(board.manifest)) {
    if (isFlowType(def)) {
      if (write) {
        const cards = (await board.pool()).filter((c) => c.binding && c.type === def.id);
        results.push({ id: def.id, mode: 'write', pushed: await writeBack(cards, def, root) });
      } else {
        const docs = await readType(def, root);
        const r = await board.sync(docs);
        results.push({ id: def.id, mode: 'read', indexed: docs.length, ...r });
      }
    } else {
      const recs = await indexRecords(def, root);
      if (recs.length) results.push({ id: def.id, mode: 'record', indexed: recs.length });
    }
  }
  return results;
}
