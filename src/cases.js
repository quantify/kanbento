import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFrontmatter, writeFrontmatterBlock } from './frontmatter.js';
import { slugify } from './slug.js';

// Case-based decisioning — the precedent base (the case-based-decisioning capability record).
// Two critical paths: RETAIN a decision as a precedent, and read the TAXONOMY — the map of
// decision categories the agent classifies its situation against. There is no search engine
// and no "list the cases": the agent reads the taxonomy, picks the category, then opens that
// category's file (the taxonomy hands over the path). Retrieval is reading — and the reader
// is an LLM. The CATEGORY carries the decision (an override is a different category firing),
// so a precedent is only the situation it fired in and the reason it applied.

export function casesDir(dir) {
  return resolve(dir, '.kanbento/cases');
}

// A category is a deliberate, named rule (pull-when-card-is-clearly-articulated), not a tag —
// normalize it but keep it whole. slugify's tight default cap would truncate and collide
// distinct rules, so lift the cap.
export function categorySlug(category) {
  return slugify(category, 80);
}

export function categoryPath(dir, category) {
  return join(casesDir(dir), `${categorySlug(category)}.md`);
}

// The body of a precedent (situation? + why) — also the dedup key: two decisions with the
// same situation and reason are the same precedent, so the pulse re-filing one is a no-op.
function precedentBody({ situation, why }) {
  return [situation ? `- **Situation:** ${situation}` : null, `- **Why:** ${why}`].filter(Boolean).join('\n');
}

// One precedent as a markdown block. `at`/`id` are passed in (no clock/randomness here) so
// the caller owns them — the CLI stamps, tests fix. `id` gives each precedent a stable handle
// (the date alone collides) so a later outcome can point back at it. The precedent's `about`
// citation is NOT prose here — it lives in the case file's frontmatter refs (a real graph
// edge), so refs/backlinks/maps can surface it; prose in the head was invisible to the graph.
export function renderPrecedent({ at, id, situation, why }) {
  const head = `### ${at}${id ? ` · ${id}` : ''}`;
  return `${head}\n${precedentBody({ situation, why })}\n\n`; // trailing blank line so appended headings render + stay separated
}

// Count precedents in a category doc — the `### ` headings under Precedents.
export async function precedentCount(path) {
  const raw = await readFile(path, 'utf8');
  return (raw.match(/^### /gm) || []).length;
}

// Record a precedent's citations as real graph edges in the case file's frontmatter
// `refs` — not prose in the block head, which is invisible to refs/backlinks, so the
// record a precedent decided about was unreachable. Union + idempotent (a re-file of the
// same target is a no-op), one relation at a time, mirroring mergeRefs in commands.js.
async function mergeCaseRefs(path, refs) {
  if (!refs || !Object.keys(refs).length) return;
  const { data } = await readFrontmatter(path);
  const merged = { ...(data.refs ?? {}) };
  let changed = false;
  for (const [rel, vals] of Object.entries(refs)) {
    const incoming = (Array.isArray(vals) ? vals : vals == null ? [] : [vals]).filter((v) => typeof v === 'string' && v);
    if (!incoming.length) continue;
    const cur = new Set(Array.isArray(merged[rel]) ? merged[rel] : merged[rel] ? [merged[rel]] : []);
    const before = cur.size;
    for (const v of incoming) cur.add(v);
    if (cur.size !== before) changed = true;
    merged[rel] = [...cur];
  }
  if (changed) await writeFrontmatterBlock(path, 'refs', merged);
}

// File a precedent under a category. A new category needs a `when` (the criterion that keeps
// the taxonomy meaningful); an existing one appends — unless the same (situation, why) is
// already recorded, in which case it is a no-op (idempotent: the pulse won't double-file).
// `refs` is the precedent's typed citations (e.g. { about: ['capability:x'] }) — one spelling
// with capture/note (--rel), written to frontmatter so the graph surfaces the precedent.
export async function retain(dir, { category, when, why, situation, refs, at, id }) {
  if (!category) throw new Error('retain: a category is required (e.g. pull-when-card-is-clearly-articulated)');
  if (!why) throw new Error('retain: --why "<the rationale>" is required — the rationale is the payload');
  const slug = categorySlug(category);
  const path = categoryPath(dir, category);
  const block = renderPrecedent({ at, id, situation, why });
  await mkdir(casesDir(dir), { recursive: true });

  if (!existsSync(path)) {
    if (!when) throw new Error(`retain: category "${slug}" is new — describe it with --when "<when this precedent class applies>"`);
    const fm = ['---', `kanbento_id: ${randomUUID()}`, 'type: case', `title: ${slug}`, `when: ${JSON.stringify(when)}`, '---', ''].join('\n');
    const head = `\n# ${slug}\n\n**When:** ${when}\n\n## Precedents\n\n`;
    await writeFile(path, fm + head + block, 'utf8');
    await mergeCaseRefs(path, refs); // cite the target(s) in the graph, not just prose
    return { path, slug, created: true, deduped: false, block, count: await precedentCount(path) };
  }
  const raw = await readFile(path, 'utf8');
  if (raw.includes(precedentBody({ situation, why }))) {
    await mergeCaseRefs(path, refs); // idempotent — ensures the citation even on a re-file
    return { path, slug, created: false, deduped: true, block, count: await precedentCount(path) };
  }
  await writeFile(path, `${raw.endsWith('\n') ? raw : raw + '\n'}${block}`, 'utf8');
  await mergeCaseRefs(path, refs);
  return { path, slug, created: false, deduped: false, block, count: await precedentCount(path) };
}

// Migrate legacy case files: lift each precedent head's pre-relations `· about <target>`
// prose into the case file's frontmatter refs.about (a real graph edge) and strip the prose.
// Idempotent — a file already migrated carries no `· about` prose, so a re-run is a no-op.
// `resolve` (optional) upgrades a bare handle/id to its stable CURIE (board-backed, best
// effort); without it the prose token is stored verbatim (progressive fidelity, resolved at
// read). `dryRun` reports what would change without writing. Returns one entry per file touched.
export async function migrateCases(dir, { resolve, dryRun = false } = {}) {
  const cdir = casesDir(dir);
  if (!existsSync(cdir)) return [];
  const migrated = [];
  for (const f of (await readdir(cdir)).filter((x) => x.endsWith('.md')).sort()) {
    const path = join(cdir, f);
    const raw = await readFile(path, 'utf8');
    const hits = [...raw.matchAll(/^### .+? · about (.+?)\s*$/gm)];
    if (!hits.length) continue;
    const targets = [];
    for (const h of hits) {
      const token = h[1].trim();
      let t = token;
      if (resolve) { try { t = (await resolve(token)) || token; } catch { t = token; } }
      if (!targets.includes(t)) targets.push(t);
    }
    if (!dryRun) {
      await writeFile(path, raw.replace(/^(### .+?) · about .+?\s*$/gm, '$1'), 'utf8');
      await mergeCaseRefs(path, { about: targets });
    }
    migrated.push({ path, file: f, targets });
  }
  return migrated;
}

// The taxonomy: every category with its `when` criterion, precedent count, and file path —
// the map the pulse classifies against, then opens the chosen category's file. Not a dump of
// cases; the structure, not the content.
export async function taxonomy(dir) {
  const cdir = casesDir(dir);
  if (!existsSync(cdir)) return [];
  const files = (await readdir(cdir)).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const f of files.sort()) {
    const path = join(cdir, f);
    const { data } = await readFrontmatter(path);
    out.push({
      slug: data.title ?? f.replace(/\.md$/, ''),
      when: data.when ?? '',
      count: await precedentCount(path),
      path: join('.kanbento/cases', f),
    });
  }
  return out;
}
