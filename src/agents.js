import { stages, isFlowType, portfolioTypes } from './manifest.js';
import { expandedRelations } from './refs.js';
import { GLYPH, ROLE_MEANING } from './protocol.js';

// Render the board's operating guide (AGENTS.md) — a compile target.
//
// BOARD.md (projection.js) is the read model: current STATE. This is the other
// generated artifact: how to OPERATE that state — the legend for reading BOARD.md,
// this board's pipeline and its gates, the CLI verbs, and the flow discipline.
// Generated from the manifest, so the pipeline and gate prose track the real
// board; do not hand-edit. Operating instructions only — no positioning.

export function renderAgents(manifest, { cli = 'kanbento', verbs = [] } = {}) {
  const board = manifest.board ?? {};
  const st = stages(manifest);
  const rolesUsed = [...new Set(st.map((s) => s.role).filter((r) => GLYPH[r]))];
  const commit = st.find((s) => s.role === 'commit');
  const done = st.find((s) => s.role === 'done');

  const out = [];
  out.push(`# ${board.name ?? board.id ?? 'Board'} — operating guide`);
  out.push('');
  out.push('> Generated from the board manifest — do not edit by hand.');
  out.push('');

  out.push('## What to read');
  out.push('');
  out.push('- **State** → `.kanbento/views/BOARD.md`: a read-only map of every card and where it sits. Orient from it; re-read after you act (a copy from session start goes stale).');
  out.push('- **How to operate** → this file.');
  out.push('');
  out.push('State is read from files; changes go through the CLI — each verb appends to an immutable log and `BOARD.md` re-renders.');
  out.push('');

  out.push('## Legend');
  out.push('');
  for (const r of rolesUsed) out.push(`- \`${GLYPH[r]} ${r}\` — ${ROLE_MEANING[r]}`);
  out.push('- `[3]` count · `[1/2]` count / WIP · `↳abc12345` parent (lineage) · `↺2` reworked twice · `🔗` bound doc · `⛔` blocked · `→rel=target` ref · bare = about');
  out.push('');

  out.push('## This board');
  out.push('');
  out.push(
    commit
      ? `Commitment point: \`${commit.id}\`.${done ? ` Delivery: \`${done.id}\`.` : ''}`
      : 'A bare pool — no commitment point yet; captured work waits as Options.',
  );
  const types = manifest.types ?? [];
  if (types.length) {
    // Grouped by the verb that applies, not one flat list — a record type sitting
    // next to `capture --type` reads as an invitation to a rejected call; splitting
    // by flow/record makes the routing unmistakable.
    const chip = (t) => `\`${t.id}\`${t.embodiment && t.embodiment !== 'none' ? ` (${t.embodiment})` : ''}`;
    const flow = types.filter((t) => isFlowType(t));
    const record = types.filter((t) => !isFlowType(t));
    const groups = [];
    if (flow.length) groups.push(`flow (on the board, via \`capture --type\`): ${flow.map(chip).join(' · ')}`);
    if (record.length) groups.push(`record (knowledge layer, flow:false, via \`note --type\`): ${record.map(chip).join(' · ')}`);
    out.push('');
    out.push(`Types — ${groups.join('; ')}. An embodied type (file/folder) materializes its artifact.`);
  }
  const relations = expandedRelations(manifest);
  if (relations.length) {
    out.push('');
    out.push(
      `Relations: ${relations
        .map((r) => {
          const facets = [
            r.inverse && `inverse ${r.inverse}`,
            r.symmetric && 'symmetric',
            r.range && `range ${(Array.isArray(r.range) ? r.range : [r.range]).join('/')}`,
            r.cardinality && String(r.cardinality),
          ].filter(Boolean);
          return `\`${r.id}\`${facets.length ? ` (${facets.join(', ')})` : ''}`;
        })
        .join(' · ')} — typed edges; connect with \`link <from> <rel> <to>\`.`,
    );
  }
  const positions = portfolioTypes(manifest);
  if (positions.length) {
    out.push('');
    out.push(`Positions: ${positions.join(', ')} roots project into \`views/PORTFOLIO.md\` — the portfolio read-model; orient by lifecycle status (the confidence axis), not the whole knowledge base.`);
  }
  out.push('');
  for (const s of st) {
    let line = `- \`${GLYPH[s.role] ?? '·'} ${s.id}\` · ${s.role}`;
    if (s.wip != null) line += ` · WIP ${s.wip}`;
    const crit = (c) => (Array.isArray(c) && c.length ? c.map((x) => (Array.isArray(x) ? `${String(x[0]).toUpperCase()} ${x[1]}` : x)).join('; ') : null);
    if (crit(s.entry)) line += ` — ${s.role === 'done' ? 'Done' : 'Ready'}: ${crit(s.entry)}`; // done's entry gate is the DoD
    if (crit(s.exit)) line += ` — Done: ${crit(s.exit)}`;
    if (s.agreement) line += ` — agreement \`${s.agreement}\``;
    out.push(line);
  }
  for (const f of manifest.flows ?? []) {
    const extra = [];
    if (f.maxIterations) extra.push(`max ${f.maxIterations}`);
    if (f.appliesTo?.classOfService) extra.push(`${f.appliesTo.classOfService} only`);
    out.push(`- ${f.from} → ${f.to} _(${f.kind ?? 'forward'}${extra.length ? ', ' + extra.join(', ') : ''})_`);
  }
  out.push('');

  out.push('## Verbs');
  out.push('');
  out.push('Run inside the repo (the board is found by walking up):');
  out.push('');
  for (const v of verbs) {
    if (v.name === 'commit' && !commit) continue; // this board has no commitment point
    const opts = v.options.length ? ' ' + v.options.map((f) => `[${f}]`).join(' ') : '';
    out.push(`    ${cli} ${v.name}${v.args ? ' ' + v.args : ''}${opts}`);
    if (v.summary) out.push(`        ${v.summary}`);
  }
  out.push('');
  out.push('`<ref>` is a card handle `slug@id` (as the board prints it), or any unambiguous part — a bare id, a slug, a CURIE (`type:slug`), or a prefix. In a `slug@id` handle the part after `@` is the key; the slug is advisory.');
  out.push('');

  out.push('## How to operate');
  out.push('');
  out.push('1. **Orient** — read `BOARD.md` for live state, then decide what to act on yourself: weigh the goal, dependencies, and WIP. The board shows state; the call is yours.');
  out.push('2. **Finish first** — generally clear, unblock, or review work already in flight before pulling new from the pool (a Kanban default — apply it with judgment).');
  out.push('3. **Respect the gates** — pull only into free WIP; a stage\'s Ready (DoR) and Done (DoD) criteria are judged independently on entry/exit.');
  out.push('4. **Re-read after acting** — a verb changes `BOARD.md`; refresh before the next move.');

  out.push('');
  out.push('## Changing the board');
  out.push('');
  out.push('Changing the structure (stages, WIP, gates) is a *meta* action, not a plain file edit — in-flight cards must be reconciled. Add structure when the flow earns it. See `.kanbento/EVOLVING.md`.');

  return out.join('\n').replace(/\n+$/, '\n');
}
