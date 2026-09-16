---
title: "Design — settle one option's solution shape: diverge over candidate solutions anchored in recall, converge by delegated adversarial critique against a declared fitness axis; output = the narrowed bet + seeded acceptance criteria (a commit-ready spec)"
type: procedure
status: draft
params:
  card:
    required: true
---
**When to run**: dispatched (typically by a replenishment pass) on an option whose problem statement is settled but whose solution shape is not — several ways to build it exist and the choice is the remaining uncertainty. Downstream of explore (which diagnoses WHAT is unknown); upstream of commitment. Nothing here commits or transitions; the output is a specification on the card.

Work the one card: **${params.card}**.

## The pass

1. **Verify the ground.** Read the card whole — `kanbento card ${params.card}`, its bound doc, backlinks (`kanbento refs`), prior evidence. The problem statement is the card's job to carry — if the binding uncertainty turns out to be problem-side (what/why unclear, not how), STOP and return **wrong-dispatch: needs explore**. Do not silently re-scope. The mirror failure: a card that arrives already naming one mechanism — treat that as a *candidate*, never the answer; the divergence must genuinely contest it.

2. **Diverge — but anchored.** Generate genuinely distinct candidate solutions (different mechanisms, not parameter variations). Before judging any, sweep what already exists — reach for **`kanbento search <terms>`** first (one ranked query over the whole store — every record AND card, archived included — the fastest way to find an already-half-built candidate), alongside the codebase, delivered cards, records, precedents (`kanbento cases`). The strongest move in this stage is discovering a candidate is already half-built — an existing seam, counter, or view that collapses its cost. State each candidate as: mechanism · cost · what it deliberately does not do.

3. **Declare the fitness axis.** One ruler every candidate is measured by (default: max outcome per unit of code; the card may earn a different axis — say which and why). When the candidate set includes a defer/do-nothing option, the axis must encode the build-trigger too — a go/no-go gate is not a cost ruler, and measuring "don't build" by cost-per-outcome is a category error. Without a shared axis, convergence is taste.

4. **Converge — delegated, adversarial.** Hand the candidate set — in the step-2 form, mechanism · cost · non-goals — plus the axis to a fresh-context critic (a sub-agent that did NOT author the candidates — the separation is the value): its job is to refute each candidate, not rank them politely — find the redundancy, the fragile mechanism, the already-solved half, the consumer or constraint the author missed. Its return: the surviving bet, and each drop with its reason. The reasons are knowledge — they fence the future dev as hard as the bet does.

5. **Fold or bounce.** Your judgment on the critique's output, not a separate dispatch: if it reveals the problem itself was mis-framed, revise the card's statement and return **problem-restated** — the dispatcher decides on a re-run; one bounce is signal, a second means this was explore's work all along.

6. **Materialize the spec.** Elaborate the narrowed bet onto the card (`kanbento elaborate ${params.card} -F <file>`) — the chosen shape, the drops with their reasons in the same candidate form, the evidence found in step 2 — and seed `Acceptance Criteria` from it (`kanbento checklist ${params.card} "Acceptance Criteria" -F <file>`). If the card is unlinked, declare the refs the spec earned (`kanbento link ${params.card} <rel> <target>` — the position it advances, the doctrine it applies). The spec IS commit-readiness: refs + AC are what the commitment gate asks for, and this step must leave both standing.

7. **Report** — verdict first: **spec-settled** (bet chosen, AC seeded) · **problem-restated** (statement revised, re-run is the dispatcher's call) · **wrong-dispatch: needs explore**. Then the bet in one line and the drop list.
