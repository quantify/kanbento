---
title: Status update — report outward from local evidence (daily kanban)
type: procedure
status: draft
cadence: 1d
runner:
  tools:
    - Bash(kanbento *)
    - Bash(node *)
    - Read
    - Write
---
**When to run**: on the daily-kanban rhythm — end of a working session or day. This is pulse's outbound counterpart: pulse orients *inward* (walk the board, decide), status-update reports *outward* (tell the principal what actually happened). The same pass serves an autonomous fleet syncing with its principal or a board reporting into a network — the collab need doesn't change when the human steps back.

**The discipline — evidence only.** Status drafts fabricate when composition sees work-item *descriptions* instead of *evidence* (a field-learned failure: the drafter parrots the ticket back as progress). So the pass keeps three beats strictly apart: extract mechanically, match structurally, compose from matched evidence only. Never let a later beat reach back past an earlier one.

## The pass

1. **Window** — fix the reporting window first. The scripts default to **yesterday** (the last full day) — pass `--since`/`--until` only when the principal asked for a different window, or when this procedure's last run (`kanbento procedures` shows last-ran) leaves a gap to cover. State the window in the update — a report without its window is unverifiable.

2. **Extract** (mechanical — one script, run verbatim, don't improvise):

   `scripts/evidence.mjs [--since <when>] [--until <when>]`

   It resolves scope itself — standalone repo or the whole home network is the same uniform output, an *array of members of one or many*: run at home, the members are the live registry boards; run in a repo, the member is that repo. Per member it gathers commits by the current principal (git) and board events (principal-stamped, grouped by card). The script exists so two runs over the same window yield the same evidence set — extraction has dials, and improvised commands drift. Do not filter, classify, or interpret at this beat — the raw output *is* the evidence. Name any member the header counts that you don't see sections for.

3. **Match** (structured, no prose) — join evidence to work items. Board events are pre-joined (each names its card). Commits join via card/issue keys in messages, or via the worktree stamps on board events sharing their branch. Produce an explicit list: item ↔ evidence refs (commit hashes, event ids). Evidence matching nothing goes under **unattributed** — never force a match, never invent one.

4. **Compose** — one status line per matched item. **Say the work, not the board mechanics**: "committed and pulled into progress" is log narration, not a status — the reader wants what the work *is* and where it stands. The division of labor: the **evidence determines the claim** (started / progressed / delivered / blocked — an item with no evidence in the window gets **"no recorded activity"**, never a paraphrase of its description as progress), while the **item's own content supplies the vocabulary** — read the card's title and body to name the work in its own terms, then make only the claim the evidence supports. Plain sentences in the principal's voice. Close with the unattributed remainder (it is often the most honest line in the report).

5. **The consent gate** — present the draft to the principal to review, edit, and send. The approved update is the record; the evidence stays local. This procedure never transmits anything itself — delivery is out of scope by design. A destination-specific variant (a board-local `procedure:status-update` override, or a plugin) adds the delivery step; the discipline above is what it inherits.

## At home

Run from the home board, the pass is identical — the evidence just arrives with many members. Two things change, neither mechanical:

- **Match and compose once**, over the union of evidence, grouped by member — one update, one consent gate. Composing per member and stitching prose is the drafts-are-evidence failure in disguise; don't.
- **Store the approved update at home** — `kanbento --board @home note --type status-update --slug <yyyy-mm-dd> -F <file>` (date-slugged; the latest stored update is the next run's watermark). Mark it `sent` once delivered.
