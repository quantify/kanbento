#!/usr/bin/env node
// board-activity.mjs — board events in a window, grouped by card, in a deterministic text
// report. The status-update procedure's `extract` beat runs this verbatim alongside
// git-activity.sh: board events are pre-joined (each names its card), so this is the
// authoritative half of the evidence set. Zero dependencies — it must run standalone from
// a served brief, never importing the kanbento internals. Fail-soft throughout: a missing
// board / events file / empty window all exit 0 with a single explanatory line.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function parseArgs(argv) {
  const out = { since: null, until: null, board: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') out.since = argv[++i] ?? null;
    else if (a === '--until') out.until = argv[++i] ?? null;
    else if (a === '--board') out.board = argv[++i] ?? null;
    else { process.stderr.write(`board-activity: unknown argument: ${a}\n`); process.exit(2); }
  }
  return out;
}

// Walk up from `start` for a .kanbento dir that actually holds an events.jsonl (the log is
// the thing we read — a bare .kanbento without one is not the board we want).
function findEventsFile(start) {
  let dir = start;
  for (;;) {
    const f = join(dir, '.kanbento', 'events.jsonl');
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) return null; // reached the filesystem root without a log
    dir = up;
  }
}

// The one essential detail per event type — what the report line carries beyond the type.
// Unknown types degrade to their raw type name (still a dated line, never a crash).
function detailOf(e) {
  switch (e.type) {
    case 'ItemCaptured': return `landed ${e.landing ?? '?'}${e.cardType ? ` (${e.cardType})` : ''}`;
    case 'CardTransitioned': return `${e.from ?? '?'} → ${e.to ?? '?'}${e.via ? ` (${e.via})` : ''}`;
    case 'CardSlugged': return `slug ${e.slug ?? ''}`.trim();
    case 'CardRetitled': return `title ${e.title ?? ''}`.trim();
    case 'CardBound': return 'bound doc';
    case 'CardLinked': return `+${e.rel ?? 'rel'} → ${e.target ?? '?'}`;
    case 'CardUnlinked': return `-${e.rel ?? 'rel'} → ${e.target ?? '?'}`;
    case 'CardArchived': return `archived${e.stage ? ` @ ${e.stage}` : ''}`;
    case 'CardsMerged': return `merged ${e.from ?? '?'} → ${e.into ?? '?'}`;
    case 'ProcedureInvoked': return `ran ${e.curie ?? ''}`.trim();
    default: return '';
  }
}

// The card this event is about — id preferred (stable), slug as a fallback. Events with
// neither (procedure invocations, structure mutations, run markers) are board-level.
function cardKeyOf(e) {
  return e.cardId ?? e.card ?? e.slug ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Default window is yesterday — the last full calendar day, local time.
  //   neither flag → since = local start of yesterday, until = local start of today
  //   --since alone → until unbounded
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday.getTime() - 86400000);

  let since, until;
  if (args.since == null && args.until == null) {
    since = startYesterday.toISOString();
    until = startToday.toISOString();
  } else {
    since = args.since ?? new Date(0).toISOString(); // --until alone → unbounded start
    until = args.until; // may be null → unbounded end
  }
  const sinceMs = Date.parse(since);
  const untilMs = until != null ? Date.parse(until) : null;

  const root = args.board ? join(args.board) : process.cwd();
  // An explicit --board points AT a repo (its .kanbento inside) or a .kanbento itself; a
  // bare run walks up from cwd. Try <board>/.kanbento/events.jsonl, then <board>/events.jsonl.
  let file = null;
  if (args.board) {
    for (const cand of [join(root, '.kanbento', 'events.jsonl'), join(root, 'events.jsonl')]) {
      if (existsSync(cand)) { file = cand; break; }
    }
  } else {
    file = findEventsFile(root);
  }
  if (!file) { console.log('board-activity: no board found (no .kanbento/events.jsonl) — no board evidence available'); return; }

  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch { console.log(`board-activity: cannot read ${file} — no board evidence available`); return; }

  // Parse line by line; malformed lines are skipped silently (a truncated tail must never
  // sink the extract). Keep only events at/after the window start.
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (!e || typeof e !== 'object' || !e.at) continue;
    const t = Date.parse(e.at);
    // Half-open window: since <= at < until (until unbounded when null).
    if (!Number.isFinite(t) || t < sinceMs) continue;
    if (untilMs != null && t >= untilMs) continue;
    events.push(e);
  }

  console.log(`# board events since ${since} until ${until ?? 'now'} (${file})`);
  if (!events.length) { console.log('no board events in window'); return; }

  // Group by card, board-level last. A card's latest ItemCaptured body/title (first ~60
  // chars) labels its header when derivable — otherwise just the key.
  const groups = new Map();
  const boardLevel = [];
  for (const e of events) {
    const key = cardKeyOf(e);
    if (key == null) { boardLevel.push(e); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const titleOf = (evs) => {
    for (const e of evs) {
      const t = e.title ?? e.body;
      if (t) return String(t).replace(/\s+/g, ' ').slice(0, 60);
    }
    return null;
  };
  const emailOf = (e) => (e.principal && e.principal.email) ? e.principal.email : '';
  const lineOf = (e) => {
    const d = detailOf(e);
    const who = emailOf(e);
    return `  ${e.at} · ${e.type}${d ? ` · ${d}` : ''}${who ? ` · ${who}` : ''}`;
  };

  for (const key of [...groups.keys()].sort()) {
    const evs = groups.get(key).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const title = titleOf(evs);
    console.log(`\n## ${key}${title ? ` — ${title}` : ''}`);
    for (const e of evs) console.log(lineOf(e));
  }
  if (boardLevel.length) {
    console.log('\n## board-level');
    for (const e of boardLevel.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))) console.log(lineOf(e));
  }
}

main();
