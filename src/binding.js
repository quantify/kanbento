import { glob } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFrontmatter, writeFrontmatterField } from './frontmatter.js';

// A type that embodies as a file or folder has its artifacts on disk. The board
// MATERIALIZES them at capture (born tracked) — this module is the catch-up path:
// it indexes a type's artifacts and reconciles them into the store (migration,
// external edits). The store stays the source of truth (docs/distribution.md).

// Glob a pattern under root, optionally subtracting an exclude pattern.
export async function indexDocs(root, pattern, exclude) {
  const out = [];
  for await (const rel of glob(pattern, { cwd: root })) out.push(rel);
  if (!exclude) return out.sort();
  const skip = new Set();
  for await (const rel of glob(exclude, { cwd: root })) skip.add(rel);
  return out.filter((p) => !skip.has(p)).sort(); // e.g. *.md excluding *.brief.md
}

// Where a type's frontmatter lives, as a glob. For a file embodiment that's the
// file itself; for a folder it's the marker inside each workspace. {slug} -> *.
function artifactIndex(def) {
  const toGlob = (p) => p.replace(/\{[^}]+\}/g, '*'); // {slug} + any lane token: content/{website}/{slug}.md -> content/*/*.md
  if (def.nested) {
    // a TREE: records at any depth under the type's root; the enclosing folders are
    // the taxonomy. base = the path prefix before {slug}; the leaf keeps the ext.
    const base = def.path.slice(0, def.path.indexOf('{'));
    const ext = def.path.slice(def.path.lastIndexOf('.'));
    return { pattern: `${base}**/*${ext}`, base, nested: true, folder: false };
  }
  const index = toGlob(def.path);
  if (def.embodiment === 'folder') {
    return { pattern: `${index}/${def.marker ?? '.kanbento-space'}`, folder: true };
  }
  return { pattern: index, exclude: def.exclude ? toGlob(def.exclude) : undefined, folder: false };
}

// The lane/field values a path ENCODES, by matching it against the type's path
// template: content/{website}/{slug}.md vs content/site-a/a.md -> {website:'site-a'}.
// {slug} is the artifact name, not a field, so it's matched but dropped. The
// inverse of capture's interpolation — an externally-created file lands in the
// right lane, so the field flows back from the embodiment (one source of truth).
export function fieldsFromPath(def, path) {
  const parts = (def.path ?? '').split(/\{([^}]+)\}/); // literals at even indices, token names at odd
  if (parts.length < 2) return {};
  const tokens = [];
  let re = '^';
  parts.forEach((p, i) => {
    if (i % 2 === 0) re += p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else { re += '([^/]+)'; tokens.push(p); }
  });
  const m = new RegExp(re + '$').exec(path);
  if (!m) return {};
  const out = {};
  tokens.forEach((t, i) => { if (t !== 'slug') out[t] = m[i + 1]; });
  return out;
}

// Extract one token's value from a path by matching it against a type's template:
// pathToken('sites/{slug}.md', 'sites/quantify.md', 'slug') -> 'quantify'. Sibling
// of fieldsFromPath (which drops slug); here any single token can be pulled.
function pathToken(template, path, token) {
  const parts = (template ?? '').split(/\{([^}]+)\}/);
  if (parts.length < 2) return null;
  const names = [];
  let re = '^';
  parts.forEach((p, i) => {
    if (i % 2 === 0) re += p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else { re += '([^/]+)'; names.push(p); }
  });
  const m = new RegExp(re + '$').exec(path);
  if (!m) return null;
  const idx = names.indexOf(token);
  return idx >= 0 ? m[idx + 1] : null;
}

// Index a type's artifacts for the GRAPH layer (the refs scan). Unlike readType,
// this needs no `status` field (records may have none) and is not stage-oriented:
// it returns each artifact's CURIE (type:slug), identity, title, and its `refs`
// relation map (from frontmatter). Reuses artifactIndex / indexDocs / readFrontmatter.
export async function indexRecords(def, root, { withBody = false } = {}) {
  const { pattern, exclude, folder, nested, base } = artifactIndex(def);
  const idField = def.identity ?? 'kanbento_id';
  const out = [];
  for (const path of await indexDocs(root, pattern, exclude)) {
    const { data, body } = await readFrontmatter(join(root, path));
    const home = folder ? dirname(path) : path; // the workspace folder, or the file
    let slug, parent = null, ancestors = [];
    if (nested) {
      // leaf = filename; the folders between base and the file ARE the taxonomy.
      const segs = path.slice(base.length, path.lastIndexOf('.')).split('/'); // ['ontology','knowledge-mining']
      slug = segs.pop();
      ancestors = segs.map((s) => `${def.id}:${s}`); // root → … → parent, as CURIEs
      parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
    } else {
      slug = pathToken(def.path, home, 'slug');
    }
    out.push({
      path,
      home,
      identity: data[idField] ?? home,
      curie: slug ? `${def.id}:${slug}` : null,
      title: data.title ?? home,
      type: def.id,
      status: data[def.status?.field ?? 'status'] ?? null, // the record's declared lifecycle state, if any
      verified: data.verified ?? null, // reaffirmation stamp: git:<sha> or date:<ISO> — the curation check clock
      revised: data.revised ?? null, // the edit clock — stamped at creation, reset on elaborate
      cadence: data.cadence ?? null, // a procedure's rhythm ('<n> commits' | '<n>d') — feeds last-ran/due
      runner: data.runner ?? null, // a procedure's declared runner grant ({ model?, tools? }) — least-privilege needs
      parent, // the enclosing folder as a CURIE (nested types); null at the root
      ancestors,
      refs: data.refs ?? null,
      fields: fieldsFromPath(def, home),
      ...(withBody ? { body } : {}), // the prose body — only when a reader (lint) asks
    });
  }
  return out;
}

// Read a type's artifacts into the card states the store should reflect. An
// artifact missing the status field is skipped (not in the pipeline). The card
// binds to the frontmatter file (the file, or a folder's marker).
export async function readType(def, root) {
  const { pattern, exclude, folder } = artifactIndex(def);
  const statusField = def.status?.field ?? 'status';
  const idField = def.identity ?? 'kanbento_id';
  const docs = [];
  for (const path of await indexDocs(root, pattern, exclude)) {
    const { data } = await readFrontmatter(join(root, path));
    const raw = data[statusField];
    if (raw == null) continue;
    const stage = def.status?.map?.[raw] ?? raw;
    const home = folder ? dirname(path) : path; // the workspace folder, or the file
    const fields = { ...fieldsFromPath(def, home) }; // lane values the path encodes (content/{website}/…)
    for (const [cardKey, fmKey] of Object.entries(def.fields ?? {})) {
      if (data[fmKey] !== undefined) fields[cardKey] = data[fmKey]; // frontmatter overrides the path
    }
    docs.push({ identity: data[idField] ?? home, path, stage, type: def.id, title: data.title ?? home, fields });
  }
  return docs;
}

// Push board state back to an artifact's frontmatter (board -> doc): write the
// status value each card's stage maps to, when it differs.
export async function writeBack(cards, def, root) {
  const field = def.status?.field ?? 'status';
  const reverse = {};
  for (const [val, stage] of Object.entries(def.status?.map ?? {})) reverse[stage] = val;
  let written = 0;
  for (const c of cards) {
    if (!c.binding?.path) continue;
    const statusValue = reverse[c.state] ?? c.state; // identity map when none declared
    const abs = join(root, c.binding.path);
    if (!existsSync(abs)) continue;
    const { data } = await readFrontmatter(abs);
    if (data[field] !== statusValue) {
      await writeFrontmatterField(abs, field, statusValue);
      written++;
    }
  }
  return written;
}
