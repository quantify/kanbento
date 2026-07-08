---
title: Pulse — the heartbeat pass over the board (Deliver → Prep → Acquire, then Improve)
type: procedure
status: draft
---
**When to run**: on a cadence — a session ritual or `claude -p "kanbento do pulse"` on a clock. The pulse is the operating guide's step 1 ("orient — read the board, decide what to act on") **run on a timer**: *proactive = reactive to a clock*. One tick drops you at the board with rich declared state; you orient and drive its rhythm.

**Advisory-first — the report is the gate.** The pulse REPORTS and PROPOSES; it does the safe, obvious moves and leaves the rest for a human to dispose — *unless the board's own gates (DoR/DoD, WIP) already authorize the move*. Prose is the gate until a specific need earns schema. Prefer under-acting and flagging over acting on your own initiative.

## The pass

0. **Orient** — read `views/BOARD.md` for live state: what's in flight, what's blocked, where WIP sits against its limits, what's aging. Check `kanbento procedures` for due routines (a routine past its cadence is board work like any other — run it or propose it). The pulse ranges over the *whole board*, not one card — hold the value stream in view.

0.5 **Recall precedent** — read the case taxonomy (`kanbento cases`), classify the decisions this pulse will touch, and open the matching categories' files. Let precedent inform your proposals and *cite the category* ("per `discard-when-superseded-by-delivery-or-decision`"). No matching category? Propose fresh — that is how the taxonomy grows.

Walk the three poles in **throughput-protective order** (out → condition → in, Theory-of-Constraints subordination — clear the exit before feeding the intake):

1. **Deliver** (out) — realize value at the exit gate first. Finish, unblock, or review work already in flight before pulling anything new: push review/QA items through their loop, clear blockers, move done-enough work to the delivery point against its DoD. Finish-first *is* prioritizing the exit pole.

2. **Prep** (condition) — make committed and near-committed work fit to move. Replenish `ready` toward its WIP so the next pull has something to take; groom the commitment point (sharpen titles, settle DoR gaps, order by value). Don't over-fill — the pool is a buffer, the commitment point is the filter.

3. **Acquire** (in) — triage the inbox / pool. Options are cheap and reversible (they land left of commitment, discardable), so acquire liberally; the *gate*, not the act of capturing, decides what gets worked. De-dupe, merge, and value-rank; a fresh discovery can outrank the standing backlog.

4. **Improve** (the reflexive coda — slow, usually silent) — this beat sits *above* the flow and is reactive to *lessons*, not the clock, so it runs last and often stays quiet. Friction met while operating → `kanbento capture` a card. Structural evidence (a stage consistently starved or overfull, a gate that keeps misfiring) → note it for `EVOLVING`/a kaizen note; changing structure is a *meta* move, never a silent edit.

5. **Close** — refresh the views (`kanbento board`, and `kanbento map` if records changed), then end with the pulse report — the report *is* the gate:

   ```
   ## Pulse — <what you oriented from>
   - Deliver: <unblocked/advanced, or "flight clear">
   - Prep:    <grooming done; ready candidates surfaced>
   - Acquire: <triage/exploration done, or "budget held">
   - Improve: <friction captured / structure proposed, or "silent">
   - Routines: <due routines run or proposed, or "none due">
   - Proposed (needs your call): <everything you did NOT do on your own>
   ```

6. **Learn** — when the human disposes the report, retain **one precedent per decision** (`kanbento cases retain <category> --why … --situation …`). The category is a named rule, `verb-when-condition`, so an override is just a different rule firing — no approve/reject verdict. **Reuse before you mint** (re-read the taxonomy first; uncontrolled minting fragments it). Note the hit: when a cited category matched the human's call, say "precedent held"; when overridden, name the category that actually fired — that match/miss signal is the read on whether precedent could decide unsupervised. Quality over volume; this step is what earns autonomy — don't skip it.
