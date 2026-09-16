// Accretion fold — appends-since-last-consolidation, derived from the event log.
//
// The board's most common knowledge act (`kanbento elaborate`) witnesses each body
// write with an `Elaborated` event (kind: record|card, mode: append|replace). This
// is the ONE implementation that folds those events into a per-target accretion
// count; every consumer (the elaborate nudge, lintShape, card --stats, CURATION)
// reads it — no consumer re-derives the signal ad hoc. Supersedes the retired
// `appends` frontmatter counter (initiative:counter-append-drift).
//
// Semantics: iterate events in order; on each `Elaborated`, replace-mode resets the
// count to 0 (a clean, consolidated slate), append-mode increments. The final count
// per ref is appends since that ref's last replace. A `retitle`-mode event (a
// title-only record revision) is neither a reset nor an append — it is ignored, so a
// pure retitle never inflates the accretion nudge. Non-Elaborated events are ignored.
// `foldAccretion([])` → empty Map (fresh / events-absent boards never crash a consumer).

/**
 * Fold the event log into a Map of target ref → accretion count.
 * @param {Array<object>} events
 * @returns {Map<string, number>}
 */
export function foldAccretion(events = []) {
  const acc = new Map();
  for (const e of events) {
    if (!e || e.type !== 'Elaborated') continue;
    const ref = e.ref;
    if (ref == null) continue;
    if (e.mode === 'replace') acc.set(ref, 0);
    else if (e.mode === 'retitle') continue; // a title-only revision — not a body append; never accretes
    else acc.set(ref, (acc.get(ref) ?? 0) + 1);
  }
  return acc;
}

/**
 * Convenience: the accretion count for a single ref (0 when unseen).
 * @param {Array<object>} events
 * @param {string} ref
 * @returns {number}
 */
export function accretionFor(events, ref) {
  return foldAccretion(events).get(ref) ?? 0;
}
