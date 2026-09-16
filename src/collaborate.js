// The COLLABORATE protocol facet — BSPL in move form over the card-as-blackboard
// (note:collaborate-protocol-draft). A protocol declares roles + moves whose
// parameters are adorned `in` (already bound) / `out` (produced, binds once) /
// key (identifies the enactment); ordering is DERIVED from information, never
// declared. The event log is the binding history: each `act` appends one binding
// event, `workspace` projects the moves + bindings back.
//
// This module is PURE: it parses the agreement doc into the protocol, folds the
// log into enactments, and renders the role/workspace projections + the advisory
// lint. The store integrity (single-binding) is enforced in the kernel's `act`;
// everything else here is read-side (surface + advise, never block).
//
// NOTE the name clash: protocol.js is the manifest-grammar renderer (the closed
// core). This is the collaboration protocol — a different "protocol". Kept apart.

// --- manifest shape B --------------------------------------------------------

// The closed-core patterns the engine knows by name. OPEN + ADVISORY exactly like
// relations/relationVocabularies: an undeclared pattern is allowed (progressive),
// and only `strict` enforcement rejects one outside this set.
export const CORE_PATTERNS = ['orchestration'];

// The board's declared protocol REPERTOIRE: `protocol: { <pattern>: { agreement }, … }`
// — a MAP keyed by pattern name (the games this board knows how to play), open keys
// exactly like `relationVocabularies`. Returns a normalized map { pattern: { pattern,
// agreement } }, or {} when absent/malformed. The CHOICE of which game to play moves to
// invocation time (act --protocol / sole-entry default / the opening move's stamp).
export function boardRepertoire(manifest) {
  const p = manifest?.protocol;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const out = {};
  for (const [pattern, entry] of Object.entries(p)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out[pattern] = { pattern, agreement: entry.agreement ?? null };
  }
  return out;
}

// One repertoire entry by pattern name, or null.
export function repertoireEntry(manifest, pattern) {
  return boardRepertoire(manifest)[pattern] ?? null;
}

// Is the pattern vocabulary closed? Advisory by default (any pattern works);
// `policies.protocol: strict` closes it to CORE_PATTERNS — the same advisory→strict
// dial relations use (refs.relationsStrict).
export function protocolStrict(manifest) {
  return (manifest?.policies?.protocol ?? 'advisory') === 'strict';
}

// Validate the declared repertoire against the core. Returns an array of error strings
// (one per key outside the core) under strict, else [] (advisory: undeclared patterns
// are open). Mirrors refs.checkRelationStrict — advisory→strict, open by default.
export function checkRepertoireStrict(manifest) {
  if (!protocolStrict(manifest)) return [];
  const errs = [];
  for (const pattern of Object.keys(boardRepertoire(manifest))) {
    if (!CORE_PATTERNS.includes(pattern)) {
      errs.push(`protocol pattern "${pattern}" is not a core pattern (strict): ${CORE_PATTERNS.join(', ')}`);
    }
  }
  return errs;
}

// The pattern stamped on a card's opening move — the enactment records which game it
// plays, so `workspace`/`lint` resolve the governing agreement PER ENACTMENT from the
// log (self-describing enactments; heterogeneous protocols coexist on one board). The
// first stamp on the card wins (its opener); null when none was recorded.
export function stampedProtocol(events, cardId) {
  for (const e of events ?? []) {
    if (e.type === 'MoveActed' && e.cardId === cardId && e.protocol) return e.protocol;
  }
  return null;
}

// --- agreement doc parsing (BSPL move form) ----------------------------------

// The move atom: `Role: MoveName [in p, out q, ...]`. An `@prev` suffix on an `in`
// marks it as bound in the PREVIOUS attempt (the rework precondition) — a move that
// carries one is an attempt-opener (Redispatch), so it keys a fresh enactment.
const MOVE_RE = /^([A-Za-z][\w-]*)\s*:\s*([A-Za-z][\w-]*)\s*\[([^\]]*)\]/;
const HEADER_RE = /^(roles|key|parameter|private)\b(.*)$/i;
const ADORN_RE = /\b(in|out|nil)\s+([A-Za-z][\w-]*)(@[A-Za-z][\w-]*)?/g;

// Pull the fenced code blocks out of the agreement markdown — the protocol lives in
// ``` fences (global protocol + rework). Prose outside them is ignored.
function fencedBlocks(md) {
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(md ?? '')))) out.push(m[1]);
  return out;
}

// Strip a trailing `// comment` and the `── … ──` separator lines the draft uses.
function stripComment(line) {
  const i = line.indexOf('//');
  return (i >= 0 ? line.slice(0, i) : line).replace(/─+/g, '').trim();
}

// parseProtocol(md) -> { name, roles[], key[], params{name:adorn}, moves[] }.
// Each move: { role, move, in:[names], out:[names], prevIns:[names], opensAttempt }.
// Robust to comments, separators, and alignment whitespace; a doc with no fenced
// block (or an empty one) yields an empty protocol (moves: []), never throws.
export function parseProtocol(md) {
  const proto = { name: null, roles: [], key: [], params: {}, moves: [] };
  const source = fencedBlocks(md).join('\n') || String(md ?? '');
  for (const raw of source.split('\n')) {
    const line = stripComment(raw);
    if (!line) continue;
    const mv = line.match(MOVE_RE);
    if (mv) {
      const [, role, move, adorns] = mv;
      const ins = [];
      const outs = [];
      const prevIns = [];
      let a;
      ADORN_RE.lastIndex = 0;
      while ((a = ADORN_RE.exec(adorns))) {
        const [, dir, name, at] = a;
        if (dir === 'in') { ins.push(name); if (at) prevIns.push(name); }
        else if (dir === 'out') outs.push(name);
      }
      proto.moves.push({ role, move, in: ins, out: outs, prevIns, opensAttempt: prevIns.length > 0 });
      continue;
    }
    const hd = line.match(HEADER_RE);
    if (hd) {
      const key = hd[1].toLowerCase();
      const rest = hd[2].trim();
      if (key === 'parameter') {
        const [name, adorn] = rest.split(/\s+/);
        if (name) proto.params[name] = adorn ?? 'out';
      } else {
        const names = rest.split(',').map((s) => s.trim()).filter(Boolean);
        if (key === 'roles') proto.roles = names;
        else if (key === 'key') proto.key = names;
        else if (key === 'private') for (const n of names) proto.params[n] ??= 'private';
      }
      continue;
    }
    // A bare capitalized word before the moves is the protocol name (`Collaborate`).
    if (!proto.name && /^[A-Z][\w-]*$/.test(line)) proto.name = line;
  }
  return proto;
}

// The moves a role owns — its projection filter (a role's view = its moves).
export function movesForRole(proto, role) {
  return (proto?.moves ?? []).filter((m) => m.role === role);
}

// The definition of one move by name, or null.
export function moveDef(proto, move) {
  return (proto?.moves ?? []).find((m) => m.move === move) ?? null;
}

// Is a move an OPENER — enabled at t=0 of its attempt? A move with no current-attempt
// `in` (its only ins, if any, reference the previous attempt via @prev). Dispatch (no
// ins) and Redispatch (in defect@prev) both open; Deliver (in claim) does not. Openers
// carry the protocol stamp so each attempt is self-describing.
export function isOpener(def) {
  if (!def) return false;
  return (def.in ?? []).every((p) => (def.prevIns ?? []).includes(p));
}

// The self-starting (driving) role — DERIVED from the grammar, never hardcoded. The
// bootstrap principle: the driving role cannot be assigned (assignment presupposes a
// driver — the regress); it is the role whose opening move has NO `in` dependencies at
// all (protocol-param or @prev), the only move enabled before anything is bound. Nobody
// else could have started. Returns { role, move } or null (no such move).
export function selfStarter(proto) {
  const opener = (proto?.moves ?? []).find((m) => (m.in ?? []).length === 0);
  return opener ? { role: opener.role, move: opener.move } : null;
}

// The driving role name, or null — sugar over selfStarter.
export function drivingRole(proto) {
  return selfStarter(proto)?.role ?? null;
}

// --- enactment fold (the read-model over the log) ----------------------------

const enactKey = (attempt) => attempt;

// A STABLE identity string for the acting agent — the separation-of-duties key.
// A persisted event stamps `principal` as an OBJECT ({ email, name?, source } — see
// kernel's identify seam / boards.gitIdentity), so comparing the raw value would pit
// distinct object references against each other (never equal). Collapse it to its
// join key (email, then name), falling back to the `by` role-source; string
// principals and absent ones pass through.
export function principalKey(principal, by = null) {
  if (principal && typeof principal === 'object') return principal.email ?? principal.name ?? principal.source ?? by ?? null;
  return principal ?? by ?? null;
}

// Fold the MoveActed events for one card into its enactments, keyed (card, attempt) —
// the map key is the attempt number. The event's `stage` is PROVENANCE (where the move
// was played), never enactment identity: an attempt spans stages (live evidence: the
// coordinator naturally plays Dispatch at ready and the Producer Delivers at
// in_progress — one collaboration, one attempt). Each enactment: { attempt, moves[],
// remarks[], bindings{param:value}, bindingEvents{param:[{by,at}]}, agentByRole }.
export function foldEnactments(events, cardId) {
  const map = new Map();
  const ensure = (attempt) => {
    const k = enactKey(attempt);
    let en = map.get(k);
    if (!en) {
      en = { attempt, moves: [], remarks: [], bindings: {}, bindingEvents: {}, agentByRole: {} };
      map.set(k, en);
    }
    return en;
  };
  for (const e of events) {
    if (e.type !== 'MoveActed' || e.cardId !== cardId) continue;
    const en = ensure(e.attempt);
    const agent = principalKey(e.principal, e.by);
    if (e.move) {
      // A remark composed onto a move rides with it (rendered inline on the move line, not
      // as an orphan remark); a standalone remark (no move) lands in remarks[].
      en.moves.push({ role: e.role ?? null, move: e.move, stage: e.stage ?? null, at: e.at, by: e.by, agent, remark: e.remark ?? null });
      if (e.role && agent) (en.agentByRole[e.role] ??= new Set()).add(agent);
      for (const [k, v] of Object.entries(e.bindings ?? {})) {
        en.bindings[k] = v;
        (en.bindingEvents[k] ??= []).push({ by: e.by, agent, at: e.at, eventId: e.eventId });
      }
    } else if (e.remark != null) {
      en.remarks.push({ text: e.remark, at: e.at, by: e.by });
    }
  }
  return map;
}

// The highest attempt recorded for a card, or 0 when none.
export function maxAttempt(events, cardId) {
  let max = 0;
  for (const e of events) {
    if (e.type === 'MoveActed' && e.cardId === cardId && e.attempt > max) max = e.attempt;
  }
  return max;
}

// Which attempt a move lands on: an opener (a move with an `@prev` in) opens the next
// attempt; any other move joins the currently-open one (default 1 when none yet).
export function attemptFor(events, cardId, def) {
  const max = maxAttempt(events, cardId);
  if (def?.opensAttempt) return max + 1;
  return max || 1;
}

// The current enactment for a card — its highest attempt, or null when none.
export function currentEnactment(events, cardId) {
  const map = foldEnactments(events, cardId);
  let best = null;
  for (const en of map.values()) {
    if (!best || en.attempt > best.attempt) best = en;
  }
  return best;
}

// The moves enabled RIGHT NOW on an enactment: every `in` bound (this enactment, or
// the previous attempt for an `@prev` in) and every `out` still free. This is the
// causal enablement — a role acts the moment the information it needs exists.
export function enabledMoves(proto, enactment, prevBindings = {}) {
  const bound = enactment?.bindings ?? {};
  return (proto?.moves ?? []).filter((m) => {
    const insOk = m.in.every((p) => (m.prevIns.includes(p) ? prevBindings[p] !== undefined : bound[p] !== undefined));
    const outsFree = m.out.every((p) => bound[p] === undefined);
    return insOk && outsFree;
  });
}

// --- projections (the briefing embeds) ---------------------------------------

const adornStr = (m) => [...m.in.map((p) => `in ${p}${m.prevIns.includes(p) ? '@prev' : ''}`), ...m.out.map((p) => `out ${p}`)].join(', ');

// The current-attempt ins a move fires on (its @prev ins reference the previous attempt).
const firesOn = (m) => (m.in ?? []).filter((p) => !(m.prevIns ?? []).includes(p));

// The exact `act` command shape for a move — the outs it lands, ready to paste. A move
// with a single out shows the `-F` body form too (large bindings — a diff/review/defect
// body — travel by reference); a marker-only out just names itself.
function actShape(m) {
  const outs = m.out ?? [];
  const args = outs.map((p) => `${p}=<${p}>`).join(' ');
  let cmd = `kanbento act <card> ${m.move}${args ? ' ' + args : ''}`;
  if (outs.length === 1) cmd += `   (or -F <file> for a body binding)`;
  return cmd;
}

// A role's projection — a DISPATCH-READY briefing derived entirely from the parsed
// agreement doc (single source, never hand-written). For the role it prints: whether it
// DRIVES the flow (the derived self-starter), each move it owns with its firing
// condition + exact `act` shape + what it records, and what it NEVER does — the moves
// owned by other roles and (for a non-driving role) advancing the card. Authorization =
// projection: a role may do exactly what its moves say, no more.
export function renderRoleProjection(proto, role) {
  const moves = movesForRole(proto, role);
  const driver = drivingRole(proto);
  const drives = role === driver;
  const out = [`Role ${role} — the ${role} projection (dispatch briefing)`];
  out.push(drives
    ? `  drives the flow: yes — ${role} is the self-starting role (its opening move has no preconditions); it advances the card (transition/commit — a flow act, outside these moves)`
    : `  drives the flow: no — the driving role is ${driver ?? '(none derived)'}; ${role} never advances the card (transition/commit)`);

  out.push('');
  if (!moves.length) {
    out.push('  moves you own: (none — this role is not in the protocol)');
  } else {
    out.push('  moves you own (play each when its ins are bound):');
    for (const m of moves) {
      out.push(`    ${m.move} [${adornStr(m)}]`);
      const fires = firesOn(m);
      out.push(`      fires when: ${fires.length ? fires.join(', ') + ' bound' : 'immediately — no preconditions (an opener)'}`);
      out.push(`      run:        ${actShape(m)}`);
      out.push(`      records:    ${(m.out ?? []).join(', ') || '(nothing)'}`);
    }
  }

  // What it never does — the moves owned by OTHER roles (authorization = projection).
  const others = (proto?.moves ?? []).filter((m) => m.role !== role);
  if (others.length) {
    out.push('');
    out.push('  you never:');
    const byOwner = new Map();
    for (const m of others) (byOwner.get(m.role) ?? byOwner.set(m.role, []).get(m.role)).push(m.move);
    for (const [owner, ms] of byOwner) out.push(`    - play ${ms.join(', ')} (${owner}'s move${ms.length > 1 ? 's' : ''})`);
    if (!drives) out.push(`    - advance the card (transition/commit) — only the driving role (${driver ?? 'n/a'}) does`);
  }
  return out.join('\n');
}

// The workspace read-model — the enactment's whole working context for a card:
// the current key (card, attempt), moves played, current bindings, enabled
// moves, remarks, and the worktree path (when one exists). A projection over the log,
// same pattern as BOARD.md. `worktreePath` is injected by the caller (fs concern).
export function renderWorkspace({ proto, events, card, worktreePath = null, role = null, pattern = null } = {}) {
  const en = currentEnactment(events, card.id);
  const attempt = en?.attempt ?? attemptFor(events, card.id, null);
  const prev = en && en.attempt > 1 ? (foldEnactments(events, card.id).get(en.attempt - 1)?.bindings ?? {}) : {};
  const out = [];
  const h = card.slug ? `${card.slug}@${card.id.slice(0, 8)}` : card.id.slice(0, 8);
  out.push(`workspace ${h} — enactment (card ${card.id.slice(0, 8)}, attempt ${attempt}) · stage ${card.state}`);
  if (proto?.name || proto?.moves?.length) {
    const driver = drivingRole(proto);
    out.push(`protocol: ${pattern ? `${pattern} · ` : ''}${proto.name ?? '(unnamed)'} · roles ${proto.roles.join('/')}${driver ? ` · driver ${driver}` : ''}`);
  }

  if (role) {
    out.push('');
    out.push(renderRoleProjection(proto, role));
  }

  out.push('');
  out.push('moves played:');
  if (!en || !en.moves.length) out.push('  (none yet)');
  else for (const m of en.moves) out.push(`  ${m.role ?? '?'}: ${m.move}${m.stage ? `  @${m.stage}` : ''}  ·  ${m.at}${m.by ? `  by ${m.by}` : ''}${m.remark ? `  — “${m.remark}”` : ''}`);

  out.push('');
  out.push('bindings:');
  const keys = Object.keys(en?.bindings ?? {});
  if (!keys.length) out.push('  (none)');
  else for (const k of keys) out.push(`  ${k} = ${renderValue(en.bindings[k])}`);

  out.push('');
  const enabled = en ? enabledMoves(proto, en, prev) : enabledMoves(proto, { bindings: {} }, prev);
  const filtered = role ? enabled.filter((m) => m.role === role) : enabled;
  out.push(`enabled moves${role ? ` (${role})` : ''}:`);
  if (!filtered.length) out.push('  (none — no move has its ins bound and its outs free)');
  else for (const m of filtered) out.push(`  ${m.role}: ${m.move} [${adornStr(m)}]`);

  if (en?.remarks?.length) {
    out.push('');
    out.push('remarks:');
    for (const r of en.remarks) out.push(`  ${r.at}${r.by ? ` ${r.by}` : ''}: ${r.text}`);
  }

  out.push('');
  out.push(`worktree: ${worktreePath ?? '(none — open one with: kanbento worktree open ' + h + ')'}`);
  return out.join('\n');
}

function renderValue(v) {
  if (v === true) return '✓';
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

// --- advisory lint over the enactment log ------------------------------------

// Protocol conformance checks over the log — advisory (report, never block):
//   ownership       — a move played by a role that does not own it
//   double-binding  — a param bound by more than one event in one enactment
//   separation      — Producer and Reviewer resolved to the same agent on one enactment
// Pure over the already-read events + parsed protocol. Empty when no protocol.
export function lintProtocolEnactments({ events = [], proto = null } = {}) {
  const findings = [];
  if (!proto || !proto.moves?.length) return findings;
  const ownerOf = new Map(proto.moves.map((m) => [m.move, m.role]));

  // ownership — one pass over the raw events (the role each move was played AS).
  for (const e of events) {
    if (e.type !== 'MoveActed' || !e.move) continue;
    const owner = ownerOf.get(e.move);
    if (owner && e.role && e.role !== owner) {
      findings.push({ kind: 'protocol', ref: e.cardId, message: `move "${e.move}" played as ${e.role} but is owned by ${owner}` });
    }
  }

  // per-enactment checks — group events by card, then fold.
  const cardIds = [...new Set(events.filter((e) => e.type === 'MoveActed').map((e) => e.cardId))];
  for (const cardId of cardIds) {
    const map = foldEnactments(events, cardId);
    for (const en of map.values()) {
      // double-binding: a param with more than one binding event in the enactment.
      for (const [param, evs] of Object.entries(en.bindingEvents)) {
        if (evs.length > 1) findings.push({ kind: 'protocol', ref: cardId, message: `param "${param}" double-bound (${evs.length}×) on attempt ${en.attempt}` });
      }
      // separation of duties: same agent holds Producer and Reviewer.
      const producers = en.agentByRole.Producer;
      const reviewers = en.agentByRole.Reviewer;
      if (producers && reviewers) {
        const both = [...producers].filter((a) => reviewers.has(a));
        for (const a of both) findings.push({ kind: 'protocol', ref: cardId, message: `Producer and Reviewer are the same agent (${a}) on attempt ${en.attempt} — separation of duties` });
      }
    }
  }
  return findings;
}
