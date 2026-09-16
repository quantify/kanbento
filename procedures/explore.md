---
title: "Explore — diagnose one option's uncertainty and formulate its reduction instrument: name the binding dimension, answer what analysis can, design the probe/watch for what it cannot"
type: procedure
status: draft
params:
  card:
    required: true
---
**When to run**: dispatched (typically by a replenishment pass) on an option that is NOT selectable yet — it stays in the pool because material uncertainty remains. Exploration's job is to make the option more decidable than it found it: reduce what cheap analysis can reduce now, and formulate the instrument for what it cannot. Nothing here commits or transitions; the output is evidence and formulated instruments.

Work the one card: **${params.card}**.

## The pass

1. **Read it whole — then recall prior art.** `kanbento card ${params.card}`, its bound doc, backlinks and neighborhood (`kanbento refs`, `kanbento refs --around` for the territory), and any prior evidence on it (elaborations, linked records). Then search the knowledge layer for what the board already knows about this ground: records (positions, notes) in the territory, precedents (`kanbento cases`), and prior cards — including done and archived ones, whose outcomes ARE evidence. Much apparent uncertainty is already-resolved knowledge nobody recalled; recall is the cheapest reduction instrument there is, and it runs before any new analysis. Note the card's evidence state: how long pooled, what has accreted since capture.

2. **Build the uncertainty vector** — what exactly is unknown, by dimension:
   - **value** — how much benefit, for whom, if it works
   - **cost** — real effort to deliver
   - **feasibility** — can it work at all (technical/external risk, open questions)
   - **timing/window** — when the value exists; what external event it depends on
   - **dependencies** — coupling to other cards, decisions, or systems
   Name the **binding dimension** — the one that, resolved, would make the option decidable. Most options have one; naming it is the diagnosis. Two cautions: the card's own framing of what's uncertain is a CLAIM, not the diagnosis — the captured framing can itself be the reducible surface (check it against step 3's reading before accepting it); and not every option is work-to-deliver — for an observation/watch candidate the vector's decisive entry is **subject-fit** (does a standable, low-noise subject exist at the resolver's fetch granularity, carrying content the question can actually match on?), and for a design question it is usually feasibility-of-mechanism, readable from the code.

3. **Reduce what analysis can reduce now** — if the binding uncertainty yields to reading (the codebase, the log, a record, a quick calculation), DO the analysis here — a preliminary pass, minutes not hours. Many options are undecidable only because nobody looked.

4. **Formulate the instrument for what analysis cannot reduce**:
   - Evidence-reducible → design the **cheapest probe/spike**: the question it answers, the smallest experiment that answers it, the success/kill signal. Write it so it can be committed as a unit of work by whoever dispatches you.
   - External-event-bound → formulate the **watch**: the subject (`namespace:id`) and the question, ready to stand (`kanbento watch`) — the timing dimension delegated to a tripwire.
   - Irreducible (the world must move first, no observable to watch) → say so plainly; the honest treatment is parking or expiry, and pretending a probe exists wastes a cycle.

5. **Accrete** — write what you learned onto the card (`kanbento elaborate ${params.card}`): the vector, the binding dimension, analysis results, the formulated instrument. This is the point — the option's evidence density rises whether or not anything is stood today, and the next pass over this card starts from your findings instead of zero.

6. **Report** — one line of verdict first: **now-selectable** (analysis resolved the binding uncertainty — hand back as a selection candidate), **instrument-formulated** (what to stand or commit, and what it will tell the next replenishment), **decompose** (the uncertainty is really several — name the split), or **expire-candidate** (probably noise: middling value, well understood, or window closed — recommend discard with the reason, which is itself knowledge worth retaining). Then the vector and evidence behind it.
