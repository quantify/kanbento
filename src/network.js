import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { manifestPathIn, hasManifest } from './boards.js';
import { loadManifest, boardNetworks } from './manifest.js';

// Network discovery — the declarative, docker-compose model. Membership lives in
// each member's manifest (`network:`), so a network's roster isn't stored; it's
// DERIVED by scanning a tree for boards and grouping them by the network they
// name. The scan is the resolver; `compile`/`view` re-derive, always fresh.

const SKIP = new Set(['node_modules', '.git', '.kanbento']);

// Walk a tree for board directories (a dir holding a manifest), loading each
// manifest. Skips vendored / vcs / data dirs so a monorepo scan stays cheap.
export async function discoverBoards(root) {
  const out = [];
  const walk = async (dir) => {
    if (hasManifest(dir)) out.push({ dir, manifest: await loadManifest(manifestPathIn(dir)) });
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) await walk(join(dir, e.name));
    }
  };
  await walk(root);
  return out;
}

// The roster of one network: the discovered boards that declare membership in it,
// each as { handle, location }. Pure over the discovered boards. The board that
// IS the network (its id == name) is the anchor, not a member — it carries the
// name, it doesn't join itself.
export function deriveRoster(boards, name) {
  const roster = [];
  for (const b of boards) {
    for (const m of boardNetworks(b.manifest)) {
      if (m.network === name) roster.push({ handle: m.handle, location: b.dir });
    }
  }
  return roster;
}

// Every network declared across the discovered boards: name -> member count, and
// the anchor dir if some board is named after it. Pure. Powers `network list`.
export function discoverNetworks(boards) {
  const nets = new Map();
  const get = (name) => nets.get(name) ?? nets.set(name, { name, members: 0, anchor: null }).get(name);
  for (const b of boards) for (const m of boardNetworks(b.manifest)) get(m.network).members++;
  for (const b of boards) {
    const id = b.manifest.board?.id;
    if (id && nets.has(id)) nets.get(id).anchor = b.dir; // a board named like a network anchors it
  }
  return [...nets.values()];
}

// Find the anchor board for a network (the board whose id is the network name).
export function anchorOf(boards, name) {
  return boards.find((b) => b.manifest.board?.id === name) ?? null;
}
