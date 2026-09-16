---
title: "Prep — make one option commit-ready: connect it, sharpen it, define its done; report readiness against the board's Ready gate"
type: procedure
status: draft
params:
  card:
    required: true
---
**When to run**: dispatched (typically by a replenishment pass) on a selection candidate — an option judged certain enough to commit, not yet fit to. Prep is grooming, not delivery: everything here happens LEFT of the commitment point, and nothing here commits, transitions, or archives.

Work the one card: **${params.card}**.

## The pass

1. **Read it whole — card AND territory.** `kanbento card ${params.card}`, its bound doc if any, and its neighborhood (`kanbento refs --from ${params.card}`, backlinks via `kanbento refs`). Then the knowledge layer around its ground: the position record it would advance, related notes, and PRIOR delivered cards in the same territory (their scope, their acceptance-criteria style, their outcomes) — the card should inherit what the board already learned, not reinvent it, and what it builds on is exactly what step 2 links. Read the board's Ready gate (the commit stage's entry criteria in the operating guide) — that gate is your definition of "prepared." And before preparing anything, check the premise: **does HEAD already resolve this?** A card can be captured hours before its own fix ships and never closed — check the recent delivery log (`git log`, done cards) against the card's claim. If the premise is already false, the verdict is **ALREADY-DELIVERED** (name the resolving commit and any real residual, elaborate the finding onto the card) — recommend archiving the option as superseded-by-delivery, don't prep a no-op. (Archive at the card's own stage: the option is discarded because reality already contains its outcome — the work flowed elsewhere, and marking it delivered would double-count throughput.)

2. **Connect** — seed the card's real edges: the position it advances, the records it touches, siblings and blockers (`kanbento link`). Real edges only — a link exists because the relation does, not to satisfy a quota; one meaningful edge beats three ceremonial ones. If no edge exists to seed, say so in the report — that itself is a finding (an option feeding no position is a discard candidate, not a commit candidate).

3. **Sharpen** — does the title still state the intent as now understood? If understanding has outrun the framing, retitle (`kanbento elaborate ${params.card} --title "…"`). If the body is missing context a fresh deliverer would need (the why, constraints, prior decisions), append it (`kanbento elaborate`) — the card should brief its own delivery.

4. **Define done** — draft the acceptance criteria: the explicit, checkable definition of done a deliverer works to and a reviewer judges against. Seed them with a whole-text list (`kanbento checklist ${params.card} "Acceptance Criteria" -F <file>` or `-F -` on stdin) — **plain one-per-line** (each non-empty line becomes an open item) or markdown checkboxes (`- [ ] text` / `- [x] text`). Few and sharp; each criterion verifiable, none decorative.

5. **Right-size** — if prep reveals the card is really several deliverables, decompose: capture the slices (`kanbento capture --from ${params.card}` for lineage) and report the split; the original may become an umbrella or a discard. An option too big to define done for is not commit-ready at any level of certainty.

6. **Report** — the readiness verdict: READY (names its refs, carries its criteria, sized to deliver — and each Ready-gate criterion met) or NOT-READY (what is missing and whether it is preparable or a certainty gap that needs exploration instead). You prepared the card; committing it is the dispatcher's decision, not yours.
