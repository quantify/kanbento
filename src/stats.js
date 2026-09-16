// Per-artifact computed signals for `kanbento card <ref> --stats`.
//
// Presentation doctrine (capability:presentation): display-only, computed at the
// edge — nothing is written onto the domain object. Signals form an OPEN REGISTRY:
// add a later signal by registering it here; the CLI folds every entry without
// per-signal wiring. Foundational slice of initiative:counter-append-drift —
// the surface prep / DoR / curate reads instead of counting appendices by hand.

/**
 * @typedef {{ kind: 'card', card: object } | { kind: 'record', record: object }} Piece
 * @typedef {{ accretion?: number }} StatCtx
 * @typedef {{ id: string, label: string, applicable: boolean, value?: number|string|null, note?: string }} SignalReading
 * @typedef {{ id: string, label: string, compute: (piece: Piece, ctx: StatCtx) => SignalReading }} SignalDef
 */

// --- registry ----------------------------------------------------------------

// append-accretion: appends-since-last-consolidation. The count is folded from the
// log's `Elaborated` events (accretion.js foldAccretion) and INJECTED as ctx.accretion
// by the CLI — the same fold the elaborate nudge and lintShape read. No re-derivation
// here, and no frontmatter counter (retired — initiative:counter-append-drift). Cards
// AND records fold: the Elaborated event covers card bound-doc elaborations too, so a
// flow card reports its real accretion (0 when it has none), not an n/a.
function appendAccretion(piece, ctx = {}) {
  const id = 'append-accretion';
  const label = 'appends since last consolidation';
  const n = Number(ctx.accretion) || 0;
  return { id, label, applicable: true, value: n };
}

/** @type {SignalDef[]} */
export const STAT_SIGNALS = [
  { id: 'append-accretion', label: 'appends since last consolidation', compute: appendAccretion },
];

// --- fold + render -----------------------------------------------------------

/** Run every registered signal against a resolved piece. Pure — accretion is injected. */
export function computeStats(piece, ctx = {}) {
  return STAT_SIGNALS.map((s) => s.compute(piece, ctx));
}

/** Human-readable ref line for a piece (handle or CURIE). */
export function pieceRef(piece) {
  if (piece.kind === 'card') {
    const c = piece.card;
    return c.slug ? `${c.slug}@${String(c.id).slice(0, 8)}` : String(c.id).slice(0, 8);
  }
  return piece.record.curie ?? piece.record.path;
}

/**
 * Render stats for stdout. Stable, line-oriented, machine-skimmable:
 *
 *   note:foo · record
 *   append-accretion: 3  (appends since last consolidation)
 *   other-signal: —  (not applicable — …)
 */
export function renderStats(piece, readings = computeStats(piece)) {
  const head = `${pieceRef(piece)} · ${piece.kind}`;
  const lines = [head];
  for (const r of readings) {
    if (r.applicable) {
      lines.push(`${r.id}: ${r.value}  (${r.label})`);
    } else {
      const why = r.note ? ` — ${r.note}` : '';
      lines.push(`${r.id}: —  (n/a${why})`);
    }
  }
  return lines.join('\n');
}
