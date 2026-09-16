// Named checklists — a card primitive: each card carries named registers of items.
// The carrier is intentionally simple: each item is a **boolean status** (open ↔ done)
// plus an optional **discard** disposition (`retracted`). Semantics of a *list* (what
// the booleans mean) are data — the name drives the role. Two well-known lists gate
// the delivery loop — "Acceptance Criteria" (definition of done) and "Rework"
// (transient defects) — but the primitive privileges none: a name is convention, not
// schema. This module is PURE — grammar parse + read-model rendering; state lives on
// the event-sourced card (kernel fold), mutated through the `checklist` verb.
//
// Status model (keep it this small):
//   - **boolean** — `done: false|true` via --check / --uncheck (and whole-text may
//     promote open→done; it never wipes a tick). The gate (`--incomplete`) reads only
//     active open items.
//   - **discard** — `--retract` is the discard form of that carrier: the criterion left
//     the contract (became *wrong*, not merely unmet). Append-only soft-discard: the row
//     stays for history and stable indices, rendered `[~]`, and is excluded from open /
//     total / `--incomplete`. Not a third boolean value, not a hard delete, not "uncheck".
// Whole-text write restates active items (+ newcomers); discarded rows may be omitted.

// The two well-known gating lists (v1 scope). Referenced by name, by convention — the
// DoR names "Acceptance Criteria"; the merge gate reads both. Arbitrary lists never gate.
export const AC_LIST = 'Acceptance Criteria';
export const REWORK_LIST = 'Rework';
export const GATING_LISTS = [AC_LIST, REWORK_LIST];

const CHECK_ITEM = /^\s*[-*+]\s*\[([ xX])\]\s+(.*\S)\s*$/;

// Parse whole-text into ordered { text, done }.
// - Checkbox lines (`- [ ]` / `- [x]`, also `*`/`+` bullets) always win: when any are
//   present, only they become items — blanks/headings/prose are commentary (ignored).
// - When no checkbox line is present, each non-empty line is an open item. Prep agents
//   and humans write plain one-per-line files; requiring the checkbox grammar was
//   recurring friction (story:checklist-file-grammar-undocumented).
// Case-insensitive on the mark. Whole-text write does not parse a retract mark —
// retract is a separate `--retract <n>` op.
export function parseChecklistItems(text) {
  const checkbox = [];
  const plain = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(CHECK_ITEM);
    if (m) checkbox.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
    else {
      const t = line.trim();
      if (t) plain.push({ text: t, done: false });
    }
  }
  return checkbox.length ? checkbox : plain;
}

// Active (non-discarded) done/total/open. Discarded/retracted items are history: they
// keep a stable index for --check/--retract but do not inflate the badge or open gate.
export function listStats(items) {
  const arr = (Array.isArray(items) ? items : []).filter((it) => !it.retracted);
  const done = arr.filter((it) => it.done).length;
  return { done, total: arr.length, open: arr.length - done };
}

// The compact BOARD/POOL badge for a gating list: `☑done/total` for Acceptance Criteria,
// `⟳open` for open Rework. '' when the list is absent/empty (or, for rework, all clear).
// Only the gating lists badge — arbitrary lists never clutter the card line.
export function acBadge(checklists) {
  const { total, done } = listStats(checklists?.[AC_LIST]);
  return total ? `☑${done}/${total}` : '';
}
export function reworkBadge(checklists) {
  const { open } = listStats(checklists?.[REWORK_LIST]);
  return open ? `⟳${open}` : '';
}

// Gate query for `checklist --incomplete` (exit code IS the answer).
// The mechanism is name-agnostic — a checklist is a checklist; names drive
// semantics in recipes/agreements, not here (no baked-in "AC required").
// - Named list: that list must exist and every *active* (non-discarded) item checked.
//   Missing/empty → not complete. Unchecked active items listed in `open`. Discarded
//   (retracted) items never open.
// - Unnamed: every list present on the card; any unchecked active item fails. No
//   lists at all → complete (nothing open). Recipes that require a named list
//   (e.g. merge needs "Acceptance Criteria") MUST query that name explicitly.
// Returns { ok, open, missing } for the CLI to print and set exitCode.
export function incompleteReport(checklists, only = null) {
  const open = [];
  const missing = [];
  if (only) {
    const items = checklists?.[only];
    if (!items || !items.length) {
      missing.push(only);
    } else {
      for (const it of items) {
        if (it.retracted) continue;
        if (!it.done) open.push(`${only}: ${it.text}`);
      }
    }
    return { ok: open.length === 0 && missing.length === 0, open, missing };
  }
  for (const [name, items] of Object.entries(checklists ?? {})) {
    if (!Array.isArray(items) || !items.length) continue;
    for (const it of items) {
      if (it.retracted) continue;
      if (!it.done) open.push(`${name}: ${it.text}`);
    }
  }
  return { ok: open.length === 0, open, missing };
}

// Render all of a card's lists (or one named list) as the human read view — the
// `## <list>` heading + numbered items. Boolean carrier: `[x]` / `[ ]`; discarded:
// `[~]` (visible history). Counts in the heading are active-only.
// '' when there is nothing to show.
export function renderChecklists(checklists, only = null) {
  const names = only ? [only] : Object.keys(checklists ?? {});
  const out = [];
  for (const name of names) {
    const items = checklists?.[name];
    if (!items || !items.length) {
      if (only) out.push(`## ${name}`, '_(empty)_', '');
      continue;
    }
    const { done, total } = listStats(items);
    out.push(`## ${name}  (${done}/${total})`);
    items.forEach((it, i) => {
      const mark = it.retracted ? '~' : (it.done ? 'x' : ' ');
      out.push(`${i + 1}. [${mark}] ${it.text}`);
    });
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
}
