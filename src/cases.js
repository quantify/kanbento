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
// (the date alone collides) so a later outcome can point back at it.
export function renderPrecedent({ at, id, about, situation, why }) {
  const head = `### ${at}${id ? ` · ${id}` : ''}${about ? ` · about ${about}` : ''}`;
  return `${head}\n${precedentBody({ situation, why })}\n\n`; // trailing blank line so appended headings render + stay separated
}

// Count precedents in a category doc — the `### ` headings under Precedents.
export async function precedentCount(path) {
  const raw = await readFile(path, 'utf8');
  return (raw.match(/^### /gm) || []).length;
}

// Record the precedent's `about` target as a real graph edge in the case file's
// frontmatter `refs.about`, not only prose in the block head — prose is invisible to
// refs/backlinks, so citations of the record a precedent decided about were unreachable.
// Union + idempotent (a re-file of the same about is a no-op), mirroring mergeRefs.
async function addAboutRef(path, about) {
  if (!about) return;
  const { data } = await readFrontmatter(path);
  const refs = { ...(data.refs ?? {}) };
  const cur = new Set(Array.isArray(refs.about) ? refs.about : refs.about ? [refs.about] : []);
  if (cur.has(about)) return; // already cited — nothing to write
  cur.add(about);
  refs.about = [...cur];
  await writeFrontmatterBlock(path, 'refs', refs);
}

// File a precedent under a category. A new category needs a `when` (the criterion that keeps
// the taxonomy meaningful); an existing one appends — unless the same (situation, why) is
// already recorded, in which case it is a no-op (idempotent: the pulse won't double-file).
export async function retain(dir, { category, when, why, situation, about, at, id }) {
  if (!category) throw new Error('retain: a category is required (e.g. pull-when-card-is-clearly-articulated)');
  if (!why) throw new Error('retain: --why "<the rationale>" is required — the rationale is the payload');
  const slug = categorySlug(category);
  const path = categoryPath(dir, category);
  const block = renderPrecedent({ at, id, about, situation, why });
  await mkdir(casesDir(dir), { recursive: true });

  if (!existsSync(path)) {
    if (!when) throw new Error(`retain: category "${slug}" is new — describe it with --when "<when this precedent class applies>"`);
    const fm = ['---', `kanbento_id: ${randomUUID()}`, 'type: case', `title: ${slug}`, `when: ${JSON.stringify(when)}`, '---', ''].join('\n');
    const head = `\n# ${slug}\n\n**When:** ${when}\n\n## Precedents\n\n`;
    await writeFile(path, fm + head + block, 'utf8');
    await addAboutRef(path, about); // cite the target in the graph, not just the prose head
    return { path, slug, created: true, deduped: false, block, count: await precedentCount(path) };
  }
  const raw = await readFile(path, 'utf8');
  if (raw.includes(precedentBody({ situation, why }))) {
    await addAboutRef(path, about); // idempotent — ensures the citation even on a re-file
    return { path, slug, created: false, deduped: true, block, count: await precedentCount(path) };
  }
  await writeFile(path, `${raw.endsWith('\n') ? raw : raw + '\n'}${block}`, 'utf8');
  await addAboutRef(path, about);
  return { path, slug, created: false, deduped: false, block, count: await precedentCount(path) };
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
