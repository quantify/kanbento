import { randomUUID } from 'node:crypto';
import { dirname, resolve as pathResolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { slugify, titleSlug, explicitSlug } from './slug.js';
import {
  loadManifest,
  inboxLanding,
  allowedSources,
  admittedSourcesNote,
  stageById,
  nextStageId,
  flowEdge,
  flowsFrom,
  commitStageId,
  wipEnforcement,
  cardTypes,
  typeDef,
  lanes,
  laneValue,
  stages,
} from './manifest.js';
import { dispositionForRole } from './protocol.js';
import { checkRelationStrict, refEdges, parseCurie, resolveRelKey, expandedRelations } from './refs.js';
import { attemptFor, foldEnactments, moveDef as protocolMoveDef, isOpener as protocolMoveIsOpener } from './collaborate.js';
import { matchingHooks, runEvaluator, execCommand, stageContract, gateChecklistItems, isForward as isForwardMove } from './hooks.js';
import { compile, diffCompiled, isEmptyChangeset, reconcileMoves } from './compile.js';

// Board context derivation lives in boards.js (with resolution + the registry it reads);
// re-exported here so it sits on the kernel's public surface — a transport asks the kernel.
export { boardEnv } from './boards.js';

const DEFAULT_INVOKER = 'claude -p "$KANBENTO_PROMPT"'; // the run engine's doer; pluggable via manifest.runInvoker
const WORKTREE_CAP = 100; // max stamped paths per event; the rest fold into an overflow count

// The dirty set of a card's most recent worktree stamp — the baseline a new stamp
// dedupes against (an unchanged tree is not restamped). Scans the already-read log.
function lastStampedDirty(events, cardId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.cardId === cardId && e.worktree) return e.worktree.dirty ?? [];
  }
  return null;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

// The dirty set of the most recent ProcedureInvoked for a curie — a routine's stamp
// is keyed by its curie (it has no cardId), so this is its dedupe baseline instead of
// lastStampedDirty (a re-invocation over an unchanged tree adds nothing).
function lastProcedureInvokedDirty(events, curie) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'ProcedureInvoked' && e.curie === curie && e.worktree) return e.worktree.dirty ?? [];
  }
  return null;
}

// Every event type the log may legitimately carry. The card fold (rebuild) only
// projects a subset; the rest (hook stamps, run bookkeeping, roster, structure) are
// folded elsewhere or audit-only. Anything OUTSIDE this set is a foreign event —
// a newer kanbento, or a corrupt line — and must not vanish silently on replay.
const KNOWN_EVENTS = new Set([
  'ItemCaptured', 'CardTransitioned', 'CardBound', 'CardLinked', 'CardUnlinked', 'CardSlugged', 'CardRetitled', 'CardArchived', 'CardsMerged',
  'CardScoped',
  'ChecklistItemAdded', 'ChecklistItemChecked', 'ChecklistItemUnchecked', 'ChecklistItemRetracted',
  'StructureMutated', 'HookEvaluated', 'RunStarted', 'RunEnded', 'MemberJoined', 'MemberLeft', 'ProcedureInvoked', 'WatchSet', 'WatchCleared',
  'MoveActed', 'RecordGraduated', 'Elaborated',
]);
const warnedUnknown = new Set(); // once per type per process — rebuild runs on every verb
function warnUnknownEvent(type) {
  if (warnedUnknown.has(type)) return;
  warnedUnknown.add(type);
  console.error(`⚠ unknown event type "${type}" in the log — skipped on replay (written by a newer kanbento, or corrupt?)`);
}

// Re-label an error thrown by an inner verb so a sugar/delegating verb names itself
// in the message (commit → transition; archive → transition). Prefix match only —
// messages without the inner verb's prefix pass through unchanged (e.g. `blocked:`).
function rethrowAsVerb(err, fromVerb, toVerb) {
  const prefix = `${fromVerb}:`;
  if (err instanceof Error && err.message.startsWith(prefix)) {
    throw new Error(`${toVerb}:${err.message.slice(prefix.length)}`);
  }
  throw err;
}

// The kernel: interprets a board manifest and executes verbs against a log.
// State is always a projection (a fold) of the log; the log is the board's
// commit history. The log transport is pluggable (eventlog.js).
//
// Verbs:
//   capture     genesis — add an item to the inbox (an ItemCaptured event)
//   transition  move a card across a boundary, firing the target entry gate + WIP
//   commit      sugar: transition into the `commit` stage (the commitment point)
//
// Around the verbs runs the reactive subsystem (hooks.js). For each event the
// kernel does CONTEXT ENGINEERING — it assembles the event, the card, its
// history, the relevant policy prose, and board state into a prompt — and hands
// it to a hook's evaluator. The evaluator is an LLM by default (`claude -p`) or
// any command. `before` evaluators return a verdict that can veto; `after` ones
// react. The fold replays history without re-firing evaluators.

export async function openBoard({ manifest: manifestArg, manifestPath, log, boardDir, observe, identify }) {
  const manifest = manifestArg ?? (await loadManifest(manifestPath));

  // --- principal stamp -------------------------------------------------------

  // Identity rung 1 (note:identity): stamp WHO is behind every event. `by` stays
  // the actor role (agent / hook / human); `principal` is the human on whose
  // behalf — observed once per process from the identify seam (git config), then
  // stamped on every append, hook verdicts included. No identity → no field
  // (byte-identical to before). Fail-soft: attribution is context, never worth
  // failing a verb for.
  if (identify) {
    const base = log;
    let observedPrincipal; // undefined = not yet observed; null = observed nothing
    const principal = async () => {
      if (observedPrincipal === undefined) {
        try {
          observedPrincipal = (await identify()) ?? null;
        } catch {
          observedPrincipal = null;
        }
      }
      return observedPrincipal ? { principal: observedPrincipal } : {};
    };
    log = {
      read: () => base.read(),
      append: async (event) => base.append({ ...event, ...(await principal()) }),
      describe: () => base.describe?.(),
    };
  }
  // The slugify feature flag (features.slugify): heuristic slugs are OFF by default — a
  // card stays slugless (id-led handle, id-named docs) until an explicit --slug or
  // the semantic CardSlugged lands. `slugify: true` restores derived-at-capture.
  const deriveSlug = manifest.features?.slugify === true;
  const bus = new EventEmitter();
  boardDir ??= manifestPath ? dirname(manifestPath) : process.cwd();

  // --- worktree stamp --------------------------------------------------------

  // Observe the working tree at verb time and fold it into a `worktree` field on
  // the card event — the model↔world join captured while kanbento is resident,
  // not reconstructed from commit archaeology. No observer -> {} (byte-identical
  // to before). Called once per verb; deduped against the card's last stamp and
  // capped, so an unchanged tree adds nothing.
  async function worktreeStamp(events, cardId, { isCapture = false, prevDirty } = {}) {
    if (!observe) return {};
    let obs;
    try {
      obs = await observe();
    } catch {
      return {}; // fail-soft — a stamp is context, never worth failing a verb for
    }
    if (!obs) return {};
    const branch = obs.branch ?? null;
    let dirty = [...new Set(Array.isArray(obs.dirty) ? obs.dirty : [])].sort();
    // A later event only stamps a real change; capture stamps even an empty tree
    // (the card's origin branch is worth recording once).
    if (!isCapture && dirty.length === 0) return {};
    let overflow = 0;
    if (dirty.length > WORKTREE_CAP) {
      overflow = dirty.length - WORKTREE_CAP;
      dirty = dirty.slice(0, WORKTREE_CAP);
    }
    if (!isCapture) {
      // A caller with a curie-keyed baseline (a routine run) passes prevDirty; a card
      // event falls back to its own last stamp.
      const prev = prevDirty !== undefined ? prevDirty : lastStampedDirty(events, cardId);
      if (prev && sameSet(prev, dirty)) return {}; // unchanged since the last stamp — no bloat
    }
    return { worktree: { branch, dirty, ...(overflow ? { overflow } : {}) } };
  }

  // --- reactive subsystem ----------------------------------------------------

  async function dispatch(event, phase) {
    // Only DECLARED manifest hooks fire here. Gate evaluation is no longer an independent
    // evaluator on transition — a forward move injects the DoR/DoD gate checklist (seedStageGate)
    // and the coordinator-dispatched specialist self-evaluates it. No separate gate-eval session
    // (the double-gating is gone).
    const hooks = matchingHooks(manifest, event, phase);
    if (!hooks.length) return [];
    const events = await log.read();
    const cards = rebuild(events);
    for (const hook of hooks) {
      const context = await buildContext(manifest, event, hook, cards, events, boardDir);
      const prompt = renderPrompt(context);
      const res = await runEvaluator(hook, { event, prompt, context, boardDir });
      const hookId = hook.id ?? hook.on;
      // Persist the verdict as an audit event — what verified this card, and why.
      // Appended even when a `before` hook vetoes, so rejected attempts are on record.
      const stamp = { type: 'HookEvaluated', eventId: randomUUID(), at: now(), hook: hookId, phase, on: event.type, cardId: event.cardId ?? null, by: 'hook', cause: { event: event.eventId } };
      if (phase === 'before') {
        // A declared before-hook (manifest `hooks:` with phase:'before') is a hard gate: a
        // disapproval vetoes the verb. (Gate evaluation on a transition is NOT here — a forward
        // move injects the DoR/DoD checklist that the specialist self-evaluates; no separate
        // evaluator fires. The old agreement-hook enforcement dial + soft-warn downgrade went
        // with that deletion.)
        const verdict = parseVerdict(res.stdout, res.ok);
        bus.emit('hook', { hook: hookId, phase, verdict });
        await log.append({ ...stamp, approve: verdict.approve, reason: verdict.reason });
        if (!verdict.approve) {
          throw new Error(`vetoed by hook "${hookId}": ${verdict.reason}`);
        }
      } else {
        bus.emit('hook', { hook: hookId, phase, output: res.stdout });
        await log.append({ ...stamp, output: res.stdout.slice(0, 280) });
      }
    }
    return [];
  }

  // --- capture ---------------------------------------------------------------

  // Defense in depth at the kernel seam. A card's slug becomes a filesystem path
  // via the type's path template, so a slug from ANY programmatic caller (not just
  // the CLI, whose explicitSlug already sanitizes) must never carry a path
  // separator, a `..` traversal, a leading dot, or a pathological length. Reject
  // loudly here — the kernel never writes a path from an unvetted slug. Cheap by
  // design: CLI users never trip it (their slug is already sanitized); this guards
  // non-CLI callers. Returns the slug for chaining.
  function assertSafeSlug(slug) {
    const s = String(slug ?? '');
    if (/[/\\]/.test(s) || s.includes('..') || s.startsWith('.') || s.length > 128) {
      throw new Error(`slug "${s}" is unsafe — no path separators, "..", leading ".", or over 128 chars`);
    }
    return s;
  }

  async function capture({ id, source, body, title, type, from, path, idempotencyKey, lane, payload, slug } = {}) {
    if (!source) throw new Error('capture: `source` is required (e.g. "agent:flow-finder")');
    if (!body || !body.trim()) throw new Error('capture: `body` is required (free text)');

    const sources = allowedSources(manifest);
    if (sources && !sources.includes(sourceKind(source))) {
      throw new Error(
        `capture: source kind "${sourceKind(source)}" not allowed — ${admittedSourcesNote(manifest)}; add it to the destination inbox.sources to accept this intake`,
      );
    }
    if (type != null) {
      const def = typeDef(manifest, type);
      if (def && def.flow === false) {
        throw new Error(`capture: "${type}" is a record type (flow:false) — it lives in the knowledge layer, not the board`);
      }
      const types = cardTypes(manifest);
      if (types && !types.includes(type)) {
        throw new Error(`capture: type "${type}" not in board types [${types.join(', ')}]`);
      }
      // externalKey — an OVERLAY CONSTRAINT, not a different identity. kanbento_id
      // is and stays THE primary key of every card (engine-owned, always minted);
      // a type declaring externalKey says its instances must ALSO carry a unique
      // natural key — the listed card fields — which the capture fold enforces
      // (best-effort, local log) and resolves to the kanbento_id (the sync/dedup
      // seam). v1 supports exactly the intake compound ["source","key"]; the array
      // form (a composite key is a list of field pointers) keeps the grammar stable
      // for later pointers to other card fields (e.g. lane fields), no migration.
      if (def?.externalKey != null) {
        const ek = def.externalKey;
        if (!Array.isArray(ek) || ek.length !== 2 || ek[0] !== 'source' || ek[1] !== 'key') {
          throw new Error(`capture: type "${type}" — externalKey: only ["source","key"] is supported (field pointers beyond the intake compound land later)`);
        }
        if (!idempotencyKey) {
          throw new Error(`capture: type "${type}" declares externalKey ["source","key"] — instances must carry the natural key; pass --key (scoped by --source)`);
        }
      }
    }
    // Lane values: a closed `values` set turns enumeration into a validating
    // constraint (declaring values IS the opt-in to strictness). An unset value
    // is fine — the card sits in the shared lane until the axis binds.
    for (const def of lanes(manifest)) {
      if (!def.values) continue;
      const v = laneValue({ payload: payload ?? {}, lane: lane ?? {} }, def);
      if (v != null && !def.values.includes(v)) {
        throw new Error(`capture: lane ${def.axis}="${v}" not in declared values [${def.values.join(', ')}]`);
      }
    }
    // Strict relations close the vocabulary: reject an undeclared or out-of-range edge at
    // capture too (the other write path besides `link`). A no-op in advisory mode.
    if (payload?.refs) {
      for (const e of refEdges(payload.refs)) {
        const err = checkRelationStrict(manifest, e.rel, parseCurie(e.curie)?.type, 0);
        if (err) throw new Error(`capture: ${err}`);
      }
    }
    // Associate the new item with a source card (e.g. a brief from its research).
    // The parent link IS the grouping/container — no folder needed.
    let parent = null;
    if (from) {
      parent = resolveCard(rebuild(await log.read()), from)?.id;
      if (!parent) throw new Error(`capture: --from card "${from}" not found`);
    }
    if (idempotencyKey) {
      // The natural-key fold — enforces the externalKey overlay constraint (only
      // reached when a key was passed; an externalKey type requires one above).
      // A capture without a key has nothing to enforce — kanbento_id, the primary
      // key, is unique by construction. source+key is the compound: a key is scoped
      // by its source, so the same key from two sources is two distinct captures.
      // Re-capture with the same source+key resolves to the existing card's
      // kanbento_id (idempotent no-op) — re-ingesting the same external item never
      // duplicates it.
      // Uniqueness is BEST-EFFORT: a fold over the local log at capture time. Known
      // limits (deferred until evidence): concurrent captures can race (no global
      // index/lock), and a cross-board or merged log can carry the same source+key
      // twice — the fold sees only what is already appended here.
      const existing = (await log.read()).find(
        (e) => e.type === 'ItemCaptured' && e.idempotencyKey === idempotencyKey && e.by === source,
      );
      if (existing) return projectCaptured(existing, { derive: deriveSlug }); // idempotent: same source+key -> same card
    }

    const cardId = id ?? randomUUID(); // caller may supply the id (CLI names the artifact by it first)
    const worktree = await worktreeStamp([], cardId, { isCapture: true });
    const event = {
      type: 'ItemCaptured',
      eventId: randomUUID(),
      cardId,
      at: now(),
      by: source,
      boardRevision: manifest.board?.revision ?? 0,
      body: body.trim(),
      // An explicit one-line title; absent -> projectCaptured derives it from the
      // body's first line, so a rich multi-line submission keeps a short handle.
      ...(title && title.trim() ? { title: title.trim() } : {}),
      landing: inboxLanding(manifest),
      // The human handle: minted here so it is immutable in the log (immune to
      // later title edits). Absent -> projectCaptured derives one from the body.
      // An explicit slug is the operator's word: reject an unsafe one loudly,
      // then sanitize the charset WITHOUT capping (explicitSlug, not slugify) —
      // silently shortening it would corrupt the chosen handle.
      ...(slug ? { slug: explicitSlug(assertSafeSlug(slug)) } : {}),
      ...(type != null ? { cardType: type } : {}),
      ...(parent ? { parent } : {}),
      // born tracked: link the card to the artifact capture materializes (the
      // card owns it, so identity is the card's own id).
      ...(path ? { binding: { path, identity: cardId } } : {}),
      ...(lane ? { lane } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(payload ? { payload } : {}),
      ...causeFromEnv(),
      ...worktree,
    };

    await dispatch(event, 'before');
    await log.append(event);
    const card = projectCaptured(event, { derive: deriveSlug });
    bus.emit('captured', card);
    await dispatch(event, 'after');
    return card;
  }

  // --- transition ------------------------------------------------------------

  async function transition(cardRef, toStageId, { by = 'agent' } = {}) {
    const events = await log.read();
    const cards = rebuild(events);
    const card = resolveCard(cards, cardRef);
    if (!card) throw new Error(`transition: card "${cardRef}" not found`);
    assertLive(card, 'transition');

    const from = card.state;
    if (from === toStageId) throw new Error(`transition: card already in "${toStageId}"`);

    const toStage = stageById(manifest, toStageId);
    if (!toStage) throw new Error(`transition: no such stage "${toStageId}"`);

    // Legality: the immediate forward step, an explicit flow edge, or a return to
    // the pool (any options stage) — the un-commit / deprioritize move. A returned
    // card re-enters the pool at the back (the projection sorts by re-entry), so
    // it sinks rather than resurfacing as the oldest.
    const isForward = nextStageId(manifest, from) === toStageId;
    const edge = flowEdge(manifest, from, toStageId);
    const isReturn = toStage.role === 'options';
    if (!isForward && !edge && !isReturn) {
      const allowed = [nextStageId(manifest, from), ...flowsFrom(manifest, from).map((f) => f.to)]
        .filter(Boolean)
        .join(', ');
      throw new Error(`transition: ${from} -> ${toStageId} not allowed (try: ${allowed || 'none'})`);
    }

    const warnings = [];

    // WIP guard on the target stage.
    const inTarget = [...cards.values()].filter((c) => c.state === toStageId && !c.archived).length;
    const capacityAvailable = toStage.wip == null || inTarget < toStage.wip;
    if (!capacityAvailable) {
      const msg = `${toStageId} at WIP limit ${toStage.wip}`;
      if (wipEnforcement(manifest) === 'strict') throw new Error(`blocked: ${msg}`);
      warnings.push(`WIP (advisory): ${msg}`);
    }

    // The DoR/DoD (a stage's entry/exit criteria) are not judged by a separate evaluator
    // here: a forward move injects the gate checklist (seedStageGate, below) and the
    // coordinator-dispatched specialist self-evaluates it. No claude -p gate fires on the move.

    // Loop iteration signal (a feedback edge with a convergence budget).
    // Surface taken/max on the return so the CLI can print remaining headroom.
    let loop = null;
    if (edge?.kind === 'loop') {
      const taken = (card.iterationCount ?? 0) + 1;
      loop = { taken, maxIterations: edge.maxIterations ?? null };
      if (edge.maxIterations && taken >= edge.maxIterations) {
        warnings.push(`loop ${from}->${toStageId} reached maxIterations ${edge.maxIterations} — consider escalating`);
      }
    }

    const worktree = await worktreeStamp(events, card.id, {});
    const event = {
      type: 'CardTransitioned',
      eventId: randomUUID(),
      cardId: card.id,
      at: now(),
      by,
      from,
      to: toStageId,
      via: edge ? edge.kind : 'forward',
      ...(loop ? { loop: true } : {}),
      ...causeFromEnv(),
      ...worktree,
    };

    const gateWarnings = await dispatch(event, 'before'); // a declared before-hook may still veto
    if (gateWarnings?.length) warnings.push(...gateWarnings);
    await log.append(event);
    // Seed the landed stage's gate checklist AFTER the transition lands (a declared-hook veto
    // never reaches here). Forward-only; loop-back / return re-entries do not seed.
    // checklistWrite text-dedup keeps re-entry idempotent.
    if (isForwardMove(manifest, from, toStageId)) {
      await seedStageGate(card.id, toStageId, { by });
    }
    const updated = rebuild(await log.read()).get(card.id);
    bus.emit('transitioned', { card: updated, warnings });
    await dispatch(event, 'after');
    return { card: updated, warnings, loop };
  }

  // Inject `"${stageId} gate"` from the stage's entry (DoR) + exit (DoD) criteria.
  // No-op when the stage has no criteria, or every item is already present (re-entry).
  // Preserves any already-ticked done state on re-seed so self-assessment ticks survive.
  async function seedStageGate(cardId, stageId, { by = 'agent' } = {}) {
    const gate = gateChecklistItems(manifest, stageId, boardDir);
    if (!gate) return;
    const card = rebuild(await log.read()).get(cardId);
    if (!card) return;
    const stored = card.checklists?.[gate.listName] ?? [];
    const have = new Set(stored.map((it) => it.text));
    const newcomers = gate.items.filter((it) => !have.has(it.text));
    if (!newcomers.length) return; // idempotent: nothing new to append
    // checklistWrite is whole-list + append-only: restate stored (keep done), then append.
    const desired = [...stored.map((it) => ({ text: it.text, done: !!it.done })), ...newcomers];
    await checklistWrite(cardId, gate.listName, desired, { by });
  }

  // --- commit ----------------------------------------------------------------

  // Sugar over transition into the commit-role stage. Transition owns the error
  // strings (`transition: …`); re-label so the verb the user typed is named
  // (story:commit-error-verb — `commit missing-ref` must not say `transition:`).
  async function commit(cardRef, opts = {}) {
    const target = commitStageId(manifest);
    if (!target) {
      throw new Error('commit: this board has no `commit` stage (no commitment point yet)');
    }
    try {
      return await transition(cardRef, target, opts);
    } catch (err) {
      rethrowAsVerb(err, 'transition', 'commit');
    }
  }

  // --- bind (attach a materialized doc to a card) ----------------------------

  // Record that a card now has a bound doc — its body/writeup, materialized on
  // demand by `elaborate` (a card starts thin, grows a doc when it earns one).
  // Append-only like every mutation: a CardBound event the fold applies. The CLI
  // owns the filesystem (it writes the doc); the kernel owns the link.
  async function bind(cardRef, path, { by = 'agent' } = {}) {
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`bind: card "${cardRef}" not found`);
    assertLive(card, 'bind');
    const worktree = await worktreeStamp(events, card.id, {});
    const event = { type: 'CardBound', eventId: randomUUID(), cardId: card.id, at: now(), by, path, identity: card.id, ...causeFromEnv(), ...worktree };
    await log.append(event);
    bus.emit('bound', { card: card.id, path });
    return rebuild([...events, event]).get(card.id);
  }

  // --- link (connect two existing cards with a typed relation) ---------------

  // Add an edge from one card to another, post-capture, with no body/doc required —
  // relations were capture-time only, which lost any connection realized later. Both
  // refs resolve like any handle (slug/id/CURIE/prefix). The edge is stored on `from`'s
  // payload.refs[rel] as the target's CURIE (typed) or slug, so `refs` can walk it. The
  // relation key is open (progressive fidelity); a board may later declare + close it.
  async function link(fromRef, rel, toRef, { by = 'agent', target = null, targetType = null } = {}) {
    if (!rel) throw new Error('link: a relation is required — link <from> <rel> <to>');
    rel = resolveRelKey(manifest, rel); // bare vocabulary name -> dotted id (stored keys are never ambiguous)
    const events = await log.read();
    const cards = rebuild(events);
    const from = resolveCard(cards, fromRef);
    if (!from) throw new Error(`link: card "${fromRef}" not found`);
    assertLive(from, 'link');
    // A card's forward edge stores a target STRING (CardLinked). Direct callers pass a
    // card ref we resolve here; linkRefs passes a pre-resolved target so the edge can
    // point at a record too (card -> capability) — the target need not be a card.
    let to = null;
    if (target == null) {
      to = resolveCard(cards, toRef);
      if (!to) throw new Error(`link: card "${toRef}" not found`);
      if (to.id === from.id) throw new Error('link: a card cannot link to itself');
      target = to.type && to.slug ? `${to.type}:${to.slug}` : to.slug ?? to.id; // a slugless card is addressed by id
      targetType = to.type;
    }
    const strictErr = checkRelationStrict(manifest, rel, targetType, (from.payload?.refs?.[rel] ?? []).length);
    if (strictErr) throw new Error(`link: ${strictErr}`);
    const event = { type: 'CardLinked', eventId: randomUUID(), cardId: from.id, at: now(), by, rel, target, ...causeFromEnv() };
    await log.append(event);
    bus.emit('linked', { card: from.id, rel, target });
    return { card: rebuild([...events, event]).get(from.id), from, to, rel, target };
  }

  // --- unlink (retract a typed edge — symmetric to link) ---------------------

  // Drop a card's forward edge, post-hoc. Append-only like every retraction: a CardUnlinked
  // event the fold applies (it removes the target from payload.refs[rel]), never a log rewrite.
  // Idempotent — retracting an edge that isn't there is a no-op (removed:false), not a throw.
  // `link` stores only the forward edge (inverse/symmetric relations are derived at read time),
  // so unlink retracts only the forward edge — exactly what link created, no more.
  async function unlink(fromRef, rel, toRef, { by = 'agent', target = null } = {}) {
    if (!rel) throw new Error('unlink: a relation is required — unlink <from> <rel> <to>');
    rel = resolveRelKey(manifest, rel); // bare vocabulary name -> dotted id
    const events = await log.read();
    const cards = rebuild(events);
    const from = resolveCard(cards, fromRef);
    if (!from) throw new Error(`unlink: card "${fromRef}" not found`);
    assertLive(from, 'unlink');
    const stored = from.payload?.refs?.[rel] ?? [];
    // `link` stores the target's spelling AS RESOLVED AT LINK TIME (a raw uuid before
    // slugging, `type:slug` after, a verbatim string for an unresolvable CURIE). So
    // resolve-then-compare against the CURRENT spelling can miss what is actually
    // stored. Retract against a CANDIDATE SET: the resolved spelling(s) PLUS the
    // verbatim toRef — whichever the stored edge carries is the one we drop.
    const candidates = new Set();
    if (target != null) candidates.add(target); // unlinkRefs' pre-resolved current spelling
    if (toRef != null) candidates.add(String(toRef)); // verbatim fallback — a stale uuid or a file: CURIE
    // Always expand with the target card's own spellings when it resolves — a
    // pre-resolved `target` must not NARROW the set (the stored edge may carry the
    // raw id from before an out-of-band slugging).
    const to = resolveCard(cards, toRef);
    if (to) {
      candidates.add(to.id);
      if (to.slug) candidates.add(to.slug);
      if (to.type && to.slug) candidates.add(`${to.type}:${to.slug}`);
    } else if (target == null && !stored.includes(String(toRef))) {
      // No resolution and nothing stored under that verbatim spelling either — a
      // genuine typo, not a stale edge. Keep the teaching "not found" contract.
      throw new Error(`unlink: card "${toRef}" not found`);
    }
    const hit = stored.find((t) => candidates.has(t));
    if (!hit) {
      return { card: from, from, rel, target: target ?? String(toRef), removed: false }; // absent edge — honest no-op
    }
    const event = { type: 'CardUnlinked', eventId: randomUUID(), cardId: from.id, at: now(), by, rel, target: hit, ...causeFromEnv() };
    await log.append(event);
    bus.emit('unlinked', { card: from.id, rel, target: hit });
    return { card: rebuild([...events, event]).get(from.id), from, rel, target: hit, removed: true };
  }

  // --- checklists (boolean status carrier + optional discard) ----------------
  // Each item: boolean open↔done, optional retracted=discarded from the contract.
  // --retract is discard (not a third boolean, not hard-delete). See checklist.js.

  // Whole-text write. `desired` is the parsed list [{text, done}] the CLI produced
  // from the `- [ ]` / `- [x]` grammar; this DERIVES the events by diffing it against
  // the stored list (matched by text identity). The core invariant is append-only:
  // a *active* (non-discarded) item that IS stored but is MISSING from the submission
  // is a delete/text-edit — rejected. Discarded items may be omitted (writers need not
  // restate dead criteria) or restated (accepted, still discarded). Order is
  // canonicalized: stored items keep their stored index; a new item (a text not yet
  // stored) appends after them, in submission order.
  //
  // Boolean done-state on existing items: whole-text may promote open→done (`[x]`),
  // but MUST NOT derive Unchecked from a restated `[ ]` — restating must not wipe
  // ticks. Explicit `checklistToggle(..., false)` / `--uncheck` is the uncheck path.
  // Newcomers still take their mark from the write.
  async function checklistWrite(cardRef, list, desired, { by = 'agent' } = {}) {
    list = String(list ?? '').trim();
    if (!list) throw new Error('checklist: a list name is required');
    const seen = new Set();
    for (const d of desired) {
      if (seen.has(d.text)) throw new Error(`checklist: duplicate item "${d.text}" — items are identified by text, so they must be unique within a list`);
      seen.add(d.text);
    }
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`checklist: card "${cardRef}" not found`);
    assertLive(card, 'checklist');
    const stored = card.checklists?.[list] ?? [];
    // no-delete guard: every active (non-retracted) stored text MUST survive into the
    // submission. Retracted items are optional in the restatement.
    for (const it of stored) {
      if (it.retracted) continue;
      if (!seen.has(it.text)) {
        throw new Error(`checklist: "${it.text}" is stored but missing from the write — whole-text is the full desired list (restate every active item, then add newcomers); append-only: never hard-delete or rename (use --retract to discard a criterion from the contract)`);
      }
    }
    const storedByText = new Map(stored.map((it, i) => [it.text, { done: it.done, index: i, retracted: !!it.retracted }]));
    const derived = [];
    // Existing items: promote [ ]→[x] only; never wipe a stored tick via whole-text.
    for (const d of desired) {
      const ex = storedByText.get(d.text);
      if (!ex) continue;
      if (d.done && !ex.done) derived.push({ type: 'ChecklistItemChecked', list, index: ex.index });
      // no ChecklistItemUnchecked from whole-text — preserve done-state on restate
    }
    // New items: append after the stored tail, keeping submission order.
    let nextIndex = stored.length;
    for (const d of desired) {
      if (storedByText.has(d.text)) continue;
      derived.push({ type: 'ChecklistItemAdded', list, index: nextIndex, text: d.text });
      if (d.done) derived.push({ type: 'ChecklistItemChecked', list, index: nextIndex });
      nextIndex++;
    }
    const out = [];
    for (const d of derived) {
      const event = { ...d, eventId: randomUUID(), cardId: card.id, at: now(), by, ...causeFromEnv() };
      await log.append(event);
      events.push(event);
      out.push(event);
    }
    bus.emit('checklist', { card: card.id, list, derived: out.length });
    return { card: rebuild(events).get(card.id), list, events: out };
  }

  // Single-item toggle by stable (0-based) index — merge-safe (two actors toggling
  // different indices compose cleanly). Idempotent: toggling to the state it already
  // holds is an honest no-op (changed:false), not a throw. Retracted items still
  // accept toggle (done flag is independent history; open counts ignore retracted).
  async function checklistToggle(cardRef, list, index, done, { by = 'agent' } = {}) {
    list = String(list ?? '').trim();
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`checklist: card "${cardRef}" not found`);
    assertLive(card, 'checklist');
    const items = card.checklists?.[list];
    if (!items || !items.length) throw new Error(`checklist: card has no "${list}" list`);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error(`checklist: "${list}" has no item at position ${index + 1} (1..${items.length})`);
    }
    if (items[index].done === done) return { card, list, index, changed: false };
    const event = { type: done ? 'ChecklistItemChecked' : 'ChecklistItemUnchecked', eventId: randomUUID(), cardId: card.id, at: now(), by, list, index, ...causeFromEnv() };
    await log.append(event);
    bus.emit('checklist', { card: card.id, list, index });
    return { card: rebuild([...events, event]).get(card.id), list, index, changed: true };
  }

  // Discard an item by stable (0-based) index — append-only. The discard form of the
  // boolean status carrier: a criterion that left the contract (wrong, not merely
  // unmet) is retracted so it no longer blocks --incomplete, while the row stays
  // visible (stable indices, history as [~]). Not uncheck, not hard-delete. Idempotent.
  async function checklistRetract(cardRef, list, index, { by = 'agent' } = {}) {
    list = String(list ?? '').trim();
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`checklist: card "${cardRef}" not found`);
    assertLive(card, 'checklist');
    const items = card.checklists?.[list];
    if (!items || !items.length) throw new Error(`checklist: card has no "${list}" list`);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error(`checklist: "${list}" has no item at position ${index + 1} (1..${items.length})`);
    }
    if (items[index].retracted) return { card, list, index, changed: false };
    const event = { type: 'ChecklistItemRetracted', eventId: randomUUID(), cardId: card.id, at: now(), by, list, index, ...causeFromEnv() };
    await log.append(event);
    bus.emit('checklist', { card: card.id, list, index, retracted: true });
    return { card: rebuild([...events, event]).get(card.id), list, index, changed: true };
  }

  // --- reslug (refine a card's slug — model-derived OR explicit pin) ---------

  // Record a refined slug (and, if a bound doc was renamed to match, its new path).
  // Append-only — a CardSlugged event the fold applies. The slug is advisory (the id
  // is the key), so this can safely land AFTER capture returned: the handle just
  // sharpens, nothing resolves wrong in the gap. The model call and any file rename
  // are the CLI's; this records. Two shapes:
  //   - default (model-derived / auto-sharpener): slugify capped at 48 so a chatty
  //     model can never write a bad handle.
  //   - pinned:true (explicit elaborate --slug): the operator's word — explicitSlug
  //     (sanitize, never cap). Sacred: overrides a prior pin; collision is the
  //     caller's job (applyReslug fails loud).
  // No-op when the slug is unchanged/empty.
  async function reslug(cardRef, newSlug, { path, by = 'agent', pinned = false } = {}) {
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`reslug: card "${cardRef}" not found`);
    if (card.archived) return card; // frozen — the handle is settled; advisory reslug is a no-op
    assertSafeSlug(newSlug); // defense in depth: a reslug renames a path, so reject an unvetted programmatic slug
    // pinned = operator's --slug (verbatim after sanitize); else model-derived (capped).
    newSlug = pinned
      ? explicitSlug(assertSafeSlug(newSlug))
      : slugify(String(newSlug ?? ''), 48);

    if (!newSlug || newSlug === 'untitled' || newSlug === card.slug) return card;
    // pinned:true marks an operator --slug so a later retitle auto-sharpener
    // leaves it alone (same sacred rule as ItemCaptured.slug at birth).
    const event = {
      type: 'CardSlugged', eventId: randomUUID(), cardId: card.id, at: now(), by, slug: newSlug,
      ...(path ? { path } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...causeFromEnv(),
    };
    await log.append(event);
    bus.emit('slugged', { card: card.id, slug: newSlug });
    return rebuild([...events, event]).get(card.id);
  }

  // Correct a card's title as understanding improves (titles rot; the doc moves on
  // but the board renders the old framing). Append-only — a CardRetitled event the
  // fold applies, latest wins. Substantive, unlike the advisory reslug: a frozen
  // (archived) card refuses. No-op when unchanged/empty.
  // pinned:true marks an operator --title (elaborate --title) so a later naming
  // pass leaves it alone — same sacred rule as CardSlugged.pinned / ItemCaptured.title.
  // A model-derived CardRetitled has no .pinned and may be re-sharpened.
  async function retitle(cardRef, title, { by = 'agent', pinned = false } = {}) {
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`retitle: card "${cardRef}" not found`);
    if (card.archived) throw new Error(`retitle: card "${card.slug ?? card.id.slice(0, 8)}" is archived (read-only)`);
    title = String(title ?? '').trim();
    if (!title || title === card.title) return card;
    const event = {
      type: 'CardRetitled', eventId: randomUUID(), cardId: card.id, at: now(), by, title,
      ...(pinned ? { pinned: true } : {}),
      ...causeFromEnv(),
    };
    await log.append(event);
    return rebuild([...events, event]).get(card.id);
  }

  // Assign / reassign / heal a card's product scope. Append-only — a CardScoped
  // event the fold applies: `scope` + `payload.scope` (the log-owned field) and,
  // when the bound doc moved, `binding.path`. The CLI owns the filesystem (validate
  // the vocabulary, mkdir + rename); this records. `scope: null` is a heal of the
  // unscoped queue (placement only — un-scoping is not an assignable value).
  // No-op when the field and the optional path are already current.
  async function scope(cardRef, newScope, { path, by = 'agent' } = {}) {
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`scope: card "${cardRef}" not found`);
    assertLive(card, 'scope');
    const next = newScope == null || newScope === '' ? null : String(newScope);
    const sameScope = (card.scope ?? null) === next;
    const samePath = !path || card.binding?.path === path;
    if (sameScope && samePath) return card;
    const event = {
      type: 'CardScoped', eventId: randomUUID(), cardId: card.id, at: now(), by,
      scope: next, from: card.scope ?? null,
      ...(path ? { path } : {}),
      ...causeFromEnv(),
    };
    await log.append(event);
    bus.emit('scoped', { card: card.id, scope: next, path });
    return rebuild([...events, event]).get(card.id);
  }

  // --- archive (a terminal offload: freeze at a stage, disposition derived) ----

  // Archive names the STAGE to freeze at (the intent). If that is not where the card
  // already sits, it gets there through a real, GATED transition — so a well-defined
  // process cannot be circumvented: you cannot freeze-as-`delivered` at `done`
  // without passing done's gate (and cannot jump a pool card straight there — the
  // transition's own legality forbids skipping the flow). The DISPOSITION is then
  // DERIVED from the stage's role and frozen ON the card as an INVARIANT — stage ids
  // drift (renamed, removed) but the semantic (throughput / spillage / triage) must
  // not. Freezing at the card's current stage moves nothing (an in-place discard /
  // abandon / done-column offload); a declared `on: CardArchived` hook may still veto.
  async function archive(cardRef, stageRef, { by = 'agent' } = {}) {
    let card = resolveCard(rebuild(await log.read()), cardRef);
    if (!card) throw new Error(`archive: card "${cardRef}" not found`);
    if (card.archived) throw new Error(`archive: card is already archived (${card.disposition ?? 'frozen'})`);
    const stage = stageById(manifest, stageRef);
    if (!stage) throw new Error(`archive: no such stage "${stageRef}"`);
    const disposition = dispositionForRole(stage.role);
    if (!disposition) throw new Error(`archive: stage "${stage.id}" (role ${stage.role ?? 'none'}) has no disposition to freeze`);

    // Reach the terminal the same way as any move — the gate fires and may prevent it.
    // Re-label transition failures so archive callers see `archive:`, not the inner verb.
    if (card.state !== stage.id) {
      try {
        ({ card } = await transition(cardRef, stage.id, { by }));
      } catch (err) {
        rethrowAsVerb(err, 'transition', 'archive');
      }
    }

    const event = { type: 'CardArchived', eventId: randomUUID(), cardId: card.id, at: now(), by, stage: stage.id, disposition, ...causeFromEnv() };
    await dispatch(event, 'before'); // a declared policy hook may still veto (e.g. who may discard)
    await log.append(event);
    const updated = rebuild(await log.read()).get(card.id);
    bus.emit('archived', { card: updated, disposition });
    await dispatch(event, 'after');
    return updated;
  }

  // --- run (the autonomous driver) -------------------------------------------

  // Drive a seed card toward an exit criterion by invoking a fresh agent for each
  // stage. The AGENT does the work and advances the card itself — we lean on its
  // judgment and let the gates be the guardrails (an unearned move is vetoed
  // independently). The engine only supervises: invoke, observe progress, and at
  // delivery judge whether the exit holds. Per-stage re-invocation keeps context
  // fresh; the board (log + the card's bound artifact) is the memory that carries
  // across the reset — the transcript does not. The invoker is pluggable
  // (manifest.runInvoker, default `claude -p`), mirroring the gate evaluator; a
  // test injects `invoke`.
  async function run(seedRef, exit, { by = 'agent', maxSteps = 24, maxStuck = 3, invoke, journal, scratch } = {}) {
    exit = String(exit ?? '').trim();
    if (!exit) throw new Error('run: an exit criterion is required — run <card> "<exit>"');
    const invoker = invoke ?? defaultInvoke;
    const j = (line) => journal?.write?.(line); // a human-readable trace — observability for the run
    let card = await loadCard(seedRef);
    if (!card) throw new Error(`run: card "${seedRef}" not found`);
    await log.append({ type: 'RunStarted', eventId: randomUUID(), at: now(), by, cardId: card.id, exit, ...causeFromEnv() });
    bus.emit('run', { phase: 'start', card, exit });
    j(`▶ run ${card.slug ? card.slug + '@' : ''}${card.id.slice(0, 8)}  ·  goal: ${exit}`);

    const trail = [];
    const end = async (outcome, reason) => {
      await log.append({ type: 'RunEnded', eventId: randomUUID(), at: now(), by, cardId: card.id, outcome, reason: String(reason ?? '').slice(0, 280), steps: trail.length, ...causeFromEnv() });
      bus.emit('run', { phase: 'end', card, outcome, reason });
      j(`■ ${outcome}${reason ? ': ' + reason : ''}  (${trail.length} step(s))`);
      return { outcome, card, reason, steps: trail };
    };

    let stuck = 0;
    for (let step = 0; step < maxSteps; step++) {
      const stage = stageById(manifest, card.state);
      const next = nextStageId(manifest, card.state);

      // Terminal — the flow delivered. Does the OUTCOME hold? (the exit, judged once.)
      if (!next || stage?.role === 'done') {
        j(`· delivered to ${card.state} — judging the exit criterion`);
        const v = await judgeExit(card, exit);
        return end(v.approve ? 'delivered' : 'exit-unmet', v.reason);
      }

      // Invoke a fresh agent for this stage. It works AND advances the card; the
      // gates guard the move. We hand it rich context and trust its judgment.
      j(`· step ${step}: stage ${stage.id} → invoking agent`);
      const brief = buildBrief(card, stage, exit, await log.read(), journal?.path, scratch);
      try {
        await invoker(brief, { card, stage, boardDir, exit, next, scratch });
      } catch (e) {
        return end('escalate', `invoker failed: ${e.message}`);
      }

      const before = card.state;
      card = (await loadCard(card.id)) ?? card;
      if (card.state !== before) {
        stuck = 0; // the agent moved it — the gates allowed it through
        trail.push({ step, from: before, to: card.state });
        j(`  ✓ advanced ${before} → ${card.state}`);
        continue;
      }

      // No progress this pass: the agent stalled, or its move was vetoed (the veto
      // is on the log, and feeds the next brief as remediation).
      stuck += 1;
      const veto = lastVeto(await log.read(), card.id);
      trail.push({ step, stalledAt: stage.id, stuck, veto: veto?.reason ?? null });
      j(`  ◌ no progress at ${stage.id}${veto?.reason ? ` (vetoed: ${veto.reason})` : ''} — stuck ${stuck}/${maxStuck}`);
      if (stuck >= maxStuck) {
        return end('escalate', veto?.reason ? `stuck at ${stage.id}: ${veto.reason}` : `stuck at ${stage.id} — no progress in ${maxStuck} attempts`);
      }
    }
    return end('escalate', `budget exhausted (${maxSteps} steps) at ${card.state}`);
  }

  async function loadCard(ref) {
    return resolveCard(rebuild(await log.read()), ref);
  }

  // Judge the run's exit criterion at delivery — the same evaluator + verdict path
  // the gates use, aimed at the run-level outcome rather than a stage criterion.
  async function judgeExit(card, exit) {
    const hook = {
      id: 'run:exit',
      evaluator: manifest.runExitEvaluator ?? manifest.agreementEvaluator, // undefined -> claude -p
      phase: 'before',
      policy: `Run exit criterion:\n- ${exit}`,
      evaluate:
        "Judge whether the run's exit criterion above is satisfied by the delivered work — the card and " +
        'its bound artifact (card.binding.path). Answer approve:true only if it clearly holds.',
    };
    const event = { type: 'RunExitCheck', eventId: randomUUID(), cardId: card.id };
    const events = await log.read();
    const context = await buildContext(manifest, event, hook, rebuild(events), events, boardDir);
    const res = await runEvaluator(hook, { event, prompt: renderPrompt(context), context, boardDir });
    return parseVerdict(res.stdout, res.ok);
  }

  // The doer's brief — deliberately RICH (awareness beats hard-scoping): the goal,
  // the whole card, the stage's procedure + Ready/Done contract, the board state,
  // the card's history, and any prior veto to remediate. The agent reads this, does
  // the work, and advances the card; the gate verifies independently.
  function buildBrief(card, stage, exit, events, journalPath, scratch) {
    const cards = rebuild(events);
    const h = card.slug ? `${card.slug}@${card.id.slice(0, 8)}` : card.id.slice(0, 8);
    const next = nextStageId(manifest, stage.id);
    const c = stageContract(manifest, stage.id, boardDir);
    const history = events.filter((e) => e.cardId === card.id).map(briefEvent);
    const veto = lastVeto(events, card.id);
    const fmt = (cs) => cs.map((x) => `  - ${x.text}${x.severity ? ` [${x.severity.toUpperCase()}]` : ''}`).join('\n');
    return [
      `You are an autonomous agent on the "${manifest.board?.id ?? 'kanbento'}" board. Advance ONE card through its current stage toward the run's goal. Use your judgment — the board's gates are your guardrails.`,
      `\n# Run goal — the run stops when this holds\n  ${exit}`,
      `\n# Card\n${JSON.stringify(card, null, 2)}`,
      `\n# Stage: ${stage.id} (${stage.role})${next ? `  →  next: ${next}` : '  (final)'}`,
      c.body ? `\n## Procedure (how to do this stage's work)\n${c.body.trim()}` : '',
      c.ready.length ? `\n## This stage assumes (Definition of Ready)\n${fmt(c.ready)}` : '',
      c.done.length ? `\n## To leave, your work must satisfy (Definition of Done — judged independently)\n${fmt(c.done)}` : '',
      `\n# Board state (cards per stage)\n${JSON.stringify(stageCounts(manifest, cards))}`,
      history.length ? `\n# This card's history\n${history.map((x) => '- ' + x).join('\n')}` : '',
      veto ? `\n# ⚠ Your last attempt was rejected\n  ${veto.reason}\nAddress this before advancing again.` : '',
      card.binding?.path ? `\n# Output target (the deliverable)\nWrite the deliverable into the card's bound artifact: ${card.binding.path}` : '',
      scratch || journalPath
        ? `\n# Run workspace${
            scratch ? `\nScratchpad — keep intermediate/working artifacts here; it persists across stages (your context does not), so leave anything a later stage needs: ${scratch}` : ''
          }${journalPath ? `\nJournal — append a brief note of what you did and why (and read it for earlier steps' notes): ${journalPath}` : ''}`
        : '',
      `\n# Now\nDo this stage's work. Externalize everything into the card's artifact, the scratchpad, and the board — the next stage starts from a clean context and sees only what you leave behind. When the Definition of Done is met, advance the card yourself with the kanbento CLI ($KANBENTO_CLI):\n  kanbento transition ${h} ${next ?? '<next-stage>'}\nAn independent gate verifies your work; do not try to bypass it. If you cannot satisfy the DoD, leave the card in place and record why in the artifact.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // The default doer: spawn the invoker command with the brief in the environment,
  // bumping the causation depth so any verbs the agent calls (and the gates they
  // fire) stay bounded. stdout is ignored — the gate, not the agent, is the truth.
  async function defaultInvoke(brief, { boardDir, scratch }) {
    const command = manifest.runInvoker ?? DEFAULT_INVOKER;
    await execCommand(command, {
      KANBENTO_PROMPT: brief,
      KANBENTO_BOARD: boardDir ?? '',
      KANBENTO_SCRATCH: scratch ?? '',
      KANBENTO_CLI: process.env.KANBENTO_CLI ?? '',
      KANBENTO_HOOK_DEPTH: String(Number(process.env.KANBENTO_HOOK_DEPTH ?? 0) + 1),
    });
  }

  // --- reconcile (apply a structural change to in-flight cards) --------------

  // Given the previous compiled program (the baseline), record the structural
  // change as an event and re-place orphaned cards with the default rules
  // (docs/evolution.md): a removed stage sends its cards to the first stage, a
  // renamed stage carries them to the new id. Reconciliation moves bypass gates
  // and WIP by design — a card must never be trapped in a stage that no longer
  // exists. The StructureMutated event keeps the change auditable and revertible.
  async function reconcile(baselineProgram, { by = 'system:reconcile' } = {}) {
    const program = compile(manifest);
    const changeset = diffCompiled(baselineProgram, program);
    if (isEmptyChangeset(changeset)) return { applied: false, changeset, moves: [], program };

    await log.append({
      type: 'StructureMutated',
      eventId: randomUUID(),
      at: now(),
      by,
      fromRevision: baselineProgram.revision,
      toRevision: program.revision,
      changeset,
      ...causeFromEnv(),
    });

    // Frozen cards are exempt: their disposition is the invariant, not their stage —
    // a re-placement would mutate a read-only record. They render by disposition
    // (ARCHIVE.md) and are already off the active board, so a dangling stage is moot.
    const cards = [...rebuild(await log.read()).values()].filter((c) => !c.archived);
    const moves = reconcileMoves(changeset, cards, program);
    for (const m of moves) {
      await log.append({
        type: 'CardTransitioned',
        eventId: randomUUID(),
        cardId: m.card,
        at: now(),
        by,
        from: m.from,
        to: m.to,
        via: 'reconcile',
        reason: m.reason,
      });
    }
    bus.emit('reconciled', { changeset, moves });
    return { applied: true, changeset, moves, program };
  }

  // --- sync (ingest a bound doc corpus into the store) -----------------------

  // Reflect the desired card states (read from a bound source by the caller)
  // into the store: create a card directly at its bound stage, or move an
  // existing one if the source stage changed. Matched by binding identity.
  // Like reconcile, sync placements bypass gates/WIP — the board mirrors the
  // source, it does not enforce against it. Write-back lives in binding.js.
  async function sync(docs, { by = 'sync' } = {}) {
    const cards = rebuild(await log.read());
    const byIdentity = new Map();
    for (const c of cards.values()) if (c.binding?.identity != null) byIdentity.set(c.binding.identity, c);

    const report = { created: 0, moved: 0, unchanged: 0 };
    for (const d of docs) {
      const existing = byIdentity.get(d.identity);
      if (!existing) {
        await log.append({
          type: 'ItemCaptured',
          eventId: randomUUID(),
          cardId: randomUUID(),
          at: now(),
          by,
          body: d.title,
          landing: d.stage, // born directly at its bound stage
          ...(d.type != null ? { cardType: d.type } : {}),
          binding: { path: d.path, identity: d.identity },
          payload: d.fields ?? {},
        });
        report.created++;
      } else if (existing.state !== d.stage) {
        await log.append({
          type: 'CardTransitioned',
          eventId: randomUUID(),
          cardId: existing.id,
          at: now(),
          by,
          from: existing.state,
          to: d.stage,
          via: 'sync',
        });
        report.moved++;
      } else {
        report.unchanged++;
      }
    }
    bus.emit('synced', report);
    return report;
  }

  // --- network membership: dynamic / cross-repo path (dormant) ----------------

  // The PRIMARY membership model is declarative: a board names its networks in its
  // own manifest and the roster is derived by scanning the tree (see network.js —
  // the docker-compose model). These event-based verbs are the deferred *dynamic*
  // path: a board in another repo that no shared scan can reach `join`s an anchor's
  // log at runtime. Kept as the cross-repo seam, not yet wired to the CLI.
  // Append-only, like cards: a re-join refreshes a location, a leave removes it.
  async function joinMember({ handle, location, by = 'agent' } = {}) {
    handle = String(handle ?? '').replace(/^@/, '');
    if (!handle) throw new Error('join: `handle` is required');
    if (!location) throw new Error('join: `location` is required');
    await log.append({ type: 'MemberJoined', eventId: randomUUID(), at: now(), by, handle, location, ...causeFromEnv() });
    bus.emit('joined', { handle, location });
    return rebuildRoster(await log.read()).get(handle);
  }

  async function leaveMember({ handle, by = 'agent' } = {}) {
    handle = String(handle ?? '').replace(/^@/, '');
    if (!handle) throw new Error('leave: `handle` is required');
    if (!rebuildRoster(await log.read()).has(handle)) throw new Error(`leave: "${handle}" is not a member`);
    await log.append({ type: 'MemberLeft', eventId: randomUUID(), at: now(), by, handle, ...causeFromEnv() });
    bus.emit('left', { handle });
  }

  async function roster() {
    return [...rebuildRoster(await log.read()).values()];
  }

  // --- reads (pure — never fire hooks) ---------------------------------------

  async function pool() {
    return [...rebuild(await log.read()).values()];
  }

  async function card(ref) {
    return resolveCard(rebuild(await log.read()), ref);
  }

  async function events() {
    return log.read();
  }

  // Fold the whole log into the current card projection. Every verb's event
  // type is replayed here; this is the single place state is derived — and it
  // is pure, so re-reading the history never re-runs an evaluator.
  // Merge — fold one card into another (dedupe: two similar backlog items, or a
  // forked brief/page). Append-only: a CardsMerged event, never a delete.
  async function merge(fromRef, intoRef, { by = 'agent', title } = {}) {
    const cards = rebuild(await log.read());
    const from = resolveCard(cards, fromRef);
    const into = resolveCard(cards, intoRef);
    if (!from) throw new Error(`merge: card "${fromRef}" not found`);
    if (!into) throw new Error(`merge: card "${intoRef}" not found`);
    if (from.id === into.id) throw new Error('merge: cannot merge a card into itself');
    assertLive(from, 'merge');
    assertLive(into, 'merge');
    const event = {
      type: 'CardsMerged',
      eventId: randomUUID(),
      from: from.id,
      into: into.id,
      at: now(),
      by,
      ...(title != null && title !== '' ? { title } : {}), // agent may synthesize a new description
      ...causeFromEnv(),
    };
    await dispatch(event, 'before');
    await log.append(event);
    await dispatch(event, 'after');
    return rebuild(await log.read()).get(into.id);
  }

  // --- procedureInvoked (log a routine invocation — audit-only) ---------------

  // Record that a procedure was invoked: a fact kanbento witnesses directly at `do`
  // time (the brief was served; execution is presumed — abandonment is the exception,
  // not the modeled case). Append-only; the card fold IGNORES it (audit-only, like
  // HookEvaluated). Carries the routine's worktree stamp (same observe seam cards
  // use, deduped against this curie's last invocation). The procedures listing folds
  // these into a last-invoked/due column; nothing enters the card store.
  async function procedureInvoked(curie, { by = 'agent' } = {}) {
    curie = String(curie ?? '').trim();
    if (!curie) throw new Error('procedureInvoked: a procedure curie is required');
    const events = await log.read();
    const stamp = await worktreeStamp(events, null, { prevDirty: lastProcedureInvokedDirty(events, curie) });
    const event = {
      type: 'ProcedureInvoked',
      eventId: randomUUID(),
      curie,
      at: now(),
      by,
      ...causeFromEnv(),
      ...stamp,
    };
    await log.append(event);
    bus.emit('procedureInvoked', { curie });
    return event;
  }

  // --- graduate (log a record's status transition — audit-only) --------------

  // Witness a record's status graduation (e.g. procedure draft→trusted): a
  // `RecordGraduated` event on the log, identity-stamped (`by` + the `principal`
  // the log wrapper adds), carrying the record curie, its type, the status field,
  // and from→to. Records are fs-owned (not in the card fold), so the frontmatter
  // write is the store and this event is AUDIT-ONLY — the card fold ignores it,
  // like ProcedureInvoked/HookEvaluated. Its whole point is provenance: "who armed
  // this gate and when" answerable from the log alone, not just git blame. The
  // caller (commandsjs graduateRecord) does the resolve, vocabulary validation, and
  // the frontmatter write; this method only appends the witness.
  async function graduate(record, from, to, { by = 'agent', field = 'status' } = {}) {
    const curie = String(record ?? '').trim();
    if (!curie) throw new Error('graduate: a record curie is required');
    to = String(to ?? '').trim();
    if (!to) throw new Error('graduate: a target status is required');
    const event = {
      type: 'RecordGraduated',
      eventId: randomUUID(),
      record: curie,
      field,
      from: from ?? null,
      to,
      at: now(),
      by,
      ...causeFromEnv(),
    };
    await log.append(event);
    bus.emit('graduated', { record: curie, from: from ?? null, to });
    return event;
  }

  // --- elaborated (witness a body write — audit-only) ------------------------

  // Witness a `kanbento elaborate` body write: an `Elaborated` event on the log,
  // identity-stamped (`by` + the `principal` the log wrapper adds), carrying the
  // target ref/id, the record-vs-card `kind`, the `mode` (append | replace body write,
  // or `retitle` for a title-only record revision), and a `retitled` flag when a title
  // change rode a body write (both witness a record retitle without inflating accretion).
  // Both records (fs-owned) and cards (bound docs) fire it — the log gains the audit
  // dimension for the board's most common knowledge act. AUDIT-ONLY for the card
  // fold (ignored on replay, like RecordGraduated); its purpose is the accretion
  // fold (foldAccretion in accretion.js) — appends-since-last-consolidation, derived
  // on demand by every consumer (elaborate nudge, lintShape, card --stats, CURATION).
  // The caller (commandsjs elaborateCard) does the resolve + the body write; this
  // method only appends the witness.
  async function elaborated(ref, kind, mode, { by = 'agent', retitled = false } = {}) {
    const target = String(ref ?? '').trim();
    if (!target) throw new Error('elaborated: a target ref is required');
    const event = {
      type: 'Elaborated',
      eventId: randomUUID(),
      ref: target,
      kind,
      mode, // append | replace (a body write) | retitle (a title-only record revision)
      ...(retitled ? { retitled: true } : {}), // a title change rode this body write — witnessed, not accreted
      at: now(),
      by,
      ...causeFromEnv(),
    };
    await log.append(event);
    bus.emit('elaborated', { ref: target, kind, mode });
    return event;
  }

  // --- act (play a move in the Collaborate protocol) -------------------------

  // Append a binding event to the card's current enactment (the COLLABORATE protocol —
  // note:collaborate-protocol-draft). A move lands its declared `out`s onto the
  // enactment keyed (card, stage, attempt); the log is the binding history. Discipline
  // (notation-not-runtime): SINGLE-BINDING is HARD-REFUSED as store integrity (a param
  // binds once, ever — like idempotency); everything else is JUDGMENT — a missing `in`,
  // an unknown move, an off-role play WARN, never wall. The parsed `protocol` + `strict`
  // are passed in by the caller (it resolves + parses the agreement doc); a Move-less
  // `remark` is the untyped overflow hatch (accepted with no checks). Returns
  // { card, event, warnings, attempt }.
  async function act(cardRef, moveName, { bindings = {}, remark = null, role = null, protocol = null, protocolName = null, strict = false, by = 'agent' } = {}) {
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`act: card "${cardRef}" not found`);
    assertLive(card, 'act');
    const stage = card.state;
    const warnings = [];

    // The untyped remark — the overflow buffer; no binding, no checks (the hatch must
    // exist so exceptions don't drain back into ephemeral prose and die there).
    if (!moveName) {
      const text = String(remark ?? '').trim();
      if (!text) throw new Error('act: a Move or a --remark is required — act <card> <Move> [key=value...] | act <card> --remark "<text>"');
      const attempt = attemptFor(events, card.id, null) || 1;
      const event = { type: 'MoveActed', eventId: randomUUID(), cardId: card.id, at: now(), by, stage, attempt, move: null, remark: text, ...causeFromEnv() };
      await log.append(event);
      bus.emit('acted', { card: card.id, remark: text });
      return { card, event, warnings, attempt };
    }

    const def = protocol ? protocolMoveDef(protocol, moveName) : null;
    if (!def) {
      const msg = `unknown move "${moveName}"${protocol ? ' — not in the declared protocol' : ' — no protocol declared on this board'}`;
      if (strict) throw new Error(`act: ${msg}`);
      warnings.push(msg);
    }
    role = role ?? def?.role ?? null;
    if (def && role && role !== def.role) warnings.push(`move "${moveName}" is owned by ${def.role}, acted as ${role}`);

    const attempt = attemptFor(events, card.id, def);
    const enactments = foldEnactments(events, card.id);
    const bound = enactments.get(attempt)?.bindings ?? {};
    const prevBound = attempt > 1 ? (enactments.get(attempt - 1)?.bindings ?? {}) : {};

    // Missing-in WARNINGS — a move fired before its precondition bound is a judgment call
    // the agent owns (it may know better); surface it, never refuse.
    for (const p of def?.in ?? []) {
      const has = def.prevIns.includes(p) ? prevBound[p] !== undefined : bound[p] !== undefined;
      if (!has) warnings.push(`missing in "${p}"${def.prevIns.includes(p) ? ' (previous attempt)' : ''} — not yet bound on this enactment`);
    }

    // The bindings this move lands: its declared `out`s (marker value `true`), overlaid
    // with explicit key=value / body. A provided key outside the move's outs WARNS.
    const outs = def?.out ?? [];
    const landing = {};
    for (const p of outs) landing[p] = true;
    for (const [k, v] of Object.entries(bindings)) {
      if (def && !outs.includes(k)) warnings.push(`param "${k}" is not an out of "${moveName}"`);
      landing[k] = v;
    }
    if (!Object.keys(landing).length) throw new Error(`act: move "${moveName}" binds nothing — declare its outs in the protocol, or pass key=value`);

    // HARD REFUSE double-binding — store integrity, the class of rule append-only +
    // idempotency keys are: a parameter binds once, ever. Ship/Polish/Reject are
    // exclusive BY THIS: all bind `verdict`, so the second to fire is refused here.
    for (const p of Object.keys(landing)) {
      if (bound[p] !== undefined) {
        throw new Error(`act: "${p}" is already bound on attempt ${attempt} (= ${JSON.stringify(bound[p])}) — single-binding: a parameter binds once, ever. Rework is a fresh attempt, not a rebind.`);
      }
    }

    // The opening move records the choice — an opener (no current-attempt in) stamps the
    // governing protocol name onto its event, so the enactment is self-describing: later
    // reads (workspace/lint) resolve the agreement per enactment from the log.
    const stampProtocol = protocolName && protocolMoveIsOpener(def);
    // A remark composes onto the move — the same MoveActed event carries both fields (a move
    // with a note is one utterance). Empty/whitespace remarks are dropped; the move stands.
    const noteText = String(remark ?? '').trim();
    const event = { type: 'MoveActed', eventId: randomUUID(), cardId: card.id, at: now(), by, stage, attempt, move: moveName, ...(role ? { role } : {}), ...(stampProtocol ? { protocol: protocolName } : {}), bindings: landing, ...(noteText ? { remark: noteText } : {}), ...causeFromEnv() };
    await log.append(event);
    bus.emit('acted', { card: card.id, move: moveName, warnings });
    return { card, event, warnings, attempt };
  }

  // --- watch (a standing observation on external state) ----------------------

  // Register a watch on a card: a WatchSet event on the log (the REGISTRATION is the event;
  // per-check state lives off-log in a state file — see watch.js). Idempotent by fold: a
  // re-registration of the same (card, on) appends a fresh WatchSet and the fold takes the
  // latest, so the question is updated, not duplicated. The question is the matcher's stored
  // condition — required (a watch with no question can never be matched).
  async function watchSet(cardRef, on, question, { by = 'agent' } = {}) {
    on = String(on ?? '').trim();
    question = String(question ?? '').trim();
    if (!on) throw new Error('watch: `on` is required — watch <ref> --on <namespace:id>');
    if (!question) throw new Error('watch: a question is required — the matcher needs a condition to test (watch <ref> --on <ns:id> "<question>")');
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`watch: card "${cardRef}" not found`);
    assertLive(card, 'watch');
    const event = { type: 'WatchSet', eventId: randomUUID(), cardId: card.id, at: now(), by, on, question, ...causeFromEnv() };
    await log.append(event);
    bus.emit('watchSet', { card: card.id, on });
    return { card, on, question };
  }

  // Clear a watch: a WatchCleared event the fold applies (drops the (card, on) entry).
  // Idempotent — clearing an absent watch is an honest no-op (removed:false), never a throw.
  async function watchCleared(cardRef, on, { by = 'agent' } = {}) {
    on = String(on ?? '').trim();
    const events = await log.read();
    const card = resolveCard(rebuild(events), cardRef);
    if (!card) throw new Error(`watch: card "${cardRef}" not found`);
    const active = foldWatches(events);
    if (!active.has(watchKey(card.id, on))) return { card, on, removed: false }; // nothing to clear
    const event = { type: 'WatchCleared', eventId: randomUUID(), cardId: card.id, at: now(), by, on, ...causeFromEnv() };
    await log.append(event);
    bus.emit('watchCleared', { card: card.id, on });
    return { card, on, removed: true };
  }

  // The active watches — WatchSet/WatchCleared folded to the current set. Each carries the
  // watching card's id, the referent, the stored question, and when it was set.
  async function watches() {
    return [...foldWatches(await log.read()).values()];
  }

  function rebuild(evts) {
    const cards = new Map();
    for (const e of evts) {
      if (e.type === 'ItemCaptured') {
        cards.set(e.cardId, projectCaptured(e, { derive: deriveSlug }));
      } else if (e.type === 'CardTransitioned') {
        const c = cards.get(e.cardId);
        if (!c) continue;
        c.state = e.to;
        c.updatedAt = e.at;
        if (e.loop) c.iterationCount = (c.iterationCount ?? 0) + 1;
      } else if (e.type === 'CardBound') {
        const c = cards.get(e.cardId);
        if (c) {
          c.binding = { path: e.path, identity: e.identity ?? e.cardId };
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardLinked') {
        const c = cards.get(e.cardId);
        if (c) {
          const refs = { ...(c.payload?.refs ?? {}) };
          const arr = refs[e.rel] ? [...refs[e.rel]] : [];
          if (!arr.includes(e.target)) arr.push(e.target); // idempotent — same edge is a no-op
          refs[e.rel] = arr;
          c.payload = { ...(c.payload ?? {}), refs };
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardUnlinked') {
        const c = cards.get(e.cardId);
        if (c && c.payload?.refs?.[e.rel]) {
          const refs = { ...c.payload.refs };
          const arr = refs[e.rel].filter((t) => t !== e.target);
          if (arr.length) refs[e.rel] = arr;
          else delete refs[e.rel]; // an emptied relation leaves no bare key
          c.payload = { ...c.payload, refs };
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardSlugged') {
        const c = cards.get(e.cardId);
        if (c) {
          c.slug = e.slug;
          if (e.path && c.binding) c.binding = { ...c.binding, path: e.path }; // the doc was renamed to match
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardRetitled') {
        const c = cards.get(e.cardId);
        if (c) {
          c.title = e.title; // latest wins — same shape as CardSlugged
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardScoped') {
        const c = cards.get(e.cardId);
        if (c) {
          const next = e.scope ?? null;
          c.scope = next;
          const payload = { ...(c.payload ?? {}) };
          if (next == null) delete payload.scope;
          else payload.scope = next;
          c.payload = payload;
          if (e.path) {
            c.binding = c.binding
              ? { ...c.binding, path: e.path }
              : { path: e.path, identity: c.id };
          }
          c.updatedAt = e.at;
        }
      } else if (e.type === 'ChecklistItemAdded') {
        const c = cards.get(e.cardId);
        if (c) {
          const lists = { ...(c.checklists ?? {}) };
          const arr = lists[e.list] ? [...lists[e.list]] : [];
          arr[e.index] = { text: e.text, done: false }; // append-only: index is the stable position
          lists[e.list] = arr;
          c.checklists = lists;
          c.updatedAt = e.at;
        }
      } else if (e.type === 'ChecklistItemChecked' || e.type === 'ChecklistItemUnchecked') {
        const c = cards.get(e.cardId);
        const arr = c?.checklists?.[e.list];
        if (arr && arr[e.index]) {
          const done = e.type === 'ChecklistItemChecked';
          const next = [...arr];
          next[e.index] = { ...next[e.index], done };
          c.checklists = { ...c.checklists, [e.list]: next };
          c.updatedAt = e.at;
        }
      } else if (e.type === 'ChecklistItemRetracted') {
        const c = cards.get(e.cardId);
        const arr = c?.checklists?.[e.list];
        if (arr && arr[e.index]) {
          const next = [...arr];
          next[e.index] = { ...next[e.index], retracted: true };
          c.checklists = { ...c.checklists, [e.list]: next };
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardArchived') {
        const c = cards.get(e.cardId);
        if (c) {
          c.archived = e.at; // the freeze timestamp — read-only from here, dropped from active views
          c.disposition = e.disposition;
          c.updatedAt = e.at;
        }
      } else if (e.type === 'CardsMerged') {
        const from = cards.get(e.from);
        const into = cards.get(e.into);
        if (from && into) {
          // The survivor inherits the absorbed card's lineage when it lacks one;
          // the absorbed card folds away. Append-only — both histories stay in the
          // log, the fold just presents one card.
          into.lineage = { parent: into.lineage?.parent ?? from.lineage?.parent ?? null };
          if (e.title != null) into.title = e.title; // a rewritten description, not a mechanical concat
          cards.delete(e.from);
        }
      } else if (!KNOWN_EVENTS.has(e.type)) {
        warnUnknownEvent(e.type); // never throw — the fold must replay what it can
      }
    }
    deriveBlocked(cards);
    return cards;
  }

  // Post-fold pass: derive `blocked` from inbound `blocks` edges. A card is
  // blocked while at least one LIVE blocker — a card that is neither archived nor
  // in a done-role stage — carries a `blocks` edge pointing at it. Derived (never
  // stored) so the ⛔ glyph tracks the declared relation and clears the moment the
  // blocker delivers (reaches done) or is archived. Targets are stored strings
  // (CURIE `type:slug`, bare slug, or id); resolve each against the folded set.
  function deriveBlocked(cards) {
    const doneStages = new Set(stages(manifest).filter((s) => s.role === 'done').map((s) => s.id));
    // The relation keys that mean "blocks": the literal, plus any declared relation
    // whose id is `blocks` (a namespaced vocabulary could redeclare it).
    const blockKeys = new Set(['blocks', ...expandedRelations(manifest).filter((r) => r.id === 'blocks').map((r) => r.id)]);
    const byId = new Map();
    const byCurie = new Map();
    const bySlug = new Map();
    for (const c of cards.values()) {
      byId.set(c.id, c);
      if (c.slug) bySlug.set(c.slug, c);
      if (c.type && c.slug) byCurie.set(`${c.type}:${c.slug}`, c);
    }
    const resolveTarget = (t) => byId.get(t) ?? byCurie.get(t) ?? bySlug.get(t) ?? null;
    for (const blocker of cards.values()) {
      if (blocker.archived) continue; // frozen — no longer holding anything
      if (doneStages.has(blocker.state)) continue; // delivered — the block clears
      const refs = blocker.payload?.refs;
      if (!refs) continue;
      for (const key of blockKeys) {
        for (const t of refs[key] ?? []) {
          const target = resolveTarget(t);
          if (target) target.blocked = true;
        }
      }
    }
  }

  return { manifest, log, boardDir, on: bus.on.bind(bus), capture, transition, commit, bind, link, unlink, checklistWrite, checklistToggle, checklistRetract, reslug, retitle, scope, archive, run, merge, act, graduate, elaborated, procedureInvoked, watchSet, watchCleared, watches, reconcile, sync, joinMember, leaveMember, roster, pool, card, events };
}

// Fold WatchSet/WatchCleared into the active watch set — the same append-only projection as
// the card/roster folds, keyed by (cardId, on). A later WatchSet on the same key updates the
// question (re-registration); a WatchCleared drops it. Separate from the card fold: a watch
// is standing observation ABOUT a card, not card state (a check never appends to the log).
export function foldWatches(evts) {
  const active = new Map();
  for (const e of evts) {
    if (e.type === 'WatchSet') active.set(watchKey(e.cardId, e.on), { cardId: e.cardId, on: e.on, question: e.question, setAt: e.at });
    else if (e.type === 'WatchCleared') active.delete(watchKey(e.cardId, e.on));
  }
  return active;
}

function watchKey(cardId, on) { return `${cardId}\0${on}`; }

// Fold the membership events into a roster: handle -> where the member lives.
// Separate from the card fold (members are not cards) but the same append-only
// projection — so a network's state derives from a log exactly as a board's does.
export function rebuildRoster(evts) {
  const members = new Map();
  for (const e of evts) {
    if (e.type === 'MemberJoined') members.set(e.handle, { handle: e.handle, location: e.location, joinedAt: e.at });
    else if (e.type === 'MemberLeft') members.delete(e.handle);
  }
  return members;
}

// --- context engineering -----------------------------------------------------

// Assemble what an evaluator needs to judge an event: the event, the card and
// its history, the bound doc's content, the relevant policy prose, and a
// board-state snapshot. The kernel knows the board, so it knows what is
// relevant — that is the engineering. The doc read matters most: the evaluator
// is a one-shot command with no tools, and the evidence a DoR/DoD gate judges
// (the outcome, the acceptance notes) lives in the bound file — a card JSON
// with only binding.path made gates advise "no outcome recorded" against
// freshly elaborated docs (elaborate on a bound card is a pure file write; no
// event betrays it).
const DOC_CONTEXT_CAP = 6000; // chars — a gate reads evidence, not a novel

async function buildContext(manifest, event, hook, cards, events, boardDir) {
  const card = event.cardId ? cards.get(event.cardId) ?? null : null;
  let doc = null;
  if (card?.binding?.path && boardDir) {
    try {
      const raw = await readFile(pathResolve(boardDir, card.binding.path), 'utf8');
      doc = { path: card.binding.path, content: raw.slice(0, DOC_CONTEXT_CAP), truncated: raw.length > DOC_CONTEXT_CAP };
    } catch {
      /* unreadable/missing doc — the binding alone still shows in the card */
    }
  }
  return {
    board: { id: manifest.board?.id ?? null, purpose: manifest.board?.description ?? null },
    event,
    card,
    doc,
    history: card ? events.filter((e) => e.cardId === card.id).map(briefEvent) : [],
    policy: hook.policy ?? null, // a declared hook may carry its own policy; the run-exit judge carries its exit criterion
    state: stageCounts(manifest, cards),
    ask: hook.evaluate ?? hook.prompt ?? 'Evaluate this event and respond.',
    expects:
      (hook.phase ?? 'after') === 'before'
        ? 'Reply with ONLY a JSON object and no other text: {"approve": boolean, "reason": "<short>"}'
        : hook.expects ?? 'Take the appropriate action; you may call kanbento verbs via $KANBENTO_CLI.',
  };
}

function stageCounts(manifest, cards) {
  const counts = {};
  for (const s of manifest.stages ?? []) counts[s.id] = 0;
  for (const c of cards.values()) counts[c.state] = (counts[c.state] ?? 0) + 1;
  return counts;
}

function briefEvent(e) {
  if (e.type === 'CardTransitioned') return `${e.at}  ${e.from} -> ${e.to} (${e.via}) by ${e.by}`;
  if (e.type === 'ItemCaptured') return `${e.at}  captured by ${e.by}`;
  if (e.type === 'CardRetitled') return `${e.at}  retitled to "${e.title}" by ${e.by}`;
  if (e.type === 'HookEvaluated')
    return `${e.at}  hook ${e.hook}: ${e.phase === 'before' ? (e.approve ? 'approved' : 'VETOED') + (e.reason ? ' — ' + e.reason : '') : 'reacted'}`;
  return `${e.at}  ${e.type}`;
}

// The most recent veto on a card — the run engine reads it to remediate (feed the
// rejection into the next brief) and to report why a stuck run escalated.
function lastVeto(events, cardId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'HookEvaluated' && e.cardId === cardId && e.approve === false) return e;
  }
  return null;
}

function renderPrompt(c) {
  return [
    `You are an evaluator for the "${c.board.id}" kanban board.`,
    c.board.purpose ? `Board purpose: ${c.board.purpose}` : '',
    c.policy ? `\nRelevant policy:\n${c.policy}` : '',
    `\nEvent:\n${JSON.stringify(c.event, null, 2)}`,
    c.card ? `\nCard under evaluation:\n${JSON.stringify(c.card, null, 2)}` : '',
    c.doc ? `\nBound doc (${c.doc.path}${c.doc.truncated ? ', truncated' : ''}):\n${c.doc.content}` : '',
    c.history?.length ? `\nCard history:\n${c.history.map((h) => '- ' + h).join('\n')}` : '',
    `\nBoard state (cards per stage): ${JSON.stringify(c.state)}`,
    `\nTask: ${c.ask}`,
    `\n${c.expects}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Extract a {"approve": ...} verdict from evaluator stdout; fall back to exit code.
function parseVerdict(stdout, exitOk) {
  const m = stdout.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (typeof v.approve === 'boolean') return v;
    } catch {
      /* not JSON — fall through */
    }
  }
  return { approve: exitOk, reason: stdout || (exitOk ? 'approved' : 'evaluator failed') };
}

// --- helpers -----------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function sourceKind(source) {
  return String(source).split(':')[0]; // "agent:flow-finder" -> "agent"
}

// When a verb runs inside a hook-spawned process, the environment carries the
// causation depth. Stamping it on the new event is what bounds the cascade.
function causeFromEnv() {
  const depth = process.env.KANBENTO_HOOK_DEPTH;
  if (!depth) return {};
  return {
    cause: {
      depth: Number(depth),
      hook: process.env.KANBENTO_HOOK_ID,
      event: process.env.KANBENTO_CAUSE_EVENT || undefined,
    },
  };
}

// A card's title is a one-line handle; derive it from the body's first non-empty
// line when none was given (a rich submission carries its summary up top, and a
// leading markdown heading marker is dropped).
export function summarize(body) {
  const line = String(body ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^#+\s*/, '') || 'untitled';
}

// What to PRINT for a card. Computed, never stored: the authored title when there
// is one, else the body's first line. Deliberately a function and not a field — a
// derived value copied onto the object has to be re-synced at every fold site, and
// a copy that can drift is the defect this doctrine exists to remove.
export function summary(card) {
  return card?.title ?? summarize(card?.body);
}

function projectCaptured(event, { derive = true } = {}) {
  // TITLE (note:authored-title-doctrine): authored text or null. It records the
  // FACT that somebody named this card, so "was it named?" is a field read rather
  // than an inference. Nothing synthetic is ever stored here — no frontmatter copy,
  // nothing in the search index. What you PRINT is summary(card), computed.
  const title = event.title ?? null;
  return {
    id: event.cardId,
    title,
    body: event.body, // the full submission — may be multi-line markdown, beyond the title
    slug: event.slug ?? (derive ? titleSlug(title ?? summarize(event.body)) : undefined), // human handle; heuristic unless slugify is off (a slug needs a string, named or not)
    type: event.cardType ?? null, // set at capture (--type), else classified later
    // The natural key (body-less): source is the intake scope, key the identity
    // within it — the compound an externalKey type constrains to be unique and
    // resolves to `id` (kanbento_id — THE primary key, always). Read straight off
    // the capture event, never materialized into frontmatter. key is null when
    // the capture carried no --key.
    source: event.by ?? null,
    key: event.idempotencyKey ?? null,
    state: event.landing,
    lane: event.lane ?? {},
    payload: event.payload ?? {},
    // The product-scope axis (at most one per card; null = the unscoped queue).
    // Lifted to the top level so every surface prints it without digging into the
    // payload — a scope that lives only in the JSON is a scope that gets skipped.
    scope: event.payload?.scope ?? event.lane?.scope ?? null,
    binding: event.binding ?? null,
    lineage: { parent: event.parent ?? null },
    iterationCount: 0,
    createdAt: event.at,
    updatedAt: event.at,
  };
}

// Resolve a <ref> to a card. Order: exact id -> composite `slug@id` -> exact
// slug/CURIE -> prefix (id or slug). For a `slug@id` handle the part after @ is
// the key and the slug is advisory — so a stale or wrong slug in front of the
// right id still resolves (the docker/git `name@hash` property). A typed card
// also answers to its CURIE (type:slug). Ambiguity errors, like a fuzzy prefix.
// A mutating verb refuses a frozen (archived) card — archive is a terminal offload,
// so the card is read-only from there. Reads still resolve it; only writes are barred.
function assertLive(card, verb) {
  if (card?.archived) throw new Error(`${verb}: card is archived (${card.disposition ?? 'frozen'}) — read-only`);
}

function resolveCard(cards, ref) {
  if (cards.has(ref)) return cards.get(ref); // exact id (uuid) — the fast path
  const all = [...cards.values()];
  const at = ref.lastIndexOf('@'); // composite handle: key on the id after @, slug is sugar
  const idPart = at >= 0 ? ref.slice(at + 1) : '';
  if (idPart) {
    const m = all.filter((c) => c.id.startsWith(idPart));
    if (m.length > 1) throw new Error(`ambiguous card ref "${ref}" (${m.length} matches)`);
    if (m.length === 1) return m[0];
  }
  const exact = all.filter((c) => c.slug === ref || (c.type && `${c.type}:${c.slug}` === ref));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`ambiguous card ref "${ref}" (${exact.length} slug matches)`);
  const matches = all.filter((c) => c.id.startsWith(ref) || (c.slug && c.slug.startsWith(ref)));
  if (matches.length > 1) throw new Error(`ambiguous card ref "${ref}" (${matches.length} matches)`);
  return matches[0] ?? null;
}

// removed: the self-asserted entry gate (evalGate/satisfied, --assert). A stage's
// entry/exit criteria (DoR/DoD) are surfaced as an injected gate checklist on a forward
// transition (seedStageGate) that the coordinator-dispatched specialist self-evaluates —
// no independent evaluator fires. WIP capacity is enforced inline in transition (above).
