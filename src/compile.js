import { stages as manifestStages, wipEnforcement } from './manifest.js';
import { expandedRelations } from './refs.js';
import { ROLE_SET } from './protocol.js';

// Compile a manifest into a normalized "board program" — the canonical, fully
// resolved structure. It is the artifact you persist and diff for reconciliation
// (docs/evolution.md): interpret to run, compile to diff. A raw codemod does not
// announce its own diff, so we diff compiled-old vs compiled-new to compute the
// changeset — the way migration tools detect drift and git diffs trees.

export function compile(manifest) {
  for (const s of manifestStages(manifest)) {
    const role = s.role ?? 'active';
    if (!ROLE_SET.has(role)) {
      throw new Error(`compile: unknown stage role "${role}" on stage "${s.id}" — valid: ${[...ROLE_SET].join(', ')}`);
    }
  }
  const stages = manifestStages(manifest).map((s, i) => ({
    id: s.id,
    role: s.role ?? 'active',
    order: i,
    wip: s.wip ?? null,
    gate: Array.isArray(s.entry) || Array.isArray(s.exit) || s.agreement
      ? { entry: Array.isArray(s.entry) ? s.entry.length : 0, exit: Array.isArray(s.exit) ? s.exit.length : 0, agreement: Boolean(s.agreement) }
      : null,
  }));
  const flows = (manifest.flows ?? []).map((f) => ({ from: f.from, to: f.to, kind: f.kind ?? 'forward' }));
  // Types are structural: the rich types[] form (ids; flow + record alike), else
  // the legacy cardSchema.types name list — so a manifest type edit shows up in
  // diff and reconcile re-baselines it (the EVOLVING.md transaction).
  const types = Array.isArray(manifest.types)
    ? manifest.types.map((t) => t.id).filter(Boolean)
    : Array.isArray(manifest.cardSchema?.types)
      ? [...manifest.cardSchema.types]
      : manifest.cardSchema?.types ?? 'open';
  return {
    boardId: manifest.board?.id ?? null,
    revision: manifest.board?.revision ?? 0,
    wipEnforcement: wipEnforcement(manifest),
    stages,
    flows,
    types,
    lanes: (manifest.lanes ?? []).map((l) => l.axis).filter(Boolean),
    classes: (manifest.classesOfService ?? []).map((c) => c.id).filter(Boolean),
    // declared relations are structural (they change what lint checks and strict
    // rejects) — flat and vocabulary-expanded dotted ids alike enter the baseline
    relations: expandedRelations(manifest).map((r) => r.id),
  };
}

// Diff two compiled programs into a structured changeset. Rename detection is
// heuristic (git-style): a removed and an added stage sharing a role are paired
// as a rename rather than a remove + add.
export function diffCompiled(oldP, newP) {
  const oldStages = new Map(oldP.stages.map((s) => [s.id, s]));
  const newStages = new Map(newP.stages.map((s) => [s.id, s]));

  const removed = [...oldStages.keys()].filter((id) => !newStages.has(id));
  const added = [...newStages.keys()].filter((id) => !oldStages.has(id));

  const renamed = [];
  for (const rid of [...removed]) {
    const role = oldStages.get(rid).role;
    const match = added.find((aid) => newStages.get(aid).role === role);
    if (match) {
      renamed.push({ from: rid, to: match });
      removed.splice(removed.indexOf(rid), 1);
      added.splice(added.indexOf(match), 1);
    }
  }

  const changed = [];
  for (const [id, ns] of newStages) {
    const os = oldStages.get(id);
    if (!os) continue;
    const delta = { id };
    if (os.wip !== ns.wip) delta.wip = [os.wip, ns.wip];
    if (os.role !== ns.role) delta.role = [os.role, ns.role];
    if (gateSig(os.gate) !== gateSig(ns.gate)) delta.gate = gateChange(os.gate, ns.gate);
    if (Object.keys(delta).length > 1) changed.push(delta);
  }

  return {
    stages: { added, removed, renamed, changed },
    types: setDiff(oldP.types, newP.types),
    flows: flowDiff(oldP.flows, newP.flows),
    lanes: setDiff(oldP.lanes, newP.lanes),
    classes: setDiff(oldP.classes, newP.classes),
    relations: setDiff(oldP.relations ?? [], newP.relations ?? []), // ?? []: baselines predating this facet
  };
}

export function isEmptyChangeset(cs) {
  const s = cs.stages;
  return (
    !s.added.length &&
    !s.removed.length &&
    !s.renamed.length &&
    !s.changed.length &&
    !cs.types.added.length &&
    !cs.types.removed.length &&
    !cs.flows.added.length &&
    !cs.flows.removed.length &&
    !cs.lanes.added.length &&
    !cs.lanes.removed.length &&
    !cs.classes.added.length &&
    !cs.classes.removed.length &&
    !cs.relations.added.length &&
    !cs.relations.removed.length
  );
}

// The default reconciliation moves (docs/evolution.md): a card in a renamed
// stage follows the rename; a card in a removed stage re-enters at the first
// stage. Pure — the caller decides whether to preview or apply. (Split → first
// sub-stage is deferred; splits are not yet detected.)
export function reconcileMoves(changeset, cards, newProgram) {
  const firstStage = newProgram.stages[0]?.id ?? null;
  const renamed = new Map(changeset.stages.renamed.map((r) => [r.from, r.to]));
  const removed = new Set(changeset.stages.removed);
  const moves = [];
  for (const c of cards) {
    if (renamed.has(c.state)) {
      moves.push({ card: c.id, title: c.title, from: c.state, to: renamed.get(c.state), reason: 'rename' });
    } else if (removed.has(c.state)) {
      moves.push({ card: c.id, title: c.title, from: c.state, to: firstStage, reason: 'removed → first stage' });
    }
  }
  return moves;
}

function gateSig(g) {
  return g ? `${g.entry}/${g.exit}/${g.agreement}` : 'none';
}

function gateChange(o, n) {
  if (!o && n) return 'added';
  if (o && !n) return 'removed';
  return 'changed';
}

function setDiff(oldArr, newArr) {
  const o = new Set(Array.isArray(oldArr) ? oldArr : [oldArr]);
  const n = new Set(Array.isArray(newArr) ? newArr : [newArr]);
  return {
    added: [...n].filter((x) => !o.has(x)),
    removed: [...o].filter((x) => !n.has(x)),
  };
}

function flowDiff(oldF, newF) {
  const key = (f) => `${f.from}->${f.to}:${f.kind}`;
  const o = new Map(oldF.map((f) => [key(f), f]));
  const n = new Map(newF.map((f) => [key(f), f]));
  return {
    added: [...n.entries()].filter(([k]) => !o.has(k)).map(([, f]) => f),
    removed: [...o.entries()].filter(([k]) => !n.has(k)).map(([, f]) => f),
  };
}
