import { existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { readFrontmatter } from './frontmatter.js';

// `kanbento vendor <url>` — sitemap stubs. Discover the site's sitemap, prefix-filter
// the urlset by the given URL, write one stub per URL under `.kanbento/vendor/<host>/…`,
// and GET each page for STRUCTURE only (title, description, h1–h6 outline). Never prose.
// Stubs are a third search kind (`vendor`), not records.

export const VENDOR_CONCURRENCY = 4;
export const VENDOR_PAGE_TIMEOUT_MS = 10_000;
export const VENDOR_RETRY_MAX = 2; // additional attempts after the first
export const VENDOR_RETRY_BASE_MS = 500;
export const VENDOR_RETRY_CAP_MS = 5_000;

const RETRYABLE = new Set([429, 503]);

const SITEMAP_ROOT = /<(?:[\w.-]+:)?(urlset|sitemapindex)\b/i;
const TAG = (name) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, 'gi');

export function isSitemapXml(text) {
  return SITEMAP_ROOT.test(String(text ?? ''));
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function firstTagBlock(html, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i');
  const m = String(html).match(re);
  return m ? m[0] : null;
}

export function parseUrlArg(raw) {
  const s = String(raw ?? '').trim();
  let u;
  try { u = new URL(s); } catch {
    throw new Error(`vendor: "${raw}" is not a URL — pass a public docs site, e.g. https://docs.example.com/guide/`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('vendor: <url> must be http(s) — a public docs site');
  }
  return u;
}

export function normalizeUrlPath(url) {
  const u = typeof url === 'string' ? new URL(url) : url;
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { host: u.host, path: path || '/' };
}

// Identity of a docs page: origin + pathname, no query/hash. Strip a trailing
// slash and a trailing `.md` so the HTML loc and its markdown variant collide.
export function canonicalPageUrl(url) {
  const u = typeof url === 'string' ? new URL(url) : new URL(String(url));
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path.toLowerCase().endsWith('.md')) {
    path = path.slice(0, -3);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (!path) path = '/';
  }
  return `${u.origin}${path || '/'}`;
}

// `<url>.md` — strip a trailing slash, then append `.md` (no double suffix).
export function markdownVariantUrl(url) {
  const u = new URL(url);
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!path.toLowerCase().endsWith('.md')) u.pathname = `${path}.md`;
  return u.href;
}

export function urlMatchesPrefix(url, prefixUrl) {
  const u = normalizeUrlPath(url);
  const p = normalizeUrlPath(prefixUrl);
  if (u.host !== p.host) return false;
  if (p.path === '/') return true;
  return u.path === p.path || u.path.startsWith(`${p.path}/`);
}

export function isUnfilteredPrefix(prefixUrl) {
  return normalizeUrlPath(prefixUrl).path === '/';
}

function safeSegment(seg) {
  let s;
  try { s = decodeURIComponent(seg); } catch { s = String(seg); }
  s = s.replace(/\0/g, '').trim();
  if (!s || s === '.' || s === '..') return null;
  return s;
}

// Host = top folder. Leaf → `<segment>.md`; a URL with children in `urls` → `<segment>/index.md`.
// The site root is always `index.md` (no file sitting next to the host folder).
// Path identity is the canonical HTML page, never the `.md` fetch variant.
export function stubRelPath(url, urls = []) {
  const { host, path } = normalizeUrlPath(canonicalPageUrl(url));
  const peers = [];
  for (const raw of urls) {
    try {
      const n = normalizeUrlPath(canonicalPageUrl(raw));
      if (n.host === host) peers.push(n.path);
    } catch { /* skip a malformed loc */ }
  }
  const prefix = path === '/' ? '/' : `${path}/`;
  const branched = path === '/' || peers.some((p) => p !== path && p.startsWith(prefix));
  const segs = path === '/' ? [] : path.slice(1).split('/').map(safeSegment).filter(Boolean);
  const file = branched || segs.length === 0 ? [...segs, 'index.md'].join('/') : `${segs.join('/')}.md`;
  return `${host}/${file}`;
}

export function parseSitemap(xml, baseUrl) {
  const text = String(xml ?? '');
  const root = text.match(SITEMAP_ROOT);
  if (!root) return null;
  const kind = root[1].toLowerCase();
  const resolve = (loc) => {
    const href = decodeEntities(loc).trim();
    if (!href) return null;
    try { return new URL(href, baseUrl).href; } catch { return null; }
  };
  if (kind === 'sitemapindex') {
    const locs = [];
    for (const m of text.matchAll(TAG('sitemap'))) {
      const loc = [...m[2].matchAll(TAG('loc'))][0]?.[2];
      const href = loc ? resolve(loc) : null;
      if (href) locs.push(href);
    }
    return { type: 'index', locs };
  }
  const urls = [];
  for (const m of text.matchAll(TAG('url'))) {
    const loc = [...m[2].matchAll(TAG('loc'))][0]?.[2];
    const lastmod = [...m[2].matchAll(TAG('lastmod'))][0]?.[2];
    const href = loc ? resolve(loc) : null;
    if (href) urls.push({ loc: href, lastmod: lastmod ? decodeEntities(lastmod).trim() : null });
  }
  return { type: 'urlset', urls };
}

export function findSitemapLink(html, pageUrl) {
  const head = firstTagBlock(html, 'head') ?? html;
  for (const m of String(head).matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('sitemap')) continue;
    const href = attr(m[0], 'href');
    if (!href) continue;
    try { return new URL(href, pageUrl).href; } catch { continue; }
  }
  return null;
}

function headingAnchor(open, inner) {
  const onTag = attr(open, 'id') || attr(open, 'name');
  if (onTag) return onTag;
  for (const t of inner.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const id = attr(t[0], 'id') || attr(t[0], 'name');
    if (id) return id;
  }
  for (const t of inner.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(t[0], 'href');
    if (href && href.startsWith('#') && href.length > 1) return decodeURIComponent(href.slice(1));
  }
  return null; // no invented slug — only a real id earns `→ #anchor`
}

export function extractHeadings(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = stripTags(m[3]);
    if (!text) continue;
    const level = Number(m[1]);
    const anchor = headingAnchor(m[0].slice(0, m[0].indexOf('>') + 1), m[3]);
    out.push({ level, text, anchor });
  }
  return out;
}

export function extractPage(html) {
  const raw = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const head = firstTagBlock(raw, 'head') ?? raw;
  const title = stripTags((head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i) ?? [])[1] ?? '');
  let description = '';
  let og = '';
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') ?? '').toLowerCase();
    const prop = (attr(m[0], 'property') ?? '').toLowerCase();
    const content = attr(m[0], 'content') ?? '';
    if (!content) continue;
    if (name === 'description' && !description) description = content.replace(/\s+/g, ' ').trim();
    if (prop === 'og:description' && !og) og = content.replace(/\s+/g, ' ').trim();
  }
  if (!description) description = og;
  const stripped = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Chrome out of the outline: nav/footer/aside. Keep <header> — its h1 is the page name.
  const content = stripped.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const main = firstTagBlock(content, 'main');
  const article = firstTagBlock(content, 'article');
  const region = (main && extractHeadings(main).length && main)
    || (article && extractHeadings(article).length && article)
    || content;
  const regionHeadings = extractHeadings(region);
  // `<title>` is frontmatter only. Every h* goes in the body — including an h1
  // that lives in <header> outside <main>, which a main-only scan would drop.
  const seen = new Set(regionHeadings.map((h) => `${h.level}\0${h.text}\0${h.anchor ?? ''}`));
  const missingH1 = extractHeadings(content).filter((h) => h.level === 1 && !seen.has(`${h.level}\0${h.text}\0${h.anchor ?? ''}`));
  return { title: title || null, description: description || null, headings: [...missingH1, ...regionHeadings] };
}

function yamlLine(key, value) {
  return yaml.dump({ [key]: value }, { lineWidth: -1 }).trim();
}

export function renderStub({ url, canonical, title, lastmod, fetched, description, headings }) {
  const fm = ['---', yamlLine('url', url)];
  if (canonical) fm.push(yamlLine('canonical', canonical));
  if (title) fm.push(yamlLine('title', title));
  if (lastmod) fm.push(yamlLine('lastmod', lastmod));
  fm.push(yamlLine('fetched', fetched));
  fm.push('---');
  const lines = [fm.join('\n'), ''];
  if (description) lines.push(description, '');
  for (const h of headings ?? []) {
    const n = Math.max(1, Math.min(6, Number(h.level) || 1));
    const hashes = '#'.repeat(n);
    const arrow = h.anchor ? ` → #${h.anchor}` : '';
    lines.push(`- ${hashes} ${h.text}${arrow}`);
  }
  if ((headings ?? []).length) lines.push('');
  return lines.join('\n');
}

// Seconds form of Retry-After (capped). HTTP-date or missing → exponential backoff.
export function retryDelayMs(retryAfter, attempt) {
  const raw = retryAfter == null ? '' : String(retryAfter).trim();
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, VENDOR_RETRY_CAP_MS);
  return Math.min(VENDOR_RETRY_CAP_MS, VENDOR_RETRY_BASE_MS * (2 ** attempt));
}

function headerGet(res, name) {
  return typeof res?.headers?.get === 'function' ? res.headers.get(name) : null;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_ACCEPT = 'text/html, application/xml, text/xml, */*';

async function fetchOnce(url, { timeout, fetchFn, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { accept: DEFAULT_ACCEPT, 'user-agent': 'kanbento-vendor', ...headers },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text,
      url: res.url ?? url,
      retryAfter: headerGet(res, 'retry-after'),
      contentType: headerGet(res, 'content-type'),
    };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, error, contentType: null };
  } finally {
    clearTimeout(timer);
  }
}

// On 429/503 retry a couple of times. A site that keeps 429ing degrades after N
// attempts — never hangs. `sleep` is injectable so tests can assert waits.
// Extra `headers` overlay the default Accept (used for `Accept: text/markdown`
// probes); omitted, HTML/sitemap fetches keep DEFAULT_ACCEPT.
export async function fetchText(url, {
  timeout = VENDOR_PAGE_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
  retries = VENDOR_RETRY_MAX,
  sleep = sleepMs,
  headers,
} = {}) {
  let last = { ok: false, status: 0, text: '', url };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fetchOnce(url, { timeout, fetchFn, headers });
    if (last.ok || !RETRYABLE.has(last.status) || attempt === retries) return last;
    await sleep(retryDelayMs(last.retryAfter, attempt));
  }
  return last;
}

function mediaType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

function looksLikeHtmlDocument(text) {
  const s = String(text ?? '').trimStart();
  return /^<!doctype\s+html/i.test(s) || /^<html[\s>]/i.test(s);
}

// Soft-404 guard: 200 is not enough. HTML content-type or an HTML-looking body
// is reject. Markdown types + a non-HTML body accept; text/plain accepts only
// when the body is not an HTML document.
export function isMarkdownResponse(got) {
  if (!got?.ok) return false;
  if (looksLikeHtmlDocument(got.text)) return false;
  const ct = mediaType(got.contentType);
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return false;
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return true;
  if (ct === 'text/plain') return true;
  return false;
}

export const MD_VARIANT_SAMPLES = 3;

// Leaf = a real page path, not the site root and not a trailing-slash index.
function isLeafLoc(url) {
  try {
    const path = new URL(url).pathname || '/';
    return path !== '/' && !path.endsWith('/');
  } catch {
    return false;
  }
}

// Vote on leaves when any exist so section-index-first sitemaps (and `/`) cannot
// veto a leaf `<url>.md` convention. Directory locs stay in the pool only when
// the urlset has no leaves.
function markdownSampleLocs(locs) {
  const leaves = [];
  const dirs = [];
  for (const loc of locs) {
    if (isLeafLoc(loc)) leaves.push(loc);
    else dirs.push(loc);
  }
  return leaves.length ? leaves : dirs;
}

// Leaves: `<url>.md`. Directories: `index.md` then `dir.md` — strip-slash + `.md`
// alone misses hosts that publish `/docs/guide/index.md` and would probe `/.md`
// for the site root.
function markdownExtProbeUrls(url) {
  const u = new URL(url);
  const path = u.pathname || '/';
  if (path === '/') {
    u.pathname = '/index.md';
    return [u.href];
  }
  if (path.endsWith('/')) {
    const stripped = path.replace(/\/+$/, '');
    const indexMd = new URL(url);
    indexMd.pathname = `${stripped}/index.md`;
    const dirMd = new URL(url);
    dirMd.pathname = `${stripped}.md`;
    return [indexMd.href, dirMd.href];
  }
  return [markdownVariantUrl(url)];
}

// Fetch target once the host convention holds: the URL the detector probes first
// (leaf `<url>.md`; `/` and trailing-slash dirs → `index.md`). Not strip-slash +
// `.md`, which would advertise `/.md` / `/docs.md` the probe already skipped.
function markdownFetchUrl(url) {
  return markdownExtProbeUrls(url)[0];
}

// Per-host, not per-page. Prefer leaf locs; a 404 `.md` probe is uninformative
// (skip the loc); a 200 HTML shell is a true no. Candidates — including 404
// skips — are capped at MD_VARIANT_SAMPLES so detection GETs cannot grow with
// urlset size; after the budget with no informative vote, return false.
// Convention holds if every informative sample in that budget is markdown.
// Content-neg is tried first (does not rewrite `url:` — no variant URL to point at).
async function hostServesMarkdownExt(locs, { fetchFn, timeout, sleep } = {}) {
  const samples = markdownSampleLocs(locs).slice(0, MD_VARIANT_SAMPLES);
  if (!samples.length) return false;
  let yes = 0;
  for (const loc of samples) {
    await fetchText(loc, { fetchFn, timeout, sleep, headers: { accept: 'text/markdown' } });
    let informativeNo = false;
    let informativeYes = false;
    for (const probe of markdownExtProbeUrls(loc)) {
      const ext = await fetchText(probe, { fetchFn, timeout, sleep });
      if (!ext.ok) continue; // 404 / 5xx / network — skip this variant
      if (isMarkdownResponse(ext)) {
        informativeYes = true;
        break;
      }
      informativeNo = true;
    }
    if (informativeYes) {
      yes += 1;
      if (yes >= MD_VARIANT_SAMPLES) return true;
      continue;
    }
    if (informativeNo) return false;
  }
  return yes > 0;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  if (items.length) await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function collectUrlset(sitemapUrl, xml, { fetchFn, timeout, seen, skipped, sleep }) {
  const parsed = parseSitemap(xml, sitemapUrl);
  if (!parsed) return [];
  if (parsed.type === 'urlset') return parsed.urls;
  const out = [];
  for (const loc of parsed.locs) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    const got = await fetchText(loc, { fetchFn, timeout, sleep });
    if (!got.ok || !isSitemapXml(got.text)) {
      if (!got.ok) skipped.push({ loc, status: got.status });
      continue;
    }
    out.push(...await collectUrlset(loc, got.text, { fetchFn, timeout, seen, skipped, sleep }));
  }
  return out;
}

// robots.txt is the CANONICAL sitemap pointer (Sitemap: directive) — and the only
// discovery path for sitemaps hosted at non-default locations.
export function parseRobotsSitemaps(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

export async function discoverSitemap(pageUrl, { fetchFn, timeout, sleep } = {}) {
  const page = parseUrlArg(pageUrl);
  const fallback = `${page.origin}/sitemap.xml`;
  const attempts = []; // what was tried, with the status seen — a throttled fetch is NOT a missing sitemap
  const tryUrl = async (url, via) => {
    const got = await fetchText(url, { fetchFn, timeout, sleep });
    if (got.ok && isSitemapXml(got.text)) return { sitemapUrl: got.url, xml: got.text };
    attempts.push(`${url} (${via}: ${got.status === 0 ? 'network/timeout' : got.status})`);
    return null;
  };
  const landing = await fetchText(page.href, { fetchFn, timeout, sleep });
  if (landing.ok && isSitemapXml(landing.text)) return { sitemapUrl: landing.url, xml: landing.text };
  // A prefix is a filter, not necessarily a fetchable page — a section URL may 404
  // while the SSG's 404 shell still carries the authoritative <link rel="sitemap">.
  const linked = landing.text ? findSitemapLink(landing.text, page.href) : null;
  if (!linked) attempts.push(`${page.href} (no <link rel="sitemap">: ${landing.status === 0 ? 'network/timeout' : landing.status})`);
  if (linked) {
    const hit = await tryUrl(linked, '<link rel="sitemap">');
    if (hit) return hit;
  }
  const robots = await fetchText(`${page.origin}/robots.txt`, { fetchFn, timeout, sleep });
  const declared = robots.ok ? parseRobotsSitemaps(robots.text) : [];
  if (!robots.ok) attempts.push(`${page.origin}/robots.txt (${robots.status === 0 ? 'network/timeout' : robots.status})`);
  for (const url of declared) {
    if (url === linked) continue;
    const hit = await tryUrl(url, 'robots.txt Sitemap:');
    if (hit) return hit;
  }
  if (fallback !== page.href && fallback !== linked && !declared.includes(fallback)) {
    const hit = await tryUrl(fallback, 'default');
    if (hit) return hit;
  }
  const throttled = attempts.some((a) => /: (429|503)\)/.test(a));
  throw new Error(
    `vendor: no sitemap reached for ${page.origin} — tried ${attempts.join(', ')}.` +
      (throttled
        ? ' The site is rate-limiting (429/503) — the sitemap may exist; retry later.'
        : ' Sites without a sitemap are out of v1 (no crawl fallback).'),
  );
}

export async function loadVendorStubs(dataDir) {
  const root = join(dataDir, 'vendor');
  if (!existsSync(root)) return [];
  const out = [];
  for await (const rel of glob('**/*.md', { cwd: root })) {
    if (rel === 'AGENTS.md') continue; // the partition's operating guide, not a stub
    const { data, body } = await readFrontmatter(join(root, rel));
    const posix = String(rel).split('\\').join('/');
    out.push({
      path: `.kanbento/vendor/${posix}`,
      url: data.url ?? null,
      title: data.title ?? '',
      body: body ?? '',
    });
  }
  return out;
}

// The local operating guide for the vendor partition — written into
// .kanbento/vendor/AGENTS.md on every run (generated, gitignored with the rest).
// The board guide carries only the one-line pointer; the how-to AND the inventory
// live here, next to the stubs, where an agent that found the folder reads them.
export function renderVendorAgents(hosts) {
  return [
    '# Vendored docs — how to use this map',
    '',
    '> Generated by `kanbento vendor` — do not edit; a re-run overwrites.',
    '',
    'Vendored here:',
    '',
    ...hosts.map((h) => `- \`${h.host}/\` — ${h.count} page stub(s)`),
    '',
    'Each folder is a host; each `.md` file is a STUB of one live docs page:',
    'frontmatter `url:` (the source), `title:`, and a flat heading outline',
    '(`- ## <text> → #<anchor>`; hash count = heading level). Stubs carry',
    'structure only — the prose stays on the web.',
    '`url:` may be the `.md` fetch target; the stub path is the page identity.',
    '',
    '- Locate pages: `kanbento search <query>` indexes every stub (ranked), or browse the tree — paths mirror the URLs.',
    '- Read content: fetch the stub\'s `url:` (deep-link with an outline anchor).',
    '- A stub with only `url:` + `fetched:` is a failed fetch — re-run `kanbento vendor <url>` to retry.',
    '- Extend or refresh: `kanbento vendor <url>` — the URL path is a prefix filter; re-runs refetch bare stubs and skip healthy ones.',
    '',
  ].join('\n');
}

async function readExistingStub(abs) {
  if (!existsSync(abs)) return null;
  try { return await readFrontmatter(abs); } catch { return null; }
}

function isHealthyStub(existing) {
  const title = existing?.data?.title;
  return typeof title === 'string' && title.trim() !== '';
}

export async function vendorSite({
  dataDir,
  url,
  fetchFn = globalThis.fetch,
  now = new Date().toISOString(),
  concurrency = VENDOR_CONCURRENCY,
  timeout = VENDOR_PAGE_TIMEOUT_MS,
  log = () => {},
  sleep,
} = {}) {
  const page = parseUrlArg(url);
  const { sitemapUrl, xml } = await discoverSitemap(page.href, { fetchFn, timeout, sleep });
  const seen = new Set([sitemapUrl]);
  const skippedSitemaps = [];
  const all = await collectUrlset(sitemapUrl, xml, { fetchFn, timeout, seen, skipped: skippedSitemaps, sleep });
  const byLoc = new Map();
  for (const u of all) byLoc.set(u.loc, u);
  const filtered = [...byLoc.values()].filter((u) => urlMatchesPrefix(u.loc, page.href));
  const unfiltered = isUnfilteredPrefix(page.href);
  const host = page.host;
  if (unfiltered) {
    log(`vendor: ${filtered.length} URL(s) on ${host} — no path prefix; fetching all`);
  } else {
    log(`vendor: ${filtered.length} URL(s) under ${page.href} (of ${byLoc.size} in sitemap)`);
  }
  if (skippedSitemaps.length) {
    log(`vendor: ${skippedSitemaps.length} nested sitemap(s) unreachable — URL list may be incomplete`);
  }
  const locs = filtered.map((u) => u.loc);
  const lastmodOf = new Map(filtered.map((u) => [u.loc, u.lastmod]));
  const markdownExt = await hostServesMarkdownExt(locs, { fetchFn, timeout, sleep });
  if (markdownExt) log('vendor: host serves <url>.md — stub url: is the markdown variant');
  const failures = [];
  await mapLimit(filtered, concurrency, async (entry) => {
    const rel = stubRelPath(entry.loc, locs);
    const abs = join(dataDir, 'vendor', rel);
    // Re-run heals bare stubs (no title) and skips healthy ones.
    if (isHealthyStub(await readExistingStub(abs))) return;
    const got = await fetchText(entry.loc, { fetchFn, timeout, sleep });
    if (!got.ok) {
      failures.push({ loc: entry.loc, status: got.status });
      // Failed GET must never clobber a title that already landed.
      if (isHealthyStub(await readExistingStub(abs))) return;
    }
    let title = null, description = null, headings = [];
    // Extract only from a 2xx HTML body — an error page's <title> ("Too Many Requests")
    // must not become the stub's title; the bare stub marks the page as unfetched.
    // Detection probes are extra; page extraction never switches to the markdown GET.
    if (got.ok && got.text) {
      const extracted = extractPage(got.text);
      title = extracted.title;
      description = extracted.description;
      headings = extracted.headings;
    }
    const fetchUrl = markdownExt ? markdownFetchUrl(entry.loc) : entry.loc;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, renderStub({
      url: fetchUrl,
      canonical: markdownExt ? entry.loc : null,
      title,
      lastmod: lastmodOf.get(entry.loc) || null,
      fetched: now,
      description,
      headings,
    }), 'utf8');
  });
  const counts = new Map();
  for (const s of await loadVendorStubs(dataDir)) {
    const h = s.path.split('/')[2]; // .kanbento/vendor/<host>/...
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const hosts = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([h, count]) => ({ host: h, count }));
  await mkdir(join(dataDir, 'vendor'), { recursive: true });
  await writeFile(join(dataDir, 'vendor', 'AGENTS.md'), renderVendorAgents(hosts), 'utf8');
  return { host, written: filtered.length, urls: locs, prefix: page.href, unfiltered, total: byLoc.size, failures, skippedSitemaps };
}
