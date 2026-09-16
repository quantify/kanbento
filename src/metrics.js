import { stages, commitStageId } from './manifest.js';

// Flow metrics — a PURE fold over the event log into three flow regions plus knowledge
// accrual. No CLI, no fs, no clock of its own: `foldMetrics(events, manifest, { now })`
// takes the full history and returns a plain model; `renderMetrics(model)` turns it into
// the shareable read-model. Every number is a fold over `.kanbento/data/events.jsonl` —
// no instrumentation added. The seams (commitment point, delivery, options) come from the
// manifest, so the metrics generalize when stages change.
//
// The doctrine (card metrics-fold): model the board as THREE regions with distinct
// dynamics, never one queue with a bare depth. Always relate a count to a rate. State the
// definitional choices inline (which types count, same-instant handling, median-vs-p85,
// the window) — flattering-by-omission is the failure mode.

const DAY_MS = 86_400_000;

// Same-instant threshold. Transitions milliseconds apart are automation bursts (a card
// captured→committed→done in one script run); their Δ≈0 poisons the median. Anything
// faster than this is treated as same-instant and excluded from the time distributions.
const SAME_INSTANT_MS = 1000;

// --- small pure stats helpers ------------------------------------------------

// Linear-interpolation percentile (numpy 'linear'): q in [0,1] over an ascending array.
export function percentile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (pos - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

// median + p85 of an unsorted numeric array (the honest pair: p85 is the headline, the
// median flatters). Returns { n, medianMs, p85Ms } — callers name the unit.
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: percentile(sorted, 0.5), p85: percentile(sorted, 0.85) };
}

// ISO-8601 week key, e.g. "2026-W29" — the throughput/trend bucket. Thursday-of-week
// rule (ISO), UTC, so a week belongs to exactly one year.
export function isoWeek(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = (new Date(t).getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const thursday = t + (3 - day) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = 1 + Math.round((thursday - jan1) / DAY_MS / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// --- window --------------------------------------------------------------

// Resolve --window into a lower time bound. '7d' | 'N' (days) | 'all'.
export function resolveWindow(spec, now) {
  if (spec == null || spec === 'all') return { spec: 'all', label: 'all time', fromMs: -Infinity, days: null };
  const m = String(spec).match(/^(\d+)d?$/);
  if (!m) throw new Error(`metrics: bad --window "${spec}" (use 7d, all, or a day count)`);
  const days = Number(m[1]);
  return { spec: `${days}d`, label: `last ${days} day${days === 1 ? '' : 's'}`, fromMs: now - days * DAY_MS, days };
}

// --- the fold ------------------------------------------------------------

// Reconstruct each card's lifecycle from the event stream: capture, the ordered
// transitions, and any archive. Pure — the events ARE the state.
function buildCards(events) {
  const byCard = new Map();
  const get = (id) => {
    let c = byCard.get(id);
    if (!c) byCard.set(id, (c = { id, capturedAt: null, cardType: null, landing: null, label: '', transitions: [], archived: null, loopTraversals: 0 }));
    return c;
  };
  for (const e of events) {
    switch (e.type) {
      case 'ItemCaptured': {
        const c = get(e.cardId);
        c.capturedAt = Date.parse(e.at);
        c.cardType = e.cardType ?? null;
        c.landing = e.landing ?? null;
        c.label = (e.title || e.body || '').replace(/\s+/g, ' ').trim();
        break;
      }
      case 'CardTransitioned': {
        const c = get(e.cardId);
        c.transitions.push({ at: Date.parse(e.at), from: e.from, to: e.to, via: e.via ?? 'forward' });
        if (e.via === 'loop' || e.loop) c.loopTraversals += 1;
        break;
      }
      case 'CardRetitled': {
        const c = get(e.cardId);
        c.label = (e.title || c.label || '').replace(/\s+/g, ' ').trim();
        break;
      }
      case 'CardArchived': {
        const c = get(e.cardId);
        c.archived = { at: Date.parse(e.at), disposition: e.disposition ?? null, stage: e.stage ?? null };
        break;
      }
    }
  }
  return byCard;
}

// Order-index of a stage in the declared flow (for "at or past the commitment point").
function stageOrder(manifest) {
  const order = new Map();
  stages(manifest).forEach((s, i) => order.set(s.id, { i, role: s.role }));
  return order;
}

// Derive the lifecycle timestamps + current placement of one card.
function lifecycle(card, order, commitIdx) {
  const roleOf = (id) => order.get(id)?.role ?? null;
  const idxOf = (id) => order.get(id)?.i ?? -1;
  let committedAt = null;
  let doneAt = null;
  for (const t of card.transitions) {
    if (committedAt == null && commitIdx >= 0 && idxOf(t.to) >= commitIdx) committedAt = t.at;
    if (doneAt == null && roleOf(t.to) === 'done') doneAt = t.at;
  }
  const currentStage = card.transitions.length ? card.transitions[card.transitions.length - 1].to : card.landing;
  const currentRole = roleOf(currentStage);
  return { committedAt, doneAt, currentStage, currentRole };
}

// The fold. `events` is the full ordered history; `manifest` supplies the seams; `now`
// (default Date.now) anchors the window + all "now" state. Returns the three-region model
// plus knowledge accrual and the meta needed for the definitional footnotes.
export function foldMetrics(events, manifest, { now = Date.now(), window = '7d' } = {}) {
  const win = resolveWindow(window, now);
  const inWindow = (ms) => ms != null && ms >= win.fromMs && ms <= now;
  const order = stageOrder(manifest);
  const commitStage = commitStageId(manifest);
  const doneStage = stages(manifest).find((s) => s.role === 'done')?.id ?? null;
  const optionsStage = stages(manifest).find((s) => s.role === 'options')?.id ?? null;
  const commitIdx = commitStage != null ? order.get(commitStage)?.i ?? -1 : -1;
  // A card is a card — a unit of work; TYPE never gates measurement. The boundaries are
  // structural: the commitment point (cycle) and the delivery point (lead/throughput).
  // Records don't appear here at all — they are `note`-created files that emit no
  // ItemCaptured event, so they never enter the log this fold reads.

  const cards = buildCards(events);
  const lc = new Map();
  for (const c of cards.values()) lc.set(c.id, lifecycle(c, order, commitIdx));

  const days = win.days ?? Math.max(1, (now - earliest(events)) / DAY_MS);
  const perDay = (n) => (days > 0 ? n / days : 0);

  // --- region 1: upstream (discovery funnel + queue lens) ---
  let arrivals = 0;
  let discards = 0;
  let merges = 0;
  let committedInWindow = 0; // pulls across the commitment point
  for (const c of cards.values()) if (inWindow(c.capturedAt)) arrivals += 1;
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (c.archived && inWindow(c.archived.at) && (c.archived.disposition === 'discarded' || c.archived.disposition === 'abandoned')) discards += 1;
    if (t.committedAt != null && inWindow(t.committedAt)) committedInWindow += 1;
  }
  for (const e of events) if (e.type === 'CardsMerged' && inWindow(Date.parse(e.at))) merges += 1;

  // Options-now (live depth) + their aging — from full history, "now" is now.
  const optionsNow = [];
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (!c.archived && t.currentRole === 'options' && c.capturedAt != null) optionsNow.push({ id: c.id, ageMs: now - c.capturedAt, label: c.label });
  }
  const pullRatePerDay = perDay(committedInWindow);
  const upstream = {
    arrivals,
    arrivalRatePerDay: perDay(arrivals),
    depthNow: optionsNow.length,
    committedInWindow,
    pullRatePerDay,
    // Little's Law: a depth is only a wait when divided by the pull rate.
    expectedWaitDays: pullRatePerDay > 0 ? optionsNow.length / pullRatePerDay : null,
    discards,
    discardRate: arrivals > 0 ? discards / arrivals : null,
    merges,
    aging: agingSummary(optionsNow),
  };

  // --- region 2: delivery (commit→done pipeline) ---
  const cycle = [];
  const lead = [];
  let cycleExcluded = 0;
  let leadExcluded = 0;
  const deliveredByWeek = new Map();
  let loopTraversals = 0;
  const reworkedCards = new Set();
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (t.doneAt != null && inWindow(t.doneAt)) {
      deliveredByWeek.set(isoWeek(t.doneAt), (deliveredByWeek.get(isoWeek(t.doneAt)) ?? 0) + 1);
      if (t.committedAt != null) {
        const d = t.doneAt - t.committedAt;
        if (d >= SAME_INSTANT_MS) cycle.push(d);
        else cycleExcluded += 1;
      }
      if (c.capturedAt != null) {
        const d = t.doneAt - c.capturedAt;
        if (d >= SAME_INSTANT_MS) lead.push(d);
        else leadExcluded += 1;
      }
    }
  }
  // Rework: loop-edge traversals in window, and the distinct cards that took them.
  for (const c of cards.values()) {
    for (const tr of c.transitions) if (tr.via === 'loop' && inWindow(tr.at)) { loopTraversals += 1; reworkedCards.add(c.id); }
  }
  // WIP now: cards past the commitment point but not yet done/archived.
  const wipNow = [];
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (c.archived) continue;
    if (t.currentRole === 'commit' || t.currentRole === 'active' || t.currentRole === 'loop') {
      const since = t.committedAt ?? c.capturedAt;
      wipNow.push({ id: c.id, ageMs: since != null ? now - since : 0, label: c.label });
    }
  }
  const throughputTotal = [...deliveredByWeek.values()].reduce((a, b) => a + b, 0);
  const cycleDist = distribution(cycle);
  const leadDist = distribution(lead);
  const delivery = {
    cycle: { n: cycleDist.n, medianMs: cycleDist.median, p85Ms: cycleDist.p85, excludedSameInstant: cycleExcluded },
    lead: { n: leadDist.n, medianMs: leadDist.median, p85Ms: leadDist.p85, excludedSameInstant: leadExcluded },
    throughputByWeek: [...deliveredByWeek.entries()].map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week)),
    throughputTotal,
    rework: { traversals: loopTraversals, cardsReworked: reworkedCards.size, ratePerDelivered: throughputTotal > 0 ? loopTraversals / throughputTotal : null },
    wipNow: wipNow.length,
    wipAging: agingSummary(wipNow),
  };

  // --- region 3: system (arrivals vs departures — the headline) ---
  let departures = 0; // deliveries in window (every card reaching done — the honest out-count)
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (t.doneAt != null && inWindow(t.doneAt)) departures += 1;
  }
  const systemWeeks = weeklySeries(cards, lc, win, now);
  const net = arrivals - departures;
  const system = {
    arrivals,
    departures,
    net,
    trend: net > 0 ? 'filling' : net < 0 ? 'draining' : 'balanced',
    byWeek: systemWeeks,
  };

  // --- knowledge accrual ---
  let links = 0;
  let unlinks = 0;
  let captures = 0;
  const knowledgeWeeks = new Map();
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!inWindow(at)) continue;
    const wk = () => (knowledgeWeeks.get(isoWeek(at)) ?? knowledgeWeeks.set(isoWeek(at), { week: isoWeek(at), links: 0, captures: 0 }).get(isoWeek(at)));
    if (e.type === 'CardLinked') { links += 1; wk().links += 1; }
    else if (e.type === 'CardUnlinked') unlinks += 1;
    else if (e.type === 'ItemCaptured') { captures += 1; wk().captures += 1; }
  }
  const knowledge = {
    links,
    unlinks,
    netLinks: links - unlinks,
    captures,
    byWeek: [...knowledgeWeeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
  };

  return {
    meta: {
      generatedAt: now,
      window: win,
      spanDays: days,
      sameInstantMs: SAME_INSTANT_MS,
      commitStage,
      doneStage,
      optionsStage,
      totalCards: cards.size,
      totalEvents: events.length,
    },
    upstream,
    delivery,
    system,
    knowledge,
  };
}

function earliest(events) {
  let min = Infinity;
  for (const e of events) { const t = Date.parse(e.at); if (t < min) min = t; }
  return Number.isFinite(min) ? min : Date.now();
}

// median/p85 age + the oldest-N, over a set of { id, ageMs, label }.
function agingSummary(items, oldestN = 3) {
  const dist = distribution(items.map((i) => i.ageMs));
  const oldest = [...items].sort((a, b) => b.ageMs - a.ageMs).slice(0, oldestN).map((i) => ({ id: i.id, ageMs: i.ageMs, label: i.label }));
  return { count: items.length, medianMs: dist.median, p85Ms: dist.p85, oldest };
}

// Per-ISO-week arrivals vs departures (every card reaching done) within the window.
function weeklySeries(cards, lc, win, now) {
  const weeks = new Map();
  const bump = (wk, key, n) => {
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, arrivals: 0, departures: 0 });
    weeks.get(wk)[key] += n;
  };
  const inWindow = (ms) => ms != null && ms >= win.fromMs && ms <= now;
  for (const c of cards.values()) {
    const t = lc.get(c.id);
    if (inWindow(c.capturedAt)) bump(isoWeek(c.capturedAt), 'arrivals', 1);
    if (t.doneAt != null && inWindow(t.doneAt)) bump(isoWeek(t.doneAt), 'departures', 1);
  }
  return [...weeks.values()].map((w) => ({ ...w, net: w.arrivals - w.departures })).sort((a, b) => a.week.localeCompare(b.week));
}

// --- rendering ---------------------------------------------------------------

// Adaptive duration: minutes under an hour, hours under two days, else days.
function dur(ms) {
  if (ms == null) return '—';
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (ms < 2 * DAY_MS) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / DAY_MS).toFixed(1)}d`;
}
const days1 = (ms) => (ms == null ? '—' : `${(ms / DAY_MS).toFixed(1)}d`);
const num = (n, d = 2) => (n == null ? '—' : Number(n.toFixed(d)).toString());
const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(0)}%`);
const short = (id) => (id ?? '').slice(0, 8);
const clip = (s, n = 56) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);

// Render the model to the read-model markdown (the shareable snapshot). `format` is
// 'md' (the file, default) or 'text' (a leaner stdout variant — same content, no heading
// chrome). The definitional footnotes are stated inline, not buried.
export function renderMetrics(model, { format = 'md' } = {}) {
  const md = format !== 'text';
  const out = [];
  const h = (level, text) => out.push(md ? `${'#'.repeat(level)} ${text}` : text.toUpperCase());
  const p = (s = '') => out.push(s);
  const { meta, upstream: u, delivery: d, system: s, knowledge: k } = model;

  h(1, 'Flow metrics');
  if (md) p('<!-- generated by `kanbento metrics` — do not edit. read-only fold over the event log. -->');
  p();
  p(`Window: **${meta.window.label}** · ${meta.totalCards} cards · ${meta.totalEvents} events · generated ${new Date(meta.generatedAt).toISOString()}`);
  p();

  // System headline first — it frames every other metric.
  h(2, 'System — flow balance (headline)');
  p(`**${s.arrivals} in / ${s.departures} out** — net ${s.net >= 0 ? '+' : ''}${s.net} (${s.trend}).`);
  p(md ? '_Arrivals = captures; departures = deliveries (every card reaching done). The delta is net WIP accumulation; the trend is the story._' : `arrivals=captures, departures=deliveries; delta=net WIP change.`);
  if (s.byWeek.length) {
    p();
    p('| ISO week | in | out | net |');
    p('| --- | ---: | ---: | ---: |');
    for (const w of s.byWeek) p(`| ${w.week} | ${w.arrivals} | ${w.departures} | ${w.net >= 0 ? '+' : ''}${w.net} |`);
  }
  p();

  h(2, 'Upstream — the pool as queue AND funnel');
  p(`- **Arrivals**: ${u.arrivals} captured (${num(u.arrivalRatePerDay)}/day)`);
  p(`- **Depth ÷ pull rate**: ${u.depthNow} options ÷ ${num(u.pullRatePerDay)}/day pulled = **${days1(u.expectedWaitDays == null ? null : u.expectedWaitDays * DAY_MS)}** expected wait (Little's Law)`);
  p(`- **Discard rate**: ${u.discards} discarded/abandoned = ${pct(u.discardRate)} of arrivals${u.merges ? ` (+${u.merges} merged)` : ''}`);
  p(`- **Aging** (${u.aging.count} uncommitted): median ${days1(u.aging.medianMs)}, p85 ${days1(u.aging.p85Ms)}`);
  for (const o of u.aging.oldest) p(`    - oldest: ${short(o.id)} · ${days1(o.ageMs)} · ${clip(o.label)}`);
  p();

  h(2, 'Delivery — commit→done pipeline');
  p(`- **Cycle time** (commit→done): median **${dur(d.cycle.medianMs)}**, p85 **${dur(d.cycle.p85Ms)}** · n=${d.cycle.n}${d.cycle.excludedSameInstant ? ` (${d.cycle.excludedSameInstant} same-instant excluded)` : ''}`);
  p(`- **Lead time** (capture→done): median **${dur(d.lead.medianMs)}**, p85 **${dur(d.lead.p85Ms)}** · n=${d.lead.n}${d.lead.excludedSameInstant ? ` (${d.lead.excludedSameInstant} same-instant excluded)` : ''}`);
  p(`- **Throughput**: ${d.throughputTotal} delivered` + (d.throughputByWeek.length ? ' — ' + d.throughputByWeek.map((w) => `${w.week}→${w.count}`).join(', ') : ''));
  p(`- **Rework**: ${d.rework.traversals} loop traversal(s) across ${d.rework.cardsReworked} card(s)` + (d.rework.ratePerDelivered != null ? ` = ${num(d.rework.ratePerDelivered)}/delivered` : ''));
  p(`- **WIP now**: ${d.wipNow} in flight · aging median ${days1(d.wipAging.medianMs)}, p85 ${days1(d.wipAging.p85Ms)}`);
  for (const o of d.wipAging.oldest) p(`    - oldest: ${short(o.id)} · ${days1(o.ageMs)} · ${clip(o.label)}`);
  p();

  h(2, 'Knowledge accrual');
  p(`- **Links**: +${k.links}${k.unlinks ? ` (−${k.unlinks} retracted, net +${k.netLinks})` : ''}`);
  p(`- **Captures**: +${k.captures}`);
  p();

  h(2, 'Definitions');
  p(`- **Window**: ${meta.window.label}. Rate/flow metrics count events inside it; time distributions include cards *delivered* inside it (measured back to their commit/capture, whenever that was); "now" state (depth, WIP, aging) is current regardless of window.`);
  p(`- **Measured**: every card, typed or not — a card is a unit of work. Boundaries are structural: cycle spans commitment→delivery, lead spans capture→delivery; a card that never crossed the commitment point carries no cycle sample (a disposal, not a delivery); same-instant transitions are excluded.`);
  p(`- **Same-instant**: transitions Δ < ${meta.sameInstantMs}ms (automation bursts, Δ≈0) are excluded from the time distributions or they poison the median.`);
  p(`- **Median AND p85**: p85 is the honest headline (a raw median flatters a board that rushes cards through in the same minute).`);
  p(`- **Commitment point**: \`${meta.commitStage}\`; delivery: \`${meta.doneStage}\`. Cycle time is measured from the commitment point (what makes it honest); lead time from capture.`);
  p(`- **Knowledge accrual gap**: records-created and reaffirmations are filesystem-native (\`note\`/\`reaffirm\` emit no events), so they are NOT counted here — only card-graph links + captures are event-sourced. (Follow-up: event-source the knowledge layer.)`);
  p();

  return out.join('\n').replace(/\n+$/, '\n') + '\n';
}
