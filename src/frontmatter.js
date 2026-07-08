import { readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';

// Read/write YAML frontmatter on an existing doc. Reads parse the block; writes
// edit a single field in place (a minimal, one-line diff) so kanbento plays
// nicely with a codebase it does not own.

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export async function readFrontmatter(path) {
  const raw = await readFile(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) return { data: {}, body: raw };
  return { data: yaml.load(m[1]) ?? {}, body: raw.slice(m[0].length) };
}

// Set one frontmatter field, preserving everything else byte-for-byte.
export async function writeFrontmatterField(path, field, value) {
  const raw = await readFile(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  const block = m[1];
  const line = `${field}: ${value}`;
  const re = new RegExp(`^${field}:.*$`, 'm');
  const next = re.test(block) ? block.replace(re, line) : `${block}\n${line}`;
  await writeFile(path, raw.replace(block, next), 'utf8');
}

// Set one frontmatter field to a nested value, rendered as a YAML block (for maps
// and lists, e.g. `refs:`). Drops any existing block for the field and appends a
// freshly dumped one; sibling fields are preserved.
export async function writeFrontmatterBlock(path, field, value) {
  const raw = await readFile(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  const lines = m[1].split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${field}:`).test(lines[i])) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++; // drop indented continuation
      continue; // drop the `field:` line itself
    }
    kept.push(lines[i]);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const rendered = yaml.dump({ [field]: value }, { lineWidth: -1 }).replace(/\n+$/, '');
  await writeFile(path, raw.replace(m[1], [...kept, rendered].join('\n')), 'utf8');
}

// Drop a frontmatter field (and any indented block it owns) entirely — the inverse
// of writeFrontmatterBlock, for when a map/list empties out (no bare `refs: {}` left
// behind). Returns true if a field was removed, false if it was already absent.
export async function removeFrontmatterField(path, field) {
  const raw = await readFile(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  const lines = m[1].split('\n');
  const kept = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${field}:`).test(lines[i])) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++; // drop indented continuation
      removed = true;
      continue; // drop the `field:` line itself
    }
    kept.push(lines[i]);
  }
  if (!removed) return false;
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  await writeFile(path, raw.replace(m[1], kept.join('\n')), 'utf8');
  return true;
}
