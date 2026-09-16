---
title: "Settle — the post-delivery bookkeeper: book outcomes to the ledger — positions moved, tranches closed, decisions outcome-stamped, beliefs revised, fitness gaps re-captured, the done column offloaded"
type: procedure
status: draft
---
**When to run**: on a cadence, or whenever deliveries have accumulated at the delivery point since the last settlement. Everything here happens AFTER the measured flow — the delivery point is the finish line of the kanban system; what follows is outcome observation and learning, never part of the flow itself. Settle touches no in-flight work.

**The concept.** Delivery ends the flow; settlement converts its OUTPUTS into KNOWLEDGE. Delivered ≠ fit: `done` means the output shipped — settle asks what the output *did*. Did it move the position it was for? Did the decision made under uncertainty turn out right? Did delivered work outrun a record's claims? Every delivery paid effort to resolve uncertainty; settlement books the result to the knowledge layer so the purchase is never re-made. Unsettled deliveries are the mirror image of a stale pool: resolved uncertainty nobody banked — and what settle books is exactly what the next replenishment recalls.

**Act on the clear, propose the contested.** Settlement writes are knowledge writes — elaborations, status flips, reaffirmations, archives of already-delivered cards — all reversible and left of nothing. Do the obvious bookings directly; where a booking is a judgment call a human might contest (a status flip that claims a lifecycle advance, a precedent whose outcome is debatable), propose it in the report instead.

## The pass

1. **Orient — collect the unsettled.** Read the board's delivered set (the `done` stage in `views/BOARD.md`, plus any DONE/ARCHIVE views) and note which deliveries have no settlement trace yet (no outcome booked onto what they advanced — check the refs). Read the open tranches if the board declares a `plan`/`iteration` type (records at their committed status). Read the portfolio view if the board projects one — it is the ledger you are booking into.

2. **Per delivered card — book the outcome:**
   - **Position**: follow the card's refs to what it advanced. Append the outcome onto the position record (`kanbento elaborate <curie>` — one or two lines: what this delivery moved, dated). If the delivery moved the position's LIFECYCLE — an idea now has landed code, a hypothesis now has evidence — flip the record's status per its type's vocabulary and `kanbento reaffirm` it. Statuses are earned, not decorative: flip on delivered reality only.
   - **Beliefs**: if the delivery outran any record's claims (the delivery touched a record's territory), revise the record first, then reaffirm — never reaffirm over outrun claims.
   - **Decisions**: a call made under uncertainty during this delivery whose outcome is now visible is a precedent worth its outcome — `kanbento cases retain <category>` (reuse a category before minting one), stating situation → decision → how it turned out.
   - **No refs to book into?** Say so in the report — a delivery that advanced nothing nameable is itself a finding (either the edge was never seeded, or the work was pure overhead).

3. **Per open tranche** (where the board has plan records): are all its authorized members done or otherwise disposed? All settled → flip the plan's status to settled and note the outcome on the record: what the tranche bought against its goal, in one or two lines. Some members still in flight → leave it committed; note progress if useful. A tranche whose members all died without delivering settles too — as an outcome, honestly stated.

4. **Fitness gaps — re-capture, don't rework.** Where an output shipped but the outcome it was for did NOT arrive (delivered ≠ fit — the position didn't move, the metric didn't budge, the user need persists), the flow is over: this is not rework, it is a NEW option. `kanbento capture --from <ref>` with the gap stated — it enters the funnel left of the commitment point like every other option, carrying lineage to what taught it.

5. **Offload.** A grown done column obscures the board: archive older delivered cards at their delivery stage (`kanbento archive <ref> <done-stage>` — the delivered disposition), keeping the recent tail visible. Judgment, not a quota.

6. **Harvest + report.** Friction met while settling → `kanbento capture`; a contested settlement call → propose it (or retain it, if made). Report: outcomes booked (position by position), statuses flipped, tranches settled, precedents retained, fitness gaps captured, cards offloaded — and the proposals awaiting a human. The pass is done when the recent delivered set is booked, not when all history is.
