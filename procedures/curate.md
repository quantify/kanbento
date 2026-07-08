---
title: Curate — keep the knowledge layer honest (surface → inspect → act per precedent → harvest)
type: procedure
status: draft
---
**When to run**: periodically (a session ritual or `claude -p "kanbento do curate"` on a cadence), or whenever `views/CURATION.md` shows ranked churn. Keep the knowledge layer honest: claims checked against the scope, clocks current, decay caught before it misleads.

## The pass

0. **Snapshot** — run `kanbento lint` first and note pre-existing findings; the close-gate below means *no new findings*, not absolute cleanliness.

1. **Surface** — `kanbento map`, then read `views/CURATION.md`. Take the ranked head (up to ~5; a small board may have one). Then pick 1–2 from the *never verified* bucket, largest footprint first, skipping records whose `revised` is recent (freshly revised ≠ unmeasured — low risk): a first-time verification is in scope — inspect the same way and reaffirm to *establish* the baseline clock. Orphans at the bottom are candidates of a different kind (connect or merge, not reaffirm).

2. **Inspect** — for each record, open its map page (mirrored path: `views/maps/<record's source path>`) and read the *since verified* block. For each listed commit, check what it actually touched (`git show --stat <sha>`) and judge **substance vs adjacency**: footprint files change for many reasons; only changes to what the record *claims* count. Then read the record itself and ask, per claim: **did delivered work outrun this?**

3. **Act** — per `case:revise-before-reaffirm-when-claims-outrun`:
   - Claims outrun → **revise first** (edit the file: fix the outrun claims, settle any open questions the work answered), *then* `kanbento reaffirm <curie>`. Reaffirming over outrun claims launders staleness into false freshness.
   - No delivery touched it → **reaffirm only** (`kanbento reaffirm <curie>`).
   - Lifecycle moved (delivered v1, proven in use, superseded) → **flip status** per the type's vocabulary (legal values: `kanbento schema`, or the type's `status.values` in the manifest), then reaffirm.
   - Superseded or duplicated → deprecate, or merge into the survivor.
   - Judge **per claim, not per file** — most of a record usually holds; revise the outrun section only.

4. **Harvest** — friction found while operating is a signal, not noise: `kanbento capture` a card per defect or gap; a contested judgment call becomes a precedent (`kanbento cases retain …`, reuse a category before minting one).

5. **Close** — `kanbento map` to refresh the views; `kanbento lint` must show **no new findings** against the step-0 snapshot. Report what was reaffirmed/revised and anything that needs a human (a status flip, a merge, a contested claim). The pass is done when the ranked head is freshly verified, not when the whole table is empty — the tail buckets drain over many passes.
