import MiniSearch from 'minisearch';
import { recordScopes, matchesScope } from './scope.js';

// `kanbento search` — ranked whole-store recall. The index is built in memory over the
// whole knowledge base (every record type AND every card, archived included, plus
// vendored docs stubs), queried once, and thrown away — the derive-on-read doctrine,
// no persisted index, no staleness machinery. This module is the pure engine:
// `toDocuments` folds records+cards+vendor stubs into a flat doc set, `parseQuery`
// maps the flat grammar onto a MiniSearch query object, and `search` runs the two
// together. The CLI wraps it (loads the store, prints the lines).

// Fields the index reads. title/slug carry the strong signal (a half-remembered name);
// body is the long tail. Boosting (below) makes title/slug outrank body on a tie.
const FIELDS = ['title', 'slug', 'description', 'body'];
// What each hit carries back for rendering — the id fields plus the body (for a snippet).
const STORE_FIELDS = ['ref', 'curie', 'kind', 'type', 'title', 'label', 'slug', 'body', 'archived', 'scope'];

// The uppercase-only reserved words. Terms are case-folded by the tokenizer, so a
// lowercase `and` is an ordinary searchable term — no escaping mechanism is needed.
const OPERATORS = new Set(['AND', 'OR', 'NOT']);
const isOperator = (t) => OPERATORS.has(t);

// Fold the store's records + cards + vendor stubs into flat search documents. A record
// is addressed by its CURIE (type:slug); a card by its handle (slug@id); a vendor stub
// by its source URL (or vendor path). `kind` distinguishes them; `type` feeds the
// opt-in `--type` narrow. Vendor stubs carry no product scope — `--scope` excludes them.
export function toDocuments({ records = [], cards = [], vendors = [] } = {}) {
  const docs = [];
  for (const r of records) {
    docs.push({
      id: `record:${r.curie ?? r.path}`,
      kind: 'record',
      ref: r.curie ?? r.path,
      curie: r.curie ?? null,
      type: r.type ?? null,
      title: r.title ?? '',
      label: r.title ?? '',
      slug: r.slug ?? (r.curie ? r.curie.split(':').slice(1).join(':') : '') ?? '',
      description: r.description ?? '',
      body: r.body ?? '',
      scope: recordScopes(r.scope), // zero-or-more; empty = universal (applies everywhere when --scope is omitted)
    });
  }
  for (const c of cards) {
    docs.push({
      id: `card:${c.id}`,
      kind: 'card',
      ref: c.ref ?? (c.slug ? `${c.slug}@${String(c.id).slice(0, 8)}` : String(c.id).slice(0, 8)),
      curie: null,
      type: c.type ?? null,
      title: c.title ?? '', // authored only — a synthetic summary must never earn the title boost
      label: c.label ?? c.title ?? '', // what the hit line prints
      slug: c.slug ?? '',
      description: c.description ?? '',
      body: c.body ?? '',
      // Frozen history stays in the index at full rank — the hit line wears the state
      // so the reader weighs relevance vs liveness itself (annotate, don't down-rank).
      archived: Boolean(c.archived),
      scope: c.scope ?? null, // at most one; null = unscoped (a card, unlike a record, is never universal)
    });
  }
  for (const v of vendors) {
    docs.push({
      id: `vendor:${v.url ?? v.path}`,
      kind: 'vendor',
      ref: v.url ?? v.path, // URL is the stub's identity; path is the fallback
      curie: null,
      type: 'vendor',
      title: v.title ?? '',
      label: v.title ?? '',
      slug: v.path ?? '',
      description: v.url ?? '',
      body: v.body ?? '',
      scope: [], // no product scope — matchesScope on an empty list excludes --scope
    });
  }
  return docs;
}

// Build the in-memory MiniSearch index over the documents. Fuzzy + prefix are the
// search-time defaults (the half-remembered-slug case); boost lifts title/slug over body.
export function buildIndex(docs) {
  const mini = new MiniSearch({
    fields: FIELDS,
    storeFields: STORE_FIELDS,
    // A term missing on a doc must not blow up the tokenizer.
    extractField: (doc, field) => doc[field] ?? '',
  });
  mini.addAll(docs);
  return mini;
}

// The search-time options: prefix + fuzzy on, title/slug boosted above body.
const SEARCH_OPTIONS = { prefix: true, fuzzy: 0.2, boost: { title: 3, slug: 3 } };

// Parse the flat v1 grammar. Tokens are whitespace-split; uppercase AND/OR/NOT are the
// only reserved words. Returns { include, exclude, combineWith } — `include` the positive
// terms, `exclude` the NOT arm, `combineWith` 'AND' | 'OR'. Throws on a mixed AND/OR query
// (the one hard error — no silent misparse). One connective kind per query; no parens, no
// field scoping.
export function parseQuery(tokens) {
  const toks = tokens.filter((t) => t != null && String(t).length > 0).map(String);
  const ops = new Set(toks.filter(isOperator));
  if (ops.has('AND') && ops.has('OR')) {
    throw new Error(
      'search: a query mixes AND and OR — v1 allows one connective kind per query. Run two searches (one AND, one OR) and combine the results yourself.',
    );
  }
  const notAt = toks.indexOf('NOT');
  const posToks = notAt >= 0 ? toks.slice(0, notAt) : toks;
  const negToks = notAt >= 0 ? toks.slice(notAt + 1) : [];
  const include = posToks.filter((t) => !isOperator(t));
  const exclude = negToks.filter((t) => !isOperator(t));
  // AND when the caller wrote it; OR is the default (bare terms, and the NOT positive arm).
  const combineWith = ops.has('AND') ? 'AND' : 'OR';
  return { include, exclude, combineWith };
}

// Run one query over the store. Builds the index per invocation (thrown away on return),
// maps the grammar onto MiniSearch, applies the opt-in `--type` narrow, and caps at
// `limit` (default 10). Zero hits is a normal empty array, never an error.
export function search({ records = [], cards = [], vendors = [] } = {}, queryTokens = [], { type, scope, limit = 10 } = {}) {
  const { include, exclude, combineWith } = parseQuery(queryTokens);
  if (!include.length) return []; // nothing positive to match on — a normal empty result
  const mini = buildIndex(toDocuments({ records, cards, vendors }));

  const positive = { combineWith, queries: include };
  const query = exclude.length
    ? { combineWith: 'AND_NOT', queries: [positive, { combineWith: 'OR', queries: exclude }] }
    : positive;

  let hits = mini.search(query, SEARCH_OPTIONS);
  if (type) hits = hits.filter((h) => h.type === type); // opt-in narrow, applied post-rank
  // --scope narrow is STRICT: a card matches only its own scope; a record matches
  // when its scopes include it. Universal records (none) are excluded — drop the
  // flag to search everything.
  if (scope) hits = hits.filter((h) => matchesScope(h.kind, h.scope, scope));
  const capped = hits.slice(0, Math.max(0, limit));
  return capped.map((h) => ({
    score: h.score,
    ref: h.ref,
    kind: h.kind,
    type: h.type,
    title: h.label || h.title,
    archived: Boolean(h.archived),
    scope: h.scope ?? (h.kind === 'card' ? null : []),
    snippet: snippet(h.body, include),
  }));
}

// A short hit snippet: a window around the first matched term in the body, else the head
// of the body. Purely cosmetic — the ranking already happened. Whitespace-collapsed.
export function snippet(body, terms, width = 80) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(String(t).toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.length > width ? text.slice(0, width).trimEnd() + '…' : text;
  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = text.slice(start, start + width).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + width < text.length ? '…' : ''}`;
}
