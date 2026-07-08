import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stages, commitStageId, nextStageId, lanes, laneValue, portfolioTypes, typeDef, vocabTerms } from './manifest.js';
import { GLYPH, DISPOSITIONS } from './protocol.js';

// A file-based projection of board state — the materialized READ model.
//
// The JSONL log is the WRITE model (commands -> events); this markdown is the
// READ model. Agents orient by reading it natively (`cat`, `grep`), humans read
// it too, and the read path needs no query tool — the filesystem is the API.
//
// It is DERIVED: the log is the source of truth. A verb re-folds the log before
// it mutates — never this file — so a momentarily stale render can never cause a
// bad write; the next event heals it.
//
// BOARD.md is a FOCUS view: the committed flow in full, in normal intake->delivery
// order. The two unbounded ends collapse into linked derived views so the main
// file stays scannable — the pre-commit pool -> POOL.md, the delivered history
// (past the most recent few) -> DONE.md. The board renders STATE; what to act on
// next is the operator's call, not the board's — an agent out-reasons a fixed
// heuristic, so the dropped "→ Next" orient is not the board's to compute.

const DONE_LIMIT = 5; // BOARD.md shows this many recent done cards; the rest -> DONE.md

// Split the stages into the three display zones: pre-commit (collapsed), the
// committed middle (commit/active/loop, shown in full), and done (truncated).
// A board with no commitment point isn't collapsed — it's simple, shown inline.
function partition(manifest) {
  const ordered = stages(manifest);
  const commitIdx = ordered.findIndex((s) => s.role === 'commit');
  if (commitIdx < 0) return { collapse: false, preCommit: [], middle: ordered, done: [] };
  const rest = ordered.slice(commitIdx);
  return {
    collapse: true,
    preCommit: ordered.slice(0, commitIdx),
    middle: rest.filter((s) => s.role !== 'done'),
    done: rest.filter((s) => s.role === 'done'),
  };
}

// Render BOARD.md — the focus view. Pure (pass `now` for a deterministic render).
export function renderBoard(cards, manifest, { now = Date.now(), filter = null } = {}) {
  const board = manifest.board ?? {};
  const laneDefs = lanes(manifest);
  cards = cards.filter((c) => !c.archived); // frozen cards drop off the active board -> ARCHIVE.md
  if (filter) {
    const def = laneDefs.find((d) => d.axis === filter.axis) ?? { axis: filter.axis, from: filter.axis };
    cards = cards.filter((c) => laneValue(c, def) === filter.value);
  }
  const ordered = stages(manifest);
  const known = new Set(ordered.map((s) => s.id));
  const byStage = groupBy(cards, (c) => c.state);
  const orphans = cards.filter((c) => !known.has(c.state));
  const { collapse, preCommit, middle, done } = partition(manifest);

  const out = [];
  const title = board.name ?? board.id ?? 'board';
  out.push(`# ${title} · board`, '');
  out.push(`> rev ${board.revision ?? 0} · ${cards.length} cards · ${new Date(now).toISOString().slice(0, 16)}Z · read-only, do not edit`, '');

  // the board, normal flow: intake (top) -> delivery (bottom)
  out.push('## Board', '');
  if (!collapse) {
    for (const stage of ordered) out.push(...stageSection(stage, byStage, now, laneDefs));
  } else {
    if (preCommit.length) out.push(...collapsedOptions(preCommit, byStage));
    for (const stage of middle) out.push(...stageSection(stage, byStage, now, laneDefs));
    for (const stage of done) out.push(...truncatedDone(stage, byStage, now, laneDefs));
  }

  if (orphans.length) {
    out.push('## ⚠ Orphaned (state no longer in the manifest — run `reconcile`)', '');
    for (const c of orphans) out.push(`- ${cardLine(c, null, now)} — _was in \`${c.state}\`_`);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// POOL.md — the full pre-commit pool, collapsed out of BOARD.md. null when the
// board has no commitment point (nothing collapses).
export function renderPool(cards, manifest, { now = Date.now() } = {}) {
  const { collapse, preCommit } = partition(manifest);
  if (!collapse || !preCommit.length) return null;
  const board = manifest.board ?? {};
  const laneDefs = lanes(manifest);
  const byStage = groupBy(cards.filter((c) => !c.archived), (c) => c.state);
  const out = [`# ${board.name ?? board.id ?? 'board'} · pool`, ''];
  out.push('> the full Options pool — pre-commitment, FIFO (oldest first). Back to [BOARD.md](BOARD.md).', '');
  for (const stage of preCommit) out.push(...stageSection(stage, byStage, now, laneDefs));
  return out.join('\n').replace(/\n+$/, '\n');
}

// DONE.md — the full delivered history, newest first. null unless done has grown
// past what BOARD.md shows inline (so the file exists iff BOARD.md links to it).
export function renderDone(cards, manifest, { now = Date.now() } = {}) {
  const laneDefs = lanes(manifest);
  const done = stages(manifest).filter((s) => s.role === 'done');
  const byStage = groupBy(cards.filter((c) => !c.archived), (c) => c.state);
  const total = done.reduce((n, s) => n + (byStage.get(s.id)?.length ?? 0), 0);
  if (!done.length || total <= DONE_LIMIT) return null;
  const board = manifest.board ?? {};
  const out = [`# ${board.name ?? board.id ?? 'board'} · done`, ''];
  out.push('> delivered work, newest first. Back to [BOARD.md](BOARD.md).', '');
  for (const stage of done) {
    if (done.length > 1) out.push(`## ${stage.id}`, '');
    const inStage = [...(byStage.get(stage.id) ?? [])].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
    if (!inStage.length) out.push('- _(empty)_', '');
    else {
      for (const c of inStage) out.push('- ' + cardLine(c, stage, now, laneLabel(c, laneDefs)));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// ARCHIVE.md — the terminal offload: frozen, read-only cards dropped from the
// active board, grouped by disposition (throughput / spillage / triage stay
// distinguishable), newest freeze first. null when nothing is archived (the file
// exists iff there has been an offload).
export function renderArchive(cards, manifest, { now = Date.now() } = {}) {
  const archived = cards.filter((c) => c.archived);
  if (!archived.length) return null;
  const board = manifest.board ?? {};
  const out = [`# ${board.name ?? board.id ?? 'board'} · archive`, ''];
  out.push('> frozen, offloaded cards — read-only, newest first, grouped by disposition. Back to [BOARD.md](BOARD.md).', '');
  const declared = DISPOSITIONS.map((d) => d.disposition);
  const byDisp = groupBy(archived, (c) => c.disposition ?? 'archived');
  const extras = [...byDisp.keys()].filter((k) => !declared.includes(k));
  for (const disp of [...declared, ...extras]) {
    const inDisp = byDisp.get(disp);
    if (!inDisp?.length) continue;
    out.push(`## ${disp} · [${inDisp.length}]`, '');
    for (const c of [...inDisp].sort((a, b) => ts(b.archived) - ts(a.archived))) out.push('- ' + cardLine(c, null, now));
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// Write a rendered view atomically (temp + rename), so a concurrent reader never
// sees a half-written file. Derived, so safe to clobber wholesale.
// Render PORTFOLIO.md — the position read-model, the confidence-axis counterpart to
// BOARD.md. Orients around the important ROOTS (top-level positions) and their
// lifecycle status; nested children collapse into a count. Pure. `positions` are
// { curie, title, status, root, investment, childCount }; status sections follow the
// position type's declared lifecycle order, then a no-status bucket.
export function renderPortfolio(positions, manifest, { now = Date.now() } = {}) {
  const board = manifest.board ?? {};
  const roots = positions.filter((p) => p.root);
  const out = [];
  out.push(`# ${board.name ?? board.id ?? 'board'} · portfolio`, '');
  out.push(`> ${roots.length} positions · ${new Date(now).toISOString().slice(0, 16)}Z · read-only, regenerated on \`board\` / \`compile\``, '');
  out.push('> orient by status; `⇐n` = cards advancing the position · `+n` = nested positions', '');
  if (!roots.length) { out.push('_(no positions — declare `portfolio: { type }` and add records)_'); return out.join('\n') + '\n'; }
  const types = portfolioTypes(manifest);
  if (types.length <= 1) {
    // single type — no type headers; each type owns its own status vocabulary
    const declared = vocabTerms(typeDef(manifest, types[0])?.status?.values);
    statusSections(out, roots, declared, '##');
  } else {
    // multiple types — section by declared type order; each type keeps its own
    // vocabulary (never mixed), and empty types are omitted
    for (const id of types) {
      const inType = roots.filter((r) => r.type === id);
      if (!inType.length) continue;
      out.push(`## ${id}`, '');
      statusSections(out, inType, vocabTerms(typeDef(manifest, id)?.status?.values), '###');
    }
  }
  return out.join('\n');
}

// Emit status sections for one set of roots against one type's status vocabulary:
// declared-and-present statuses in declared order, then undeclared-but-present, then
// the no-status bucket. `heading` is the level prefix (`##` flat, `###` under a type).
function statusSections(out, roots, declared, heading) {
  const present = [...new Set(roots.map((r) => r.status).filter(Boolean))];
  const sections = [...declared.filter((s) => present.includes(s)), ...present.filter((s) => !declared.includes(s))];
  for (const status of sections) {
    const inState = roots.filter((r) => r.status === status).sort((a, b) => b.investment - a.investment);
    out.push(`${heading} ${status} · [${inState.length}]`);
    for (const p of inState) out.push('- ' + positionLine(p));
    out.push('');
  }
  const none = roots.filter((r) => !r.status).sort((a, b) => b.investment - a.investment);
  if (none.length) {
    out.push(`${heading} — no status — · [${none.length}]`);
    for (const p of none) out.push('- ' + positionLine(p));
    out.push('');
  }
}

function positionLine(p) {
  const parts = [`\`${p.curie}\``, `"${p.title}"`];
  const flags = [];
  if (p.investment) flags.push(`⇐${p.investment}`); // inbound work — cards advancing this position
  if (p.childCount) flags.push(`+${p.childCount}`); // collapsed nested positions
  if (flags.length) parts.push(flags.join(' '));
  return parts.join(' · ');
}

export async function writeProjection(path, markdown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, markdown, 'utf8');
  await rename(tmp, path);
  return path;
}

// Fold the board and write BOARD.md plus its derived views (POOL.md / DONE.md, as
// applicable) — the write-through a consumer calls after any state change.
export async function materialize(board, path, opts) {
  const cards = await board.pool();
  const markdown = renderBoard(cards, board.manifest, opts);
  await writeProjection(path, markdown);
  const dir = dirname(path);
  const pool = renderPool(cards, board.manifest, opts);
  const done = renderDone(cards, board.manifest, opts);
  const archive = renderArchive(cards, board.manifest, opts);
  if (pool != null) await writeProjection(join(dir, 'POOL.md'), pool);
  if (done != null) await writeProjection(join(dir, 'DONE.md'), done);
  if (archive != null) await writeProjection(join(dir, 'ARCHIVE.md'), archive);
  return markdown;
}

// --- the network (cross-board) view ------------------------------------------

// NETWORK.md — the read model of a network: a projection over the host's roster
// and each member's own read model. The same idea as BOARD.md, one level up, and
// just as derived — the host pulls each member, members never push. Pure: the
// caller resolves the roster and passes each member as {handle, manifest, cards}
// (or {handle, location, error} when it couldn't be opened); this renders.
export function renderNetwork(host, members, { now = Date.now() } = {}) {
  const id = host.id ?? host.name ?? 'network';
  const out = [`# ${host.name ?? id} · network`, ''];
  out.push(`> host @${id} · ${members.length} member(s) · ${new Date(now).toISOString().slice(0, 16)}Z · read-only, do not edit`, '');

  // triage hoist: anything stuck — unreachable, blocked, over WIP, jammed, idle
  const attention = [];
  for (const m of members) {
    if (m.error) attention.push(`- @${m.handle} — ⚠ unreachable (${m.error})`);
    else {
      const flags = memberFlags(m);
      if (flags.length) attention.push(`- @${m.handle} — ${flags.join(' · ')}`);
    }
  }
  if (attention.length) out.push('## ⚠ Needs attention', '', ...attention, '');

  out.push('## Members', '');
  if (!members.length) out.push(`- _(no members yet — \`kanbento join @${id}\` from a board)_`, '');
  for (const m of members) {
    if (m.error) {
      out.push(`### @${m.handle}`, `  ⚠ unreachable — ${m.error}  (${m.location})`, '');
      continue;
    }
    const b = m.manifest.board ?? {};
    out.push(`### @${m.handle}${b.name || b.id ? ` · ${b.name ?? b.id}` : ''}`);
    out.push(`  → Next: ${nextLine(m.manifest, m.cards)}`);
    out.push(`  ${stageCountsLine(m.manifest, m.cards)}`, '');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// A member's attention flags: blocked cards, stages over WIP, a jammed pull, or
// idle capacity (work waiting with nothing in flight). Empty = healthy/flowing.
function memberFlags(m) {
  const flags = [];
  const blocked = m.cards.filter((c) => c.blocked).length;
  if (blocked) flags.push(`⛔ ${blocked} blocked`);
  const byStage = groupBy(m.cards, (c) => c.state);
  for (const s of stages(m.manifest)) {
    const n = (byStage.get(s.id) ?? []).length;
    if (s.wip != null && n > s.wip) flags.push(`${s.id} WIP ${n}/${s.wip}`);
  }
  const next = selectNext([...stages(m.manifest)].reverse(), byStage, m.manifest);
  if (next.kind === 'hold') flags.push(`hold — ${next.reason}`);
  else if (next.kind === 'act' && next.role === 'options') flags.push('idle — work waiting, nothing in flight');
  return flags;
}

// One member's `→ Next`, compact (verb + card), sharing the board's selector.
function nextLine(manifest, cards) {
  const byStage = groupBy(cards, (c) => c.state);
  const n = selectNext([...stages(manifest)].reverse(), byStage, manifest);
  if (n.kind === 'rest') return `idle — ${n.count} in the pool (resting)`;
  if (n.kind === 'hold') return `hold — ${n.reason}`;
  if (n.kind === 'clear') return 'clear';
  return `${n.verb} ${short(n.card.id)} "${n.card.title}"`;
}

// Per-stage counts on one line, in flow order.
function stageCountsLine(manifest, cards) {
  const byStage = groupBy(cards, (c) => c.state);
  return stages(manifest).map((s) => `${s.id} ${(byStage.get(s.id) ?? []).length}`).join(' · ');
}

// Materialize NETWORK.md under the host's views/. Pull-derived, regenerated on
// demand — the network is never behind, because reading it recomputes it.
export async function materializeNetwork(host, members, path, opts) {
  const markdown = renderNetwork(host, members, opts);
  await writeProjection(path, markdown);
  return markdown;
}

// --- display zones -----------------------------------------------------------

// A full stage section (header + cards). Used in BOARD.md's middle and in POOL.md.
function stageSection(stage, byStage, now, laneDefs = []) {
  const inStage = byStage.get(stage.id) ?? [];
  const count = stage.wip != null ? `${inStage.length}/${stage.wip}` : `${inStage.length}`;
  const glyph = GLYPH[stage.role] ?? '·';
  const lines = [`### ${glyph} ${stage.id} · ${stage.role} · [${count}]`];
  if (!inStage.length) {
    lines.push('- _(empty)_', '');
    return lines;
  }
  const groups = laneGroups(inStage, laneDefs);
  if (groups) {
    for (const g of groups.order) {
      lines.push(`- **${g.label}** · ${groups.def.axis} · [${g.cards.length}]`); // the swimlane header carries the value
      for (const c of sortForStage(g.cards, stage)) lines.push('  - ' + cardLine(c, stage, now));
    }
  } else {
    for (const c of sortForStage(inStage, stage)) lines.push('- ' + cardLine(c, stage, now, laneLabel(c, laneDefs)));
  }
  lines.push('');
  return lines;
}

// Pre-commit stages collapsed to one line of per-stage counts + a link to POOL.md,
// so the pool can grow without overwhelming BOARD.md.
function collapsedOptions(preCommit, byStage) {
  const total = preCommit.reduce((n, s) => n + (byStage.get(s.id)?.length ?? 0), 0);
  return [`### ${GLYPH.options ?? '○'} Options [${total}] → [POOL.md](POOL.md)`, '']; // per-stage detail lives in POOL.md
}

// Done, truncated to the most recent DONE_LIMIT; the rest live in DONE.md.
function truncatedDone(stage, byStage, now, laneDefs = []) {
  const inStage = byStage.get(stage.id) ?? [];
  const glyph = GLYPH[stage.role] ?? '·';
  const lines = [`### ${glyph} ${stage.id} · ${stage.role} · [${inStage.length}]`];
  if (!inStage.length) return lines.concat('- _(empty)_', '');
  const recent = [...inStage].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt)); // newest first
  for (const c of recent.slice(0, DONE_LIMIT)) lines.push('- ' + cardLine(c, stage, now, laneLabel(c, laneDefs)));
  if (recent.length > DONE_LIMIT) lines.push(`- … ${recent.length - DONE_LIMIT} more → [DONE.md](DONE.md)`);
  lines.push('');
  return lines;
}

// --- the delivery-first scan, as one recommendation --------------------------

// Select the single next action (the finish-first, delivery->entry scan) as a
// structured verdict — both BOARD.md and the network view format it their own way.
// `done` is terminal, never the next action; pulling from the pool is the last
// resort, only with capacity — "finish before you pull" made literal.
function selectNext(rightToLeft, byStage, manifest) {
  const verb = { loop: 'review', active: 'finish', commit: 'start', options: 'pull' };
  for (const stage of rightToLeft) {
    if (stage.role === 'done') continue;
    const inStage = byStage.get(stage.id) ?? [];
    if (!inStage.length) continue;
    const c = sortForStage(inStage, stage)[0];
    if (stage.role === 'options') {
      if (!canPull(manifest, stage)) return { kind: 'rest', count: inStage.length };
      const blocked = pullBlocked(manifest, byStage);
      if (blocked) return { kind: 'hold', card: c, reason: blocked };
    }
    return { kind: 'act', role: stage.role, verb: verb[stage.role] ?? 'act on', card: c };
  }
  return { kind: 'clear' };
}

// Pulling from the pool needs a target: a commitment point, or any later stage.
function canPull(manifest, optionsStage) {
  return Boolean(commitStageId(manifest)) || Boolean(nextStageId(manifest, optionsStage.id));
}

// Is the commit stage full, so a pull would have nowhere to land?
function pullBlocked(manifest, byStage) {
  const commit = stages(manifest).find((s) => s.role === 'commit');
  if (!commit || commit.wip == null) return null;
  const n = (byStage.get(commit.id) ?? []).length;
  return n >= commit.wip ? `\`${commit.id}\` is at WIP ${n}/${commit.wip}` : null;
}

// --- per-card rendering ------------------------------------------------------

function sortForStage(inStage) {
  // FIFO by when each card (re-)entered its stage. A card returned to the pool
  // re-enters at the back, so deprioritized work sinks instead of resurfacing as
  // the oldest; elsewhere this surfaces the longest-sitting work.
  return inStage.slice().sort((a, b) => ts(a.updatedAt) - ts(b.updatedAt));
}

function cardLine(c, stage, now, laneTag = '') {
  const parts = [`\`${handle(c)}\``];
  if (c.type) parts.push(c.type); // untyped (e.g. a bare cross-board submission) shows no chip — never the capitalized class name
  parts.push(`"${c.title}"`);
  parts.push(age(now - ts(c.updatedAt)));
  const flags = [];
  if (c.lineage?.parent) flags.push(`↳${short(c.lineage.parent)}`);
  if (c.iterationCount) flags.push(`↺${c.iterationCount}`);
  if (c.binding) flags.push('🔗');
  if (c.blocked) flags.push('⛔');
  const refChip = renderRefChip(c.payload?.refs); // all forward edges (raw CURIE; no resolution at render)
  if (refChip) flags.push(refChip);
  if (laneTag) flags.push(laneTag); // the lane value, inline — for flat sections with no swimlane header
  if (flags.length) parts.push(flags.join(' '));
  return parts.join(' · ');
}

// The forward-edge chip: ALL ref keys on one `→` flag, in a curated family order —
// contribution (advances, implements), epistemic (evidence), flow (blocks, sibling,
// parent), topical (about), then any other keys alphabetically. `about` entries stay
// bare (backward-compatible with the original view); every other key prefixes its
// target with `key=`. '' when there are no refs. Raw CURIEs — no resolution here.
const REF_FAMILY = ['advances', 'implements', 'evidence', 'blocks', 'sibling', 'parent', 'about'];
function renderRefChip(refs) {
  if (!refs || typeof refs !== 'object') return '';
  const keys = Object.keys(refs);
  const ordered = [
    ...REF_FAMILY.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !REF_FAMILY.includes(k)).sort(),
  ];
  const parts = [];
  for (const key of ordered) {
    const v = refs[key];
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    for (const t of list) parts.push(key === 'about' ? t : `${key}=${t}`);
  }
  return parts.length ? '→ ' + parts.join(' ') : '';
}

// --- lanes (orthogonal partition / swimlanes) --------------------------------

// Group a stage's cards by the primary lane axis — but only when the board
// declares lanes AND this stage actually has lane-bound cards. Upstream (shared)
// stages stay flat: the axis binds late, so early stages have nothing to group
// on. Returns { def, order: [{ label, cards }] } or null (render flat).
function laneGroups(inStage, laneDefs) {
  if (!laneDefs.length) return null;
  const def = laneDefs[0]; // the primary axis drives the swimlanes
  const SHARED = ' shared';
  if (!inStage.some((c) => laneValue(c, def) != null)) return null; // all shared -> flat
  const buckets = new Map();
  for (const v of def.values ?? []) buckets.set(v, []); // declared values show even when empty (a demand signal)
  for (const c of inStage) {
    const k = laneValue(c, def) ?? SHARED;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(c);
  }
  const order = [];
  const seen = new Set();
  for (const v of def.values ?? []) if (buckets.has(v)) { order.push(v); seen.add(v); } // declared order first
  for (const k of [...buckets.keys()].filter((k) => k !== SHARED && !seen.has(k)).sort()) order.push(k);
  if (buckets.has(SHARED)) order.push(SHARED); // the shared lane sinks to the bottom
  return { def, order: order.map((k) => ({ label: k === SHARED ? 'shared' : k, cards: buckets.get(k) })) };
}

// A card's lane value as an inline tag (axis:value), for flat sections (done,
// orphans) that have no swimlane header to carry it. '' when unset.
function laneLabel(c, laneDefs) {
  for (const def of laneDefs) {
    const v = laneValue(c, def);
    if (v != null) return `${def.axis}:${v}`;
  }
  return '';
}

// --- small helpers -----------------------------------------------------------

function groupBy(items, keyOf) {
  const map = new Map();
  for (const it of items) {
    const k = keyOf(it);
    (map.get(k) ?? map.set(k, []).get(k)).push(it);
  }
  return map;
}

function short(id) {
  return String(id).slice(0, 8);
}

// The human handle the board prints: `slug@id` — a readable label at an
// immutable address (the docker/git `name@hash` idiom). The slug leads (scan by
// topic), the short id trails as the key. resolveCard accepts it back, keying on
// the @id — so the slug is free to be short, dynamic, even duplicated. A card
// with no slug (synthetic) shows the bare short id.
export function handle(c) {
  return c.slug ? `${c.slug}@${short(c.id)}` : short(c.id);
}

function ts(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
}

function age(ms) {
  if (!(ms > 0)) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
