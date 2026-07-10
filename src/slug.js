// Slugify a title into a stable, human-typeable handle component: lowercase,
// non-alphanumerics collapsed to single dashes, trimmed, capped at a word
// boundary. The same transform names an artifact file and mints a card's handle,
// so a card's slug lines up with its CURIE. PURE — no fs, no deps.
//
// Truncation cuts at the last dash at or before `max` (whole words, never a
// dangling fragment); a single over-long word is hard-cut. Empty -> 'untitled'.
// The default is deliberately tight: a 2-3 word stub reads as a tag beside the
// title, not a second copy of it. An essay-titled card that wants a precise
// handle is better given a deliberate --slug.
export function slugify(s, max = 18) {
  const base = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return 'untitled';
  if (base.length <= max) return base;
  let end = base.lastIndexOf('-', max); // last whole-word boundary at/before the cap (== max when a word ends there)
  if (end <= 0) end = max; // a single over-long word: hard-cut it
  return base.slice(0, end).replace(/-+$/, '');
}

// Sanitize an EXPLICIT --slug: the operator's chosen word, not a tag generated
// from a title. Shares slugify's BASE charset transform (lowercase, non-
// alphanumerics collapsed to single dashes, edges trimmed) — which by
// construction neutralizes path separators, `..` traversal, and absolute-path
// fragments, since none of `/ \ . :` survive — but applies NO word-boundary
// cap. Why differ from a derived slug: slugify's own docstring promises an
// explicit --slug is "kept literal" (an operator asking for a precise handle
// means it), so silently shortening it corrupts their word. Guardrails are
// loud, never silent: empty after sanitizing throws, and a pathological length
// (>128) throws — a clear error beats a quiet truncation. PURE — no fs, no deps.
export function explicitSlug(s) {
  const raw = String(s ?? '');
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) throw new Error(`--slug '${raw}' has no usable characters`);
  if (base.length > 128) throw new Error('--slug exceeds 128 chars');
  return base;
}

// Leading words a work-item title tends to open with — an imperative verb or an
// article — that name nothing on their own ("reconsider/remove the → Next line" ->
// "reconsider-remove"). Stripped so a DERIVED handle lands on the subject.
const LEAD_STOP = new Set([
  'the', 'a', 'an',
  'add', 'fix', 'remove', 'drop', 'delete', 'implement', 'refactor', 'update',
  'create', 'improve', 'make', 'build', 'rename', 'reconsider', 'introduce', 'enable',
]);

function stripLead(s) {
  const words = String(s ?? '').trim().split(/[\s/]+/);
  let i = 0;
  while (i < words.length - 1 && LEAD_STOP.has(words[i].toLowerCase().replace(/[^a-z]/g, ''))) i++;
  return words.slice(i).join(' ') || String(s ?? '');
}

// A slug DERIVED from a title: strip the leading verb/article, then slugify. An
// explicit --slug bypasses this and goes straight through slugify (kept literal).
export function titleSlug(title, max = 18) {
  return slugify(stripLead(title), max);
}
