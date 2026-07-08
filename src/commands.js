import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rename, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { refsFromArgs, resolveRelKey, parseCurie, checkRelationStrict, refEdges, refTarget } from './refs.js';
import { typeDef, isFlowType, BUILTIN_NOTE, embodiedTypes, vocabTerms } from './manifest.js';
import { slugify, titleSlug } from './slug.js';
import { readType, writeBack, indexRecords } from './binding.js';
import { casesDir } from './cases.js';
import { writeFrontmatterBlock, writeFrontmatterField, removeFrontmatterField, readFrontmatter } from './frontmatter.js';

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
    const [k, v] = p.split('=');
    if (k && v) lane[k] = v;
  }
  return Object.keys(lane).length ? lane : undefined;
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

// Capture one item: mint the card, materialize a typed artifact (born tracked), and
// bind a doc when the body is rich (the one-step capture + elaborate). Returns
// { card, artifact, boundDoc } for the caller to present.
export async function captureCard({ board, dir }, body, opts = {}) {
  if (!body.trim()) throw new Error('capture: no text — pass inline text, -F <file>, or pipe stdin');
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
  const artifactSlug = opts.slug || (derive ? titleSlug(firstLine) : id.slice(0, 8)); // names the artifact file
  // Validate everything that can fail (the --rel shape, an explicit-slug collision)
  // BEFORE the capture event or the artifact write — a failed verb leaves no trace.
  const payload = capturePayload(opts, board.manifest); // throws on a malformed --rel pair
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
    slug: opts.slug ? slugify(opts.slug) : undefined,
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

// Should `sweep` refresh a record's `revised:` edit clock? PURE — the day-granular
// staleness test behind the mtime-driven refresh: a file modified after the day it
// was stamped (or never stamped) is stale. Idempotent by construction: a restamp
// sets revised=today and mtime≈now (same day), so an unchanged record — mtimeDay <=
// revisedDay — is never touched again. Accepts a string or a js-yaml Date for `revised`.
export function revisedStale(revised, mtimeMs) {
  const revisedDay = revised instanceof Date
    ? revised.toISOString().slice(0, 10)
    : typeof revised === 'string' ? revised.slice(0, 10) : null;
  if (revisedDay == null) return true; // never stamped — a hand-created/edited record
  return new Date(mtimeMs).toISOString().slice(0, 10) > revisedDay;
}

export async function noteCard({ board, dir }, body, opts = {}) {
  const text = (body ?? '').trim();
  if (!text) throw new Error('note: no content (inline text, -F <file>, or piped stdin)');
  const typeId = opts.type ?? BUILTIN_NOTE.id;
  const def = typeDef(board.manifest, typeId); // resolves the builtin note too (the chokepoint)
  if (!def) throw new Error(`note: type "${typeId}" is not declared`);
  if (isFlowType(def)) throw new Error(`note: "${typeId}" is a flow type — it mints a card with a status; use capture`);
  if (!def.embodiment || def.embodiment === 'none') throw new Error(`note: type "${typeId}" has no embodiment — nowhere to write`);
  const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim();
  const id = randomUUID();
  // Validate every arg that can fail BEFORE touching the filesystem, so a bad --rel
  // (or a swallowed positional token) never leaves an orphan file behind (atomicity).
  const refs = namespacedRefs(refsFromArgs(opts.rel), board.manifest); // throws on a malformed --rel pair
  // No reslug pipeline here (no card, no event) — the file needs its name NOW,
  // so the heuristic slug applies regardless of features.slugify. An explicit
  // --slug is pinned: a collision fails loudly rather than silently uniquifying.
  const slug = opts.slug || titleSlug(firstLine) || id.slice(0, 8);
  const artifact = embodimentArtifact(def, slug, id, dir, {}, { pinned: !!opts.slug });
  const abs = resolve(dir, artifact.path);
  await mkdir(dirname(abs), { recursive: true });
  const front = { kanbento_id: id, title: opts.title ?? firstLine };
  if (opts.type) front.type = def.id; // a typed record self-describes; a bare note stays type-less
  if (def.status?.values) front[def.status.field ?? 'status'] = vocabTerms(def.status.values)[0]; // seed the lifecycle at its first declared state (capability -> idea)
  await writeFile(abs, `${newFrontmatter(front)}${text}\n`, 'utf8');
  if (refs && Object.keys(refs).length) await writeFrontmatterBlock(abs, 'refs', refs);
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
    const target = to.kind === 'card'
      ? (to.card.type && to.card.slug ? `${to.card.type}:${to.card.slug}` : to.card.slug ?? to.card.id)
      : to.record.curie;
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
  const target = to.kind === 'card' ? `${to.card.type}:${to.card.slug}` : to.record.curie;
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
    if (to) resolved = to.kind === 'card'
      ? (to.card.type && to.card.slug ? `${to.card.type}:${to.card.slug}` : to.card.slug ?? to.card.id)
      : to.record.curie;
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
export async function ensureCardDoc({ board, dir }, card, body = '') {
  let rel = card.binding?.path;
  if (rel) return rel;
  const doc = embodimentArtifact({ embodiment: 'file', path: '.kanbento/cards/{slug}.md' }, card.slug ?? card.id.slice(0, 8), card.id, dir, {});
  rel = doc.path;
  const abs = resolve(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${newFrontmatter({ kanbento_id: card.id, title: card.title })}${body.trim() ? body.trim() + '\n' : ''}`, 'utf8');
  await board.bind(card.id, rel); // append-only: the card now has a doc
  return rel;
}

// Give a card a body: materialize its doc on demand and (when content is given)
// overwrite it. --title corrects the card's title in the same breath — titles
// rot as understanding improves, and elaboration is exactly when they do; a
// CardRetitled event lands the correction (titles are log-owned) and the doc's
// frontmatter follows. Returns { card, rel, wrote, retitled } — with empty
// content the doc is only ensured, for the caller's interactive $EDITOR path.
export async function elaborateCard({ board, dir }, ref, content = '', { title } = {}) {
  let card = await board.card(ref);
  if (!card) {
    // A record (a knowledge piece — e.g. a capability position) can be elaborated
    // too, but it ACCRETES: append to its body, never overwrite the knowledge, and
    // there's no title correction (a record is titled in its own frontmatter).
    const piece = await resolvePiece({ board, dir }, ref);
    if (piece?.kind === 'record') {
      if (title?.trim()) throw new Error('elaborate: --title is a card-only correction; a record is titled in its frontmatter');
      const relPath = piece.record.path;
      if (!content.trim()) return { record: piece.record, rel: relPath, wrote: false };
      const abs = resolve(dir, relPath);
      const prev = await readFile(abs, 'utf8');
      await writeFile(abs, `${prev.replace(/\s+$/, '')}\n\n${content.trim()}\n`, 'utf8');
      await writeFrontmatterField(abs, 'revised', revisionStamp()); // revisiting resets the freshness clock
      return { record: piece.record, rel: relPath, wrote: true };
    }
    throw new Error(`elaborate: "${ref}" not found`);
  }
  const retitled = !!(title?.trim() && title.trim() !== card.title);
  if (retitled) card = await board.retitle(card.id, title.trim());
  const rel = await ensureCardDoc({ board, dir }, card);
  if (content.trim()) {
    await writeFile(resolve(dir, rel), `${newFrontmatter({ kanbento_id: card.id, title: card.title })}${content.trim()}\n`, 'utf8');
  } else if (retitled) {
    await writeFrontmatterField(resolve(dir, rel), 'title', JSON.stringify(card.title)); // title-only: the doc's frontmatter follows, the body stays
  }
  return { card, rel, wrote: !!content.trim(), retitled };
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

// Apply a refined slug: rename the one bound doc to match when it safely can (a
// single fresh file, never an --all sweep), then re-slug the card. Returns the
// updated card and the new doc path (undefined when the doc stayed put).
export async function applyReslug({ board, dir }, card, slug) {
  let path;
  if (card.binding?.path) {
    const oldRel = card.binding.path;
    const newRel = join(dirname(oldRel), slug + (extname(oldRel) || '.md'));
    if (newRel !== oldRel && !existsSync(resolve(dir, newRel))) {
      try { await rename(resolve(dir, oldRel), resolve(dir, newRel)); path = newRel; } catch { /* leave the doc; still sharpen the handle */ }
    }
  }
  const updated = await board.reslug(card.id, slug, { path });
  return { updated, path };
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

function procedureDef(manifest) {
  const def = typeDef(manifest, PROCEDURE_TYPE);
  return def && def.embodiment && def.embodiment !== 'none' ? def : null;
}

// Read the package's built-in procedures into the same record shape indexRecords
// yields (curie, title, status, refs, body) plus a `builtin` marker. Empty if the
// dir is missing. Slug = filename; the file's frontmatter supplies title/status/refs.
async function readBuiltins() {
  let files;
  try { files = await readdir(BUILTIN_PROCEDURES_DIR); }
  catch { return []; } // no built-ins shipped (or dir absent) — degrade to board-only
  const out = [];
  for (const f of files.sort()) {
    if (extname(f) !== '.md') continue;
    const slug = f.slice(0, -extname(f).length);
    const { data, body } = await readFrontmatter(join(BUILTIN_PROCEDURES_DIR, f));
    out.push({
      path: f, home: f, identity: `builtin:${slug}`,
      curie: `${PROCEDURE_TYPE}:${slug}`,
      title: data.title ?? slug,
      type: PROCEDURE_TYPE,
      status: data.status ?? null,
      refs: data.refs ?? null,
      cadence: data.cadence ?? null, // the built-in's rhythm, if it declares one — same as a board record
      builtin: true,
      body,
    });
  }
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
  const def = procedureDef(board.manifest);
  if (!def) return [];
  const local = await indexRecords(def, dir);
  const localSlugs = new Set(local.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  const builtins = (await readBuiltins()).filter((b) => !localSlugs.has(parseCurie(b.curie).slug));
  const runs = lastRuns(await board.events());
  const out = [];
  for (const r of [...local.map((r) => ({ ...r, builtin: false })), ...builtins]) {
    const lastRan = runs.get(r.curie) ?? null;
    out.push({
      curie: r.curie,
      slug: parseCurie(r.curie)?.slug ?? null,
      status: r.status ?? null,
      title: r.title,
      builtin: !!r.builtin,
      lastRan, // ISO of the latest ProcedureInvoked for this curie, or null (never invoked)
      due: await procedureDue(parseCadence(r.cadence), lastRan, dir),
    });
  }
  return out.sort((a, b) => (a.slug ?? a.curie ?? '').localeCompare(b.slug ?? b.curie ?? ''));
}

// Resolve a procedure <name> (CURIE or bare slug) to its record — board-first, then
// the package built-ins (a local record shadows a same-slug built-in). Shared by `do`
// (assembleBrief) and `did` (registerRun) so both resolve identically and error the
// same teaching way on an unknown name. withBody so a brief renderer gets the text.
async function resolveProcedure({ board, dir }, name, { verb = 'do' } = {}) {
  const def = procedureDef(board.manifest);
  const local = def ? await indexRecords(def, dir, { withBody: true }) : [];
  const localSlugs = new Set(local.map((r) => parseCurie(r.curie)?.slug).filter(Boolean));
  const builtins = def ? (await readBuiltins()).filter((b) => !localSlugs.has(parseCurie(b.curie).slug)) : [];
  const curie = parseCurie(name);
  const match = (recs) => recs.filter((r) => (curie ? r.curie === name : r.curie?.endsWith(`:${name}`) || r.curie === name));
  // board-first: a local record shadows a built-in of the same slug — resolve against
  // the board, and only fall through to the built-ins when nothing local matched.
  let matches = match(local);
  if (!matches.length) matches = match(builtins);
  if (matches.length > 1) throw new Error(`${verb}: "${name}" is ambiguous — ${matches.map((m) => m.curie).join(', ')}`);
  if (!matches.length) {
    const avail = [...local, ...builtins].map((r) => r.curie).filter(Boolean).sort();
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
export async function assembleProcedure({ board, dir }, name) {
  const rec = await resolveProcedure({ board, dir }, name);
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

  const out = [];
  out.push(`# ${rec.title}`);
  out.push(`procedure: ${rec.curie}${rec.status ? ` · status: ${rec.status}` : ''}`);
  if (deprecated) out.push('', '⚠ DEPRECATED — do NOT follow this procedure as-is; it has been superseded. See its replacement before acting.');
  out.push('', String(rec.body ?? '').trim());
  if (cases.length) {
    out.push('', '## Precedents', '', '_The knowing-when: precedents this procedure cites. Weigh each against the situation before acting._');
    for (const c of cases) out.push('', `### ${c.curie}`, '', c.content);
  }
  if (pointers.length) {
    out.push('', '## Pointers', '');
    for (const p of pointers) out.push(`- ${p.rel}  ${p.curie}${p.where ? `  → ${p.where}` : ''}`);
  }
  // The epistemic contract travels with the served procedure, status-aware: deviation is a
  // contradiction detector (instruction vs context can't both be right), not
  // disobedience — a draft invites deviation-plus-report (it's on trial); a trusted
  // procedure asks for escalation first. Deprecated already warned above the body.
  if (!deprecated) {
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
