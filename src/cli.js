#!/usr/bin/env node
import { Command } from 'commander';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, statSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pkg from '../package.json' with { type: 'json' };
import { openBoard, summary } from './kernel.js';
import { FileLog } from './eventlog.js';
import { resolveBoardDir, resolveInitTarget, manifestPathIn, dataDirIn, dataFilePath, legacyDataFiles, migrateDataFiles, hasManifest, repoRoot, registerBoard, gitObserver, gitIdentity, homeConfig } from './boards.js';
import { compile, diffCompiled, isEmptyChangeset, reconcileMoves } from './compile.js';
import { indexRecords, indexDocs } from './binding.js';
import { forwardEdges, collectBacklinks, neighborhood, parseCurie, refEdges, collectFrontier, stageProcedurePath, stageAgreementPath, presentIncoming, refTarget, refsFromArgs } from './refs.js';
import { boardRepertoire, parseProtocol, protocolStrict, checkRepertoireStrict, stampedProtocol, renderWorkspace, renderRoleProjection, lintProtocolEnactments } from './collaborate.js';
import { parseAgreement } from './agreement.js';
import { lintRecords, cardHandles } from './lint.js';
import { foldAccretion } from './accretion.js';
import { renderMap, renderMapIndex, renderFootprints, renderCuration, recordFootprints } from './map.js';
import { foldMetrics, renderMetrics } from './metrics.js';
import { writeFrontmatterBlock, writeFrontmatterField, readFrontmatter } from './frontmatter.js';
import { search as searchStore } from './search.js';
import { execFileSync, spawn } from 'node:child_process';
import { execCommand } from './hooks.js';
import { materialize, materializeNetwork, renderNetwork, renderBoard, renderPortfolio, writeProjection, handle, cardLine, loopCeiling } from './projection.js';
import { slugify } from './slug.js';
import { resolveBody, editFile } from './input.js';
import { renderAgents } from './agents.js';
import { EVOLVING_MD } from './evolving.js';
import { renderSchema } from './protocol.js';
import { parseChecklistItems, renderChecklists, incompleteReport } from './checklist.js';
import { loadManifest, mergeManifests, typeDef, vocabTerms, embodiedTypes, recordTypes, portfolioTypes, admittedSourcesNote, optionsStageIds, stages } from './manifest.js';
import { discoverBoards, deriveRoster, discoverNetworks, anchorOf } from './network.js';
import { retain as retainCase, taxonomy as caseTaxonomy, migrateCases, casesDir } from './cases.js';
import { captureCard, noteCard, elaborateCard, reaffirmCard, graduateRecord, scopeCard, applyReslug, mergeCards, indexCardBoundDocs, syncBoard, parseLane, mergeRefs, linkRefs, unlinkRefs, resolvePiece, listSkills, assembleProcedure, resolveProcedure, runnableKnownCuries, contentDigest, sweepShouldRestamp, resolveRelTargets, resolveRelTarget } from './commands.js';
import { declaredParams, validateParams, createRunDir, runInitHook, interpolate, declaredArtifacts, renderArtifactsSection, renderDispositionSection, finalizeRun, resolveRunDir, effectiveDisposition } from './runner.js';
import { resolveExecTemplate, readConfig, resolveGrant, assembleRunner, runShell, prepareSandbox, harnessEnv } from './runnercmd.js';
import { declaredWorkspace, findRepoRoot, workspaceBranch, materializeWorktree, materializeCardWorktree, findCardWorktree, computeCardWorktreeDiff, removeCardWorktree } from './workspace.js';
import { registerSchedule, removeSchedule, annotateSchedules, fireSchedule, grantSummary } from './schedule.js';
import { assertSupportedOn, checkWatches, readWatchState, stateKey, SUPPORTED_NAMESPACES } from './watch.js';
import { resolveDotPath, formatProjected } from './dotpath.js';
import { computeStats, renderStats } from './stats.js';
import { resolveScopes, assertScope, recordScopes, formatScopeSummary, scopeIds } from './scope.js';
import { vendorSite, loadVendorStubs } from './vendor.js';

// Advertise this entrypoint so hook handlers can call verbs back (the board
// reacting to itself). Inherited by spawned handlers via the environment.
process.env.KANBENTO_CLI ??= fileURLToPath(import.meta.url);

// Thin CLI adapter over the kernel. The kernel is a library (openBoard); this is
// one transport. Each verb is a Commander command — options/help/validation come
// from one definition per verb, so adding a flag touches one place. Board
// location mirrors git: `@name` is a shared board under $KANBENTO_HOME (reachable
// from any folder); otherwise a path, or walk-up.

// Root anchors `init` writes so any agent discovers the board; the full guide
// lives in .kanbento/AGENTS.md, these only point to it.
const ANCHOR_AGENTS = [
  '## Kanbento board',
  'This repo coordinates work on a kanbento board.',
  '- Board state: `.kanbento/views/BOARD.md` (read-only, auto-generated).',
  '- Knowledge map: `.kanbento/views/maps/index.md` (the records + their resolved graph; `kanbento map`).',
  '- How to operate: `.kanbento/AGENTS.md`.',
  'Act with the `kanbento` CLI.',
].join('\n');
const ANCHOR_CLAUDE = [
  '## Kanbento board',
  '@.kanbento/AGENTS.md',
  'That file is the operating guide; `.kanbento/views/BOARD.md` is live state — re-read it after each change.',
].join('\n');
const MARK_START = '<!-- kanbento:start -->';
const MARK_END = '<!-- kanbento:end -->';
const MARK_RE = /<!-- kanbento:start -->[\s\S]*?<!-- kanbento:end -->/;

// .kanbento/.gitignore written by init: ignore regenerated state. The manifest, the
// AGENTS.md guide, and data/ (events.jsonl log, compiled.json baseline) stay committed.
// `.kanbento` (the filename) is the store-routing pointer written inside a
// worktree's checked-out store — must never merge into the main checkout.
const DATA_GITIGNORE = ['# kanbento — generated state, regenerated on demand', 'views/', 'runs/', 'worktrees/', 'vendor/', '.kanbento', '*.tmp', 'last-engineered-context.txt', ''].join('\n');

// --- board context ----------------------------------------------------------

// Open the board named by the global --board (for verbs that operate on one).
async function openCtx() {
  const g = program.opts();
  const { dir } = resolveBoardDir(g.board);
  const manifestPath = g.manifest ? resolve(g.manifest) : manifestPathIn(dir);
  if (!existsSync(manifestPath)) {
    throw new Error(`no board at ${dir} — run: kanbento init ${g.board ?? ''}`.trim());
  }
  // A ≤0.2 store (events.jsonl at the store root) would open as an empty board —
  // every card invisible, silently. Refuse instead; `upgrade` migrates the files.
  const legacy = legacyDataFiles(dir);
  if (legacy.length) {
    throw new Error(`board at ${dir} uses the pre-0.3 store layout (${legacy.map((f) => '.kanbento/' + f.name).join(', ')} at the store root) — run: kanbento upgrade`);
  }
  const dataDir = dataDirIn(dir);
  const board = await openBoard({ manifestPath, log: new FileLog(dataFilePath(dir, 'events.jsonl')), boardDir: dir, observe: gitObserver(dir), identify: gitIdentity(dir) });
  board.on('hook', (e) => {
    if (e.phase === 'before') {
      // A soft gate (SHOULD/MAY) that disapproved is a WARN/INFO, not a VETO — it passed.
      const tag = e.warn ? (e.enforcement === 'inform' ? 'INFO' : 'WARN') : e.verdict.approve ? 'approve' : 'VETO';
      console.error(`  hook ${e.hook}: ${tag} — ${e.verdict.reason}`);
    } else if (e.output) console.error(`  hook ${e.hook}: ${e.output}`);
  });
  return { board, dir, dataDir };
}

// Write-through after a state change: re-render the read-model projection.
const rematerialize = (board, dataDir) => materialize(board, join(dataDir, 'views', 'BOARD.md'));

// English ordinal for a positive integer (1→"1st", 2→"2nd", 3→"3rd", 11→"11th").
// Used by the elaborate append-drift nudge to name the accretion count.
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// One shape for every state-changing verb: open the board, act, re-render the read
// model. The wrapper owns rematerialize, so a handler cannot forget it and leave a
// stale BOARD.md. Read-only verbs keep calling openCtx() directly.
const act = (fn) => async (...args) => {
  const ctx = await openCtx();
  await fn(ctx, ...args);
  await rematerialize(ctx.board, ctx.dataDir);
};

// commander variadic pair options (`--rel key=curie`, `--lane axis=value`) greedily
// swallow trailing positional words — it can't tell a pair from following free text, so
// `capture --rel about=note:y "trailing text"` loses the text into the flag. Split the
// collected tokens: real pairs stay on the flag; a stray word that TRAILS the pairs is
// recovered as positional text (the intuitive command just works); a stray wedged
// BETWEEN pairs is unrecoverable — error and name the cause. `sep` is the pair
// separator(s): `=` everywhere, plus `:` for --rel's key:curie form. `recover:false`
// (a filter like board --lane, no positional text) makes any non-pair an error. Returns
// { pairs, recovered } — pairs go back on the flag, recovered joins the text in order.
//
// A pair candidate must MATCH a real pair, not merely contain a separator: a bare key
// (letters/digits/dash/underscore, no whitespace) then a separator then a value —
// the shapes refsFromArgs (key=type:slug · key:type:slug) and parseLane (axis=value)
// accept. Critically a token with ANY whitespace is never a pair, so quoted multi-word
// prose (which routinely carries ':' or '=') flows to positional text as intended.
function reclaimVariadic(tokens, { label, sep, recover = true }) {
  if (!tokens?.length) return { pairs: tokens, recovered: [] };
  const pairRe = new RegExp(`^[A-Za-z0-9_-]+[${sep.join('')}]\\S`);
  const isPair = (t) => { const s = String(t); return !/\s/.test(s) && pairRe.test(s); };
  // A key with a separator but NO value (`scope=`) is a malformed pair, not prose —
  // recovering it into positional text buries the mistake in the card title.
  const malformedRe = new RegExp(`^[A-Za-z0-9_-]+[${sep.join('')}]$`);
  const isMalformed = (t) => { const s = String(t); if (!malformedRe.test(s)) return false;
    const key = s.slice(0, -1);
    throw new Error(`${label}: "${s}" has an empty value — expected key=value${key === 'scope' ? ' (scope is a card field, not a lane — assign it with --scope <s>)' : ''}`);
  };
  let lastPair = -1;
  for (let i = 0; i < tokens.length; i++) if (isPair(tokens[i])) lastPair = i;
  const pairs = [];
  const recovered = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isPair(tokens[i])) pairs.push(tokens[i]);
    else if (isMalformed(tokens[i])) { /* throws */ }
    else if (!recover || i < lastPair) throw new Error(`${label}: "${tokens[i]}" is not a key=value pair — variadic flags consume trailing words; put free text before the flag or quote pairs`);
    else recovered.push(tokens[i]);
  }
  return { pairs, recovered };
}

// When a command ends with no text/content but a variadic flag DID claim tokens this
// invocation, the empty input is almost certainly the flag swallowing it — name the
// flag and the fix so the "no text" error points at the real cause. Empty string when
// nothing was claimed (the ordinary no-input case). `claims` are [label, claim] pairs.
function variadicHint(claims) {
  const hit = claims.find(([, c]) => c.pairs?.length);
  return hit ? ` — ${hit[0]} claimed "${hit[1].pairs[0]}" as a pair; put free text before the flag, quote pairs, or use -F` : '';
}

// Checklist inline items use the whole-text grammar (`- [ ] text` / `- [x] text`). Those
// tokens start with `-`, so Commander classifies them as unknown options and the
// documented form `checklist <card> <list> '- [ ] one'` dies before the action runs.
// Insert `--` before the first grammar-shaped token on the checklist verb so items stay
// positional; real flags (`--check`, `-F`, `--incomplete`) are untouched.
// Prefix of the checkbox grammar (same bullets/marks as parseChecklistItems).
const CHECKLIST_INLINE_PREFIX = /^\s*[-*+]\s*\[[ xX]\]/;
function protectChecklistArgv(argv) {
  const out = argv.slice();
  // Skip node/script + root options so `--board checklist` is not mistaken for the verb.
  let i = 2;
  while (i < out.length) {
    const a = out[i];
    if (a === '--board' || a === '--manifest') { i += 2; continue; }
    if (typeof a === 'string' && (a.startsWith('--board=') || a.startsWith('--manifest='))) { i += 1; continue; }
    if (a === '-V' || a === '--version' || a === '-h' || a === '--help') { i += 1; continue; }
    break;
  }
  if (out[i] !== 'checklist') return out;
  i += 1; // past the verb; scan remaining tokens for a grammar-shaped item
  for (; i < out.length; i++) {
    if (out[i] === '--') break; // already end-of-options
    if (typeof out[i] === 'string' && CHECKLIST_INLINE_PREFIX.test(out[i])) {
      out.splice(i, 0, '--');
      break;
    }
  }
  return out;
}

// Render a network by name: derive its roster from the discovered boards (the
// members that declare it), open each member's read model, and project. Persists
// to the anchor board (the one named like the network) when present; else prints.
async function renderNetworkFor(name, boards) {
  const members = [];
  for (const r of deriveRoster(boards, name)) {
    try {
      const b = await openBoard({ manifestPath: manifestPathIn(r.location), log: new FileLog(dataFilePath(r.location, 'events.jsonl')), boardDir: r.location });
      members.push({ handle: r.handle, location: r.location, manifest: b.manifest, cards: await b.pool() });
    } catch (e) {
      members.push({ handle: r.handle, location: r.location, error: e.message });
    }
  }
  const anchor = anchorOf(boards, name);
  const host = { id: name, name: anchor?.manifest.board?.name ?? name };
  if (anchor) {
    const path = join(dataDirIn(anchor.dir), 'views', 'NETWORK.md');
    return { markdown: await materializeNetwork(host, members, path), path };
  }
  return { markdown: renderNetwork(host, members), path: null };
}

// --- the program ------------------------------------------------------------

// A static JSON import, not a runtime read: bundlers inline it, so the version
// survives `bun build --compile` / SEA, where there is no package.json on disk.
const VERSION = pkg.version ?? '0.0.0';

const program = new Command();
program
  .name('kanbento')
  .version(VERSION)
  .description('A file-based kanban board for coordinating work across agent sessions and repos.')
  .option('--board <ref>', 'shared @name, a <dir>, or (omitted) walk up from cwd for a board')
  .option('--manifest <path>', 'override the manifest path')
  .showHelpAfterError('(run `kanbento --help` or `kanbento help <verb>`)');

program
  .command('init')
  .argument('[target]', '@name or <dir> for the board (default: cwd)')
  .summary('create a board (manifest + guide + root anchors)')
  .option('--from <manifest>', 'seed the manifest from a file')
  .option('--template <n>', 'stage ladder 2..5 (default 4); enumerated below')
  .option('--id <id>', 'board id (else derived from the target dir; overrides a --from seed\'s identity)')
  .option('--name <name>', 'board display name (defaults to the id)')
  .addHelpText('after', () => {
    const w = Math.max(...Object.values(TEMPLATES).map((t) => t.chain.length));
    const lines = ['', 'Templates (--template <n>; default 4 — the 4-stage board):'];
    for (const [n, t] of Object.entries(TEMPLATES)) lines.push(`  ${n}  ${t.chain.padEnd(w)}   ${t.blurb}`);
    return lines.join('\n');
  })
  .action(async (target, opts) => {
    if (opts.from && opts.template != null) throw new Error('init: pass --from OR --template, not both');
    const template = opts.template != null ? resolveTemplate(opts.template) : null;
    const { dir, label } = resolveInitTarget(target ?? program.opts().board);
    await initBoard(dir, label, opts.from, { id: opts.id, name: opts.name }, template);
  });

program
  .command('install')
  .argument('<workflow>', 'a workflow dir or manifest to vendor into this board')
  .summary('vendor a workflow into this board (one-time copy, locked)')
  .action(async (workflow) => {
    const { dir, label } = resolveBoardDir(program.opts().board);
    await installWorkflow(dir, label, workflow);
  });

program
  .command('vendor')
  .argument('<url>', 'public docs site URL — path is the prefix filter')
  .summary('map a public docs site into searchable stubs (sitemap; titles + heading outline; no prose)')
  .description([
    'Resolve the site\'s sitemap (<link rel="sitemap">, else /sitemap.xml), follow',
    'sitemap-index to nested urlsets, prefix-filter by the given URL, and write one',
    'stub per URL under .kanbento/vendor/<host>/<url-path>.md. Each stub is STRUCTURE',
    'only: frontmatter url/title/lastmod/fetched plus description + h1–h6 outline',
    '(never prose). When the host serves <url>.md markdown, stub url: is that variant.',
    'No sitemap is a teaching error — v1 has no crawl fallback.',
    'Re-run refetches bare stubs (no title) and skips healthy ones; orphans are left.',
  ].join('\n'))
  .action(async (url) => {
    const { board, dataDir } = await openCtx();
    const r = await vendorSite({ dataDir, url, log: (m) => console.log(m) });
    // The partition now exists — the operating guide's one-line pointer must appear
    // without waiting for the next compile/upgrade.
    await writeFile(join(dataDir, 'AGENTS.md'), renderAgents(board.manifest, { verbs: describeVerbs(), hasVendor: true }), 'utf8');
    console.log(`vendor: wrote ${r.written} stub(s) under .kanbento/vendor/${r.host}/`);
    if (r.failures.length) {
      const byStatus = new Map();
      for (const f of r.failures) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
      const breakdown = [...byStatus.entries()].map(([s, n]) => `${n}× ${s === 0 ? 'network/timeout' : s}`).join(', ');
      console.log(`vendor: ${r.failures.length} page(s) failed (${breakdown}) — their stubs carry url + fetched only; re-run to retry`);
    }
  });

program
  .command('schema')
  .summary('print the manifest grammar (closed core + skeleton)')
  .action(() => console.log(renderSchema()));

program
  .command('capture')
  .argument('[text...]', 'free-text description of the work (or use -F / piped stdin)')
  .summary('add work to the inbox; a typed capture materializes its file/folder')
  .option('--type <type>', 'card type (must be declared by the board)')
  .option('--slug <slug>', 'pin an explicit handle — names the artifact and leads the card\'s slug@id (else a slug is derived from the title, dynamically)')
  .option('--from <ref>', 'parent card — sets lineage (research → brief)')
  .option('--source <src>', 'attribution — also the scope of --key (the natural key is the compound source+key)', 'agent')
  .option('--key <idem>', 'external identity — with --source forms the natural key (source+key); re-capture with the same compound is an idempotent no-op; required for types declaring externalKey; requires an explicit --source')
  .option('--lane <pair...>', 'set partition field(s), e.g. website=site-a (a lane axis derives from them)')
  .option('--scope <s>', 'product scope, validated against the board\'s resolved scope vocabulary — explicit wins over cwd inference (sibling of note --scope)')
  .option('--rel <pair...>', 'typed relation key=<ref> — <ref> is slug|id|CURIE|prefix (same as other verbs); e.g. advances=capability:x · parent=metrics-fold · about=note:z (key:value colon form also accepted; sets payload.refs.<key>)')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin); a rich body is bound as the card doc (one-step capture + elaborate); with inline text too, the text stays the title')
  .option('--title <text>', "one-line title (overrides a title derived from the text/body — the sibling of request --title)")
  .action(act(async ({ board, dir }, text, opts, cmd) => {
    // --key makes --source half of an identity (the compound source+key), so it must
    // be deliberate: without a key, source is pure attribution and the agent default
    // is fine; with a key, a defaulted source would silently land semantic keys in
    // the shared agent bucket — a swallowed idempotent no-op, not even a duplicate.
    // The kernel can't see omission (it always receives a source), so the guard is here.
    if (opts.key && cmd.getOptionValueSource('source') === 'default') {
      // Enumerate the admitted kinds so the agent's next move needs no manifest
      // lookup; an open inbox (no inbox.sources) has nothing to enumerate — plain
      // message. A missing board never reaches here: openCtx (in act) fails first.
      const note = admittedSourcesNote(board.manifest);
      throw new Error(`capture: --key requires an explicit --source — the key is scoped by its source (the compound source+key is the natural key)${note ? ` — ${note}` : ''}`);
    }
    // Rescue any trailing text the variadic --rel/--lane swallowed back into the positional
    // text (recovered tokens keep their order), so the intuitive command just works.
    const relClaim = reclaimVariadic(opts.rel, { label: '--rel', sep: ['=', ':'] });
    const laneClaim = reclaimVariadic(opts.lane, { label: '--lane', sep: ['='] });
    opts.rel = relClaim.pairs;
    opts.lane = laneClaim.pairs;
    text = [...(text ?? []), ...relClaim.recovered, ...laneClaim.recovered];
    opts.claimedHint = variadicHint([['--rel', relClaim], ['--lane', laneClaim]]); // read only on the no-text path
    const body = resolveBody(text, opts, { noEditor: true }); // inline text, -F <file>, or piped stdin
    // An explicit --title wins; else inline text AND -F together means the text is the
    // title and the file the body — so the file's first line can't silently overwrite it.
    const title = opts.title ?? (opts.bodyFile && text?.length ? text.join(' ') : undefined);
    // A body from -F/stdin is a document (not a one-liner), so bind it as the card's doc —
    // the one-step form of capture-then-elaborate. Inline text stays a plain inline body.
    const richBody = !!opts.bodyFile || (!(text && text.length) && !process.stdin.isTTY);
    const { card, artifact, boundDoc } = await captureCard({ board, dir }, body, { ...opts, richBody, title });
    console.log(`captured \`${handle(card)}\``); // the handle — what you pull/transition with
    console.log(`  ${summary(card)}`);
    console.log(`  ${card.id}  ·  state=${card.state}  type=${card.type ?? 'untyped'}${card.scope ? `  scope=${card.scope}` : ''}`);
    if (artifact) console.log(`  → ${artifact.show}  (${artifact.workspace ? 'workspace' : 'tracked'} — start here)`);
    if (boundDoc) console.log(`  → ${boundDoc}  (doc)`);
    surfaceContract(board.manifest, card.state, dir); // capture lands a card in a stage too — surface its contract
    // Fire when either field is underived. `title` is authored-or-null, so an
    // unnamed card is simply one with no title — no heading test, no identity test.
    if (!opts.slug || !card.title) fireNaming(card.id, dir);
  }));

program
  .command('note')
  .argument('[text...]', 'the knowledge to keep (or use -F / piped stdin)')
  .summary('capture a unit of knowledge — a file in the knowledge layer, not a card (no status, never on the board)')
  .option('--type <type>', 'record type, flow:false (default: the builtin note -> .kanbento/notes/{slug}.md)')
  .option('--slug <slug>', 'pin the filename slug (else derived from the title)')
  .option('--scope <ids>', 'product scope(s), comma-separated, written to frontmatter (zero-or-more; none = universal) — validated against the board\'s resolved scope vocabulary; never a folder placement')
  .option('--title <text>', "one-line title (overrides a title derived from the body's first line — sibling of capture --title)")
  .option('--rel <pair...>', 'typed relation key=<ref> — <ref> is slug|id|CURIE|prefix (same as other verbs); e.g. advances=capability:x · about=<id> · about=note:z (key:value colon form also accepted; sets frontmatter refs.<key>)')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin); with inline text too, the text stays the title')
  .action(async (text, opts) => {
    const { board, dir } = await openCtx(); // no board mutation — the file IS the write model, nothing to rematerialize
    // Rescue trailing text the variadic --rel swallowed back into the positional text.
    const relClaim = reclaimVariadic(opts.rel, { label: '--rel', sep: ['=', ':'] });
    opts.rel = relClaim.pairs;
    text = [...(text ?? []), ...relClaim.recovered];
    opts.claimedHint = variadicHint([['--rel', relClaim]]); // read only on the no-content path
    const body = resolveBody(text, opts, { noEditor: true });
    // Explicit --title wins; else inline text AND -F together means the text is the
    // title and the file the body — so the file's first line can't silently overwrite it.
    const title = opts.title ?? (opts.bodyFile && text?.length ? text.join(' ') : undefined);
    const { curie, artifact } = await noteCard({ board, dir }, body, { ...opts, title });
    console.log(`noted \`${curie}\` → ${artifact.show}`);
  });

program
  .command('transition')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .argument('<toStage>', 'target stage (forward, an edge, or back to an options stage to deprioritize)')
  .summary('move a card to another stage')
  .action(act(async ({ board, dir }, ref, toStage) => {
    const res = await board.transition(ref, toStage);
    printMove(res);
    surfaceContract(board.manifest, res.card.state, dir); // the landed stage's contract — the DoR you're under, the DoD to reach
  }));

program
  .command('commit')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('cross the commitment point')
  .action(act(async ({ board, dir }, ref) => {
    const res = await board.commit(ref);
    printMove(res);
    surfaceContract(board.manifest, res.card.state, dir);
  }));

program
  .command('archive')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .argument('<stage>', 'stage to freeze at (a gated move if not already there); disposition is derived from its role')
  .summary('freeze a card read-only at a stage, off the active board (disposition derived + frozen)')
  .action(act(async ({ board }, ref, stage) => {
    const card = await board.archive(ref, stage);
    console.log(`⊘ archived ${handle(card)} at [${card.state}] as ${card.disposition} — frozen (read-only), off the active board → ARCHIVE.md`);
  }));

program
  .command('run')
  .argument('<ref>', 'seed card — handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .argument('<exit...>', "the run's exit criterion (prose) — drive the card until this holds")
  .summary('autonomously drive a card through the flow until an exit criterion holds')
  .option('--max-steps <n>', 'cap on stage invocations before escalating', '24')
  .option('--max-stuck <n>', 'consecutive no-progress invocations at a point before escalating', '3')
  .action(act(async ({ board, dataDir }, ref, exit, opts) => {
    const exitText = exit.join(' ');
    // A per-run scratchpad, created at invoke: holds the journal + the agent's
    // working artifacts — the run's durable working set, carried across the
    // context reset between stages (distinct from the card's bound deliverable).
    const runDir = join(dataDir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(runDir, { recursive: true });
    const journalPath = join(runDir, 'journal.md');
    await writeFile(journalPath, `# run journal\n\n- card: ${ref}\n- goal: ${exitText}\n- started: ${new Date().toISOString()}\n\n`, 'utf8');
    const journal = { path: journalPath, write: (line) => { appendFileSync(journalPath, line + '\n'); console.error(line); } };
    const res = await board.run(ref, exitText, {
      maxSteps: Number(opts.maxSteps) || 24,
      maxStuck: Number(opts.maxStuck) || 3,
      journal,
      scratch: runDir,
    });
    const mark = res.outcome === 'delivered' ? '✓' : res.outcome === 'exit-unmet' ? '◌' : '⚠';
    console.log(`${mark} run ${res.outcome}: ${handle(res.card)} now [${res.card.state}]`);
    if (res.reason) console.log(`  ${res.reason}`);
    console.log(`  ${res.steps.length} step(s) · workspace → ${runDir}`);
    if (res.outcome !== 'delivered') process.exitCode = 1;
  }));

// A card-scoped, PERSISTENT git worktree — the delivery coordinator's step-0
// "table". Distinct from the run-scoped worktree (`do --exec`, keyed slug+params,
// torn down at finalize): this one is keyed on the CARD ID, reused across the stage
// loop (a review FAIL sends dev back into the SAME tree), and removed only here, at
// done/abandon. `open` is idempotent — materialize-or-reuse — so a coordinator can
// call it before every dev entry.
const worktree = program
  .command('worktree')
  .summary("the card's persistent worktree — a card-scoped branch the coordinator opens before dev and reuses across the stage loop");

// Resolve a ref to { card, repoRoot, dataDir, boardDir, boardId } — the common
// prelude for the subcommands. Errors clearly on an unknown card or a non-repo board.
async function cardWorktreeCtx(ref) {
  const { board, dir, dataDir } = await openCtx();
  const card = await board.card(ref);
  if (!card) throw new Error(`no card matching "${ref}"`);
  const root = await findRepoRoot(dir);
  if (!root) throw new Error(`${dir} is not inside a git repository — a card worktree needs a repo to branch from`);
  return {
    card,
    repoRoot: root,
    dataDir,
    boardDir: dir,
    boardId: board.manifest?.board?.id ?? null,
  };
}

worktree
  .command('open')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .option('--base <ref>', 'base ref to branch from on first materialization (default HEAD)')
  .summary('materialize (or reuse) the card worktree and print its path')
  .action(async (ref, opts) => {
    const { card, repoRoot, dataDir, boardDir } = await cardWorktreeCtx(ref);
    const meta = await materializeCardWorktree({
      repoRoot, dataDir, cardId: card.id, base: opts.base ?? null, boardDir,
    });
    console.log(meta.dir); // stdout: the path, so a coordinator can capture it
    console.error(`  ${meta.reused ? 'reused' : 'materialized'} ${handle(card)} → branch ${meta.branch} (base ${meta.baseSha.slice(0, 8)})`);
  });

worktree
  .command('path')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('print the card worktree path if it exists')
  .action(async (ref) => {
    const { card, dataDir } = await cardWorktreeCtx(ref);
    const meta = await findCardWorktree({ dataDir, cardId: card.id });
    if (!meta) { console.error(`  no worktree for ${handle(card)} — open one with: kanbento worktree open ${ref}`); process.exitCode = 1; return; }
    console.log(meta.dir);
  });

worktree
  .command('diff')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('compute the card branch diff (base..branch) — a reviewer subject')
  .action(async (ref) => {
    const { card, dataDir } = await cardWorktreeCtx(ref);
    const { patch, summary, baseSha, branchTip } = await computeCardWorktreeDiff({ dataDir, cardId: card.id });
    const range = baseSha && branchTip
      ? ` · ${baseSha.slice(0, 8)}..${branchTip.slice(0, 8)}`
      : '';
    console.log(`${summary.files.length} file(s) · +${summary.insertions} −${summary.deletions}${range} → ${patch}`);
    for (const f of summary.files) console.log(`  ${f}`);
  });

worktree
  .command('remove')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('remove the card worktree + branch (the explicit teardown at done/abandon)')
  .action(async (ref) => {
    const { card, repoRoot, dataDir } = await cardWorktreeCtx(ref);
    await removeCardWorktree({ repoRoot, dataDir, cardId: card.id });
    console.log(`⊘ removed card worktree for ${handle(card)}`);
  });

// Parse one repertoire entry's agreement doc (resolved via its ref) into the moves.
// Returns an empty protocol when the ref is absent/unreadable (the facet stays inert,
// never throws).
async function parseAgreementProto(manifest, dir, agreementRef) {
  let proto = parseProtocol('');
  if (agreementRef) {
    const t = refTarget(manifest, agreementRef);
    if (t?.path) {
      try { proto = parseProtocol((await readFrontmatter(resolve(dir, t.path))).body); } catch { /* unreadable — inert */ }
    }
  }
  return proto;
}

// Resolve the governing protocol for a card from the board REPERTOIRE (the map of games
// the board knows). Invocation picks the game: an explicit `--protocol <name>` wins; else
// the pattern stamped on the card's opening move (per-enactment, self-describing from the
// log); else the sole repertoire entry (a single-entry repertoire needs no choice); else
// ambiguous — warn and fall back to an inert protocol. Returns { pattern, entry, proto,
// warnings }.
async function resolveGoverning(manifest, dir, { events = [], cardId = null, explicit = null } = {}) {
  const rep = boardRepertoire(manifest);
  const names = Object.keys(rep);
  const warnings = [];
  let pattern = null;
  if (explicit) {
    pattern = explicit;
    if (!rep[explicit]) warnings.push(`protocol "${explicit}" is not in the board repertoire (${names.join(', ') || 'empty'})`);
  } else {
    const stamped = cardId ? stampedProtocol(events, cardId) : null;
    if (stamped) pattern = stamped;
    else if (names.length === 1) pattern = names[0];
    else if (names.length > 1) warnings.push(`ambiguous protocol — the repertoire has ${names.length} patterns (${names.join(', ')}); pass --protocol <pattern>`);
  }
  const entry = pattern ? rep[pattern] : null;
  const proto = await parseAgreementProto(manifest, dir, entry?.agreement);
  return { pattern, entry, proto, warnings };
}

// Parse `key=value` binding tokens into a bindings object (the move's `out`s). A token
// without `=` is not a binding — the CLI names the fix.
function parseBindings(pairs, verb) {
  const out = {};
  for (const tok of pairs ?? []) {
    const s = String(tok);
    const i = s.indexOf('=');
    if (i <= 0) throw new Error(`${verb}: "${s}" is not a key=value binding — a move binds its outs as key=value (or use -F for a body)`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

// `act` — play a move in the Collaborate protocol (append a binding event), or drop an
// untyped remark (--remark). The write side of the workspace; `workspace` is the read
// side. Single-binding is hard-refused in the kernel; missing ins / unknown moves warn.
program
  .command('act')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .argument('[move]', 'the Move to play (e.g. Deliver, Review, Ship) — omit with --remark for an untyped note')
  .argument('[pairs...]', 'out bindings as key=value (e.g. verdict=ship)')
  .summary('play a move in the Collaborate protocol — append a binding event to the card enactment (--remark for an untyped note)')
  .option('-F, --body-file <path>', 'read a body binding from a file (- for stdin) — binds the move\'s single free out')
  .option('--remark <text>', 'an untyped free-text note on the enactment (the overflow hatch; no move, no binding)')
  .option('--as <role>', 'the role the move is played as (default: the move\'s owner in the protocol)')
  .option('--protocol <name>', 'select the governing protocol from the board repertoire (default: the enactment\'s stamped pattern, else the sole entry)')
  .action(act(async ({ board, dir }, ref, move, pairs, opts) => {
    // Remark-only (no Move) — the overflow hatch. A remark WITH a move is not this branch:
    // it composes onto the move below (a move with a note is a natural utterance, not a
    // competing form), so a present move is never silently dropped.
    if (!move) {
      const res = await board.act(ref, null, { remark: opts.remark ?? (Array.isArray(pairs) ? pairs.join(' ') : '') });
      console.log(`remark on \`${handle(res.card)}\` (attempt ${res.attempt} @${res.card.state})`);
      return;
    }
    const card = await board.card(ref);
    if (!card) throw new Error(`act: no card matching "${ref}"`);
    const events = await board.events();
    const { pattern, proto, warnings: rw } = await resolveGoverning(board.manifest, dir, { events, cardId: card.id, explicit: opts.protocol ?? null });
    for (const w of rw) console.error(`  ⚠ ${w}`);
    const bindings = parseBindings(pairs, 'act');
    const body = opts.bodyFile != null ? resolveBody([], opts, { noEditor: true }) : '';
    if (body) {
      const def = (proto.moves ?? []).find((m) => m.move === move);
      const free = (def?.out ?? []).filter((o) => !(o in bindings));
      if (def && free.length === 1) bindings[free[0]] = body;
      else if (def && free.length !== 1) throw new Error(`act: -F body is ambiguous — "${move}" has ${free.length} free out(s); bind explicitly as <param>=...`);
      else bindings.body = body; // no protocol/move — keep the body under a generic key
    }
    const res = await board.act(ref, move, { bindings, remark: opts.remark ?? null, role: opts.as ?? null, protocol: proto, protocolName: pattern, strict: protocolStrict(board.manifest) });
    for (const w of res.warnings) console.error(`  ⚠ ${w}`);
    const bits = Object.keys(res.event.bindings ?? {});
    const noted = res.event.remark != null ? ' · remark' : '';
    console.log(`${move} on \`${handle(res.card)}\` (attempt ${res.attempt} @${res.card.state})${bits.length ? ' — bound ' + bits.join(', ') : ''}${noted}`);
  }));

// `workspace` — the enactment read-model: current key (card, stage, attempt), moves
// played, bindings, enabled moves, remarks, and the worktree path. A projection over
// the log, same as BOARD.md. `--role` narrows to one role's projection (a briefing
// embed). Read-only.
program
  .command('workspace')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('the enactment read-model — moves played, bindings, enabled moves + the worktree (a projection over the log)')
  .option('--role <role>', 'narrow to one role\'s projection (its moves + what it watches) — the dispatch-briefing embed')
  .action(async (ref, opts) => {
    const { board, dir, dataDir } = await openCtx();
    const card = await board.card(ref);
    if (!card) throw new Error(`workspace: no card matching "${ref}"`);
    const events = await board.events();
    const { pattern, proto } = await resolveGoverning(board.manifest, dir, { events, cardId: card.id });
    const meta = await findCardWorktree({ dataDir, cardId: card.id });
    console.log(renderWorkspace({ proto, pattern, events, card, worktreePath: meta?.dir ?? null, role: opts.role ?? null }));
  });

program
  .command('request')
  .argument('<dest>', 'destination board — @handle (resolved via the registry) or a path')
  .argument('[text...]', 'the request (a one-liner; or use -F / stdin for a richer body)')
  .summary('request a card on another board — a remote card-creation request')
  .option('-F, --body-file <path>', 'read a richer, multi-line body from a file (- for stdin)')
  .option('--title <text>', "one-line title (default: the body's first line)")
  .option('--as <handle>', 'origin handle recorded as provenance (default: the current dir name)')
  .action(async (dest, text, opts) => {
    const origin = opts.as || basename(process.cwd());
    const { card, label } = await submitTo(dest, { body: resolveBody(text, opts), title: opts.title }, 'request', origin);
    console.log(`requested on ${label}: ${handle(card)} → [${card.state}]  (from ${origin})`);
  });

program
  .command('feedback')
  .argument('[text...]', 'feedback on kanbento (a one-liner; or use -F / stdin for a richer body)')
  .summary('send feedback to kanbento (sugar for: request @kanbento)')
  .option('-F, --body-file <path>', 'read a richer, multi-line body from a file (- for stdin)')
  .option('--title <text>', "one-line title (default: the body's first line)")
  .option('--as <handle>', 'origin handle recorded as provenance (default: the current dir name)')
  .action(async (text, opts) => {
    const origin = opts.as || basename(process.cwd());
    const { card, label } = await submitTo('@kanbento', { body: resolveBody(text, opts), title: opts.title }, 'feedback', origin);
    console.log(`feedback → ${label}: ${handle(card)} → [${card.state}]  (from ${origin})`);
  });

program
  .command('merge')
  .argument('<from>', 'duplicate card folded away')
  .argument('<into>', 'survivor card')
  .summary('fold a duplicate card into another (into survives)')
  .option('--title <text>', 'rewrite the survivor description (else it keeps its own)')
  .option('--discard-doc', "delete the folded card's bound doc even when it has a body")
  .action(act(async ({ board, dir }, from, into, opts) => {
    const { card, dropped } = await mergeCards({ board, dir }, from, into, { title: opts.title, discardDoc: !!opts.discardDoc });
    console.log(`merged ${from} → \`${handle(card)}\` "${summary(card)}"`);
    if (dropped) console.log(`  dropped ${dropped}`);
  }));

program
  .command('pool')
  .summary('query the Options pool — filter/sort the pre-commitment set (POOL.md is the canonical overview)')
  .description([
    'List the Options set — cards at options-role stages, the uncommitted pool —',
    'one line each, in the grammar shared with POOL.md (handle · type · truncated',
    'title · markers · relations). The pool IS the options pool: a committed,',
    'in-flight, or done card cannot be an option, so bare pool and every flag scope',
    'to options-role stages only — there is no full-store escape hatch. The scope is',
    'plural-aware (all options-role stages, however many a board declares). The',
    'flags compose: a query tool for the slice you need while working the list.',
    'Delivered work lives in views/DONE.md, archived freezes in views/ARCHIVE.md,',
    'never here; querying non-option cards is a separate need with its own verb.',
    '',
    'Flags:',
    '  --ref <curie>       keep cards whose refs (any key) touch the target CURIE',
    '                      (e.g. capability:network); no match yields an empty list, not an error',
    '  --sort created|updated   order ascending — oldest first (FIFO, matching POOL.md);',
    '                      "created" reads demand/recency, "updated" reads latest evidence',
    '  --sort recent       "updated" reversed — freshest first, the what-moved-lately read',
    '  --type <type>       keep cards of this type (e.g. story, bug)',
    '  --stage <id>        narrow to ONE options-role stage (only meaningful when the board',
    '                      declares several); a non-options or unknown id errors — the',
    '                      Options scope never widens',
  ].join('\n'))
  .option('--ref <curie>', 'filter to cards whose refs (any key) touch this target CURIE (within the Options set)')
  .option('--sort <axis>', 'order the list by created|updated, ascending (oldest first, FIFO like POOL.md); "recent" = updated, newest first')
  .option('--type <type>', 'filter to cards of this type (within the Options set)')
  .option('--stage <id>', 'narrow to a single options-role stage (non-options / unknown id errors)')
  .option('--scope <id>', 'filter to cards of this product scope — or the literal "unscoped" for the unscoped queue (needs the board to declare `scope:`)')
  .action(async (opts) => {
    // The Options set — cards at options-role stages, the pre-commitment pool.
    // Definitional: the pool IS the options pool; a committed/in-flight/done card
    // cannot be an option, so it is out of scope for bare pool AND every filter —
    // no --all re-admits it (querying non-option cards is a separate verb shape).
    // Plural-aware: scope is stage role=options membership, not a hardcoded id
    // (this board renamed its options stage `pool`; others may declare several).
    // Kernel board.pool() stays the full store set for callers that need it.
    const { board, dir } = await openCtx();
    const options = optionsStageIds(board.manifest);
    let cards = (await board.pool()).filter((c) => !c.archived && options.has(c.state));
    const filtered = opts.type != null || opts.ref != null || opts.stage != null || opts.scope != null;
    // --stage narrows WITHIN the Options set — it never widens scope. A non-options
    // stage id is rejected (the pool has no business past the commitment point); an
    // unknown id is rejected too. The two errors read distinctly so the caller knows
    // whether they mistyped or reached past the pool.
    if (opts.stage != null) {
      if (!options.has(opts.stage)) {
        const known = stages(board.manifest).some((s) => s.id === opts.stage);
        throw new Error(known
          ? `--stage: "${opts.stage}" is not an options-role stage — pool scopes to the Options set only (--stage narrows within it, never past the commitment point)`
          : `--stage: unknown stage "${opts.stage}" — name one of the options-role stages`);
      }
      cards = cards.filter((c) => c.state === opts.stage);
    }
    if (opts.type != null) cards = cards.filter((c) => c.type === opts.type);
    if (opts.ref != null) cards = cards.filter((c) => refTouches(c, opts.ref));
    // --scope narrows by the product-scope axis. Validated against the resolved
    // vocabulary (closed by the world); the literal "unscoped" lists the visible
    // queue to work down. Errors when the board declares no scope — the flag would
    // silently match nothing otherwise.
    if (opts.scope != null) {
      const scopes = resolveScopes(board.manifest, dir);
      if (!scopes) throw new Error('--scope: this board declares no scope vocabulary (manifest `scope:`, e.g. scope: apps/*)');
      if (opts.scope === 'unscoped') cards = cards.filter((c) => c.scope == null);
      else {
        assertScope(scopes, opts.scope, '--scope');
        cards = cards.filter((c) => c.scope === opts.scope);
      }
    }
    if (opts.sort != null) {
      if (!SORT_AXES.has(opts.sort)) {
        throw new Error(`--sort: unknown axis "${opts.sort}" — use "created", "updated" or "recent"`);
      }
      const key = opts.sort === 'created' ? 'createdAt' : 'updatedAt';
      // ascending, oldest first — FIFO, matching POOL.md's convention. "recent" is
      // the one exception: the name asserts freshest-first, so it reverses.
      const order = opts.sort === 'recent' ? -1 : 1;
      cards = cards.slice().sort((a, b) => order * (tsOf(a[key]) - tsOf(b[key])));
    }
    if (!cards.length) return console.log(filtered ? '(no cards match)' : '(pool is empty)');
    const loopMax = loopCeiling(board.manifest);
    const now = Date.now();
    // A per-line stage marker only when the board declares SEVERAL options stages —
    // then an option's stage is a real distinction worth reading. A single-options
    // board (the common shape) shows no marker: the listing is byte-identical to
    // before this card. A --stage narrowing collapses to one stage, so drop it too.
    const showStage = options.size > 1 && opts.stage == null;
    for (const c of cards) {
      const line = cardLine(c, null, now, '', loopMax);
      console.log(showStage ? `[${c.state}] ${line}` : line);
    }
    console.log(`\n${cards.length} card(s)`);
  });

// A card's refs (payload.refs) map rel-key -> CURIE or CURIE[]; the target touches
// the card iff it appears under any key. Unknown target -> false (empty list, no error).
function refTouches(c, target) {
  const refs = c.payload?.refs;
  if (!refs || typeof refs !== 'object') return false;
  for (const v of Object.values(refs)) {
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    if (list.includes(target)) return true;
  }
  return false;
}

// The --sort vocabulary. "recent" is an alias of "updated" reversed — freshest first.
const SORT_AXES = new Set(['created', 'updated', 'recent']);

// Epoch ms for an ISO timestamp; unparseable -> 0 (sorts oldest, deterministic).
function tsOf(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
}

program
  .command('search')
  .argument('<query...>', 'terms + flat operators (bare = OR; A AND B; A NOT B — AND/OR/NOT uppercase-only)')
  .summary('ranked whole-store recall — one query over every record, card (archived included), and vendor stub, per-invocation index')
  .description([
    'Search the whole knowledge base in one query — every record type (notes,',
    'capabilities, strategies, procedures, protocols, plans, initiatives), every',
    'card (archived included), and vendored docs stubs (kind vendor). No directory',
    'or type decision to search; the index is built in memory per invocation over',
    'title/slug/description/body (title/slug outrank body) and thrown away — no',
    'persisted index, no staleness. Fuzzy + prefix matching are on (the',
    'half-remembered-slug case). Vendor stubs have no product scope; --scope',
    'excludes them.',
    '',
    'Grammar (flat, v1 — one connective kind per query):',
    '  search A B        bare terms = ranked OR (the default)',
    '  search A AND B    all terms must match, results still scored',
    '  search A NOT B    exclude B',
    '  AND/OR/NOT are uppercase-only; lowercase "and" is an ordinary search term.',
    '  Mixing AND and OR errors (run two searches). No parentheses, no field scoping.',
    '',
    'Flags:',
    '  --type <type>   keep hits of this type only (opt-in narrow)',
    '  --scope <id>    keep hits that explicitly carry this product scope (cards of',
    '                  that scope, records listing it); universal records are excluded',
    '                  — drop the flag to search everything. The literal "unscoped"',
    '                  lists the null queue (cards only); needs the board to declare `scope:`',
    '  --limit <n>     widen the default ~10 result cap',
  ].join('\n'))
  .option('--type <type>', 'narrow results to one type (opt-in)')
  .option('--scope <id>', 'narrow to one product scope — cards of that scope and records listing it (universal excluded); "unscoped" lists the null queue (needs the board to declare `scope:`)')
  .option('--limit <n>', 'result cap (default 10)')
  .action(async (query, opts) => {
    const { board, dir, dataDir } = await openCtx();
    const limit = opts.limit != null ? Number(opts.limit) : 10;
    if (opts.limit != null && (!Number.isFinite(limit) || limit < 1)) {
      throw new Error(`--limit: expected a positive integer, got "${opts.limit}"`);
    }
    // --scope: validated against the resolved vocabulary before the index is built —
    // a typo'd scope must teach, not silently match nothing. The literal "unscoped"
    // bypasses the vocabulary: it is the reserved queue sentinel (parity with pool).
    if (opts.scope != null) {
      const scopes = resolveScopes(board.manifest, dir);
      if (!scopes) throw new Error('--scope: this board declares no scope vocabulary (manifest `scope:`, e.g. scope: apps/*)');
      if (opts.scope !== 'unscoped') assertScope(scopes, opts.scope, '--scope');
    }
    // The corpus: every record (with body) + every card (with body), archived included.
    const records = await loadRecords(board.manifest, dir, { withBody: true });
    const cards = await Promise.all((await board.pool()).map(async (c) => {
      let body = '', description = null;
      if (c.binding?.path) {
        try {
          const fm = await readFrontmatter(resolve(dir, c.binding.path));
          body = fm.body ?? '';
          description = fm.data?.description ?? null;
        } catch { /* a card whose body file is absent still indexes on its captured text */ }
      }
      // `title` is authored-or-null and carries the 3x boost, so it must never hold a
      // synthetic string; `label` is what the hit line prints. An unbound card has no
      // doc, so its CAPTURED text is the body to index — otherwise an unnamed card
      // would carry no searchable text at all.
      return { id: c.id, slug: c.slug, ref: handle(c), title: c.title, label: summary(c), type: c.type, description, body: body || c.body || '', archived: c.archived, scope: c.scope };
    }));
    const vendors = await loadVendorStubs(dataDir);
    const hits = searchStore({ records, cards, vendors }, query, { type: opts.type, scope: opts.scope, limit });
    if (!hits.length) {
      // A product-scope narrow that matches nothing is an honest empty state +
      // education: store-wide carry counts tell "nothing matched the QUERY"
      // from "nothing is scoped yet". `--scope unscoped` keeps the plain empty.
      if (opts.scope && opts.scope !== 'unscoped') {
        let nCards = 0, nRecords = 0;
        for (const c of cards) if (c.scope === opts.scope) nCards++;
        for (const r of records) if (recordScopes(r.scope).includes(opts.scope)) nRecords++;
        return console.log(
          `no hits scoped to ${opts.scope} — ${nCards} cards / ${nRecords} records carry it yet; universal records are excluded by --scope (drop the flag to search everything)`,
        );
      }
      return console.log('(no hits)');
    }
    for (const h of hits) {
      // Records carry their type in the CURIE already (type:slug); a card handle doesn't,
      // so typed cards wear it on the line. The scope chip (@<scope>) disambiguates same-
      // named work across products — the original failure this axis exists to fix.
      const scopeChip = (h.kind === 'card' ? (h.scope ? [h.scope] : []) : recordScopes(h.scope)).map((s) => `@${s}`).join(' ');
      const tags = `${h.kind === 'vendor' ? '  · vendor' : ''}${h.kind === 'card' && h.type ? `  · ${h.type}` : ''}${scopeChip ? `  · ${scopeChip}` : ''}${h.archived ? '  · archived' : ''}`;
      console.log(`  ${h.score.toFixed(2)}  ${h.ref}  "${h.title}"${tags}`);
      if (h.snippet) console.log(`      ${h.snippet}`);
    }
    console.log(`\n${hits.length} hit(s)`);
  });

program
  .command('card')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix — with --stats also a record CURIE')
  .summary('print one card as JSON, project a field via --path, or render computed --stats (display-only signals)')
  .option('--path <path>', 'project a field via minimal dot-path (e.g. .title, payload.refs.about); scalar raw, object/array as JSON; missing path exits non-zero')
  .option('--stats', 'render computed signals for this piece (display-only; open registry — first: append-accretion). Cards and records.')
  .action(async (ref, opts) => {
    if (opts.path && opts.stats) throw new Error('card: pass --path OR --stats, not both');
    const { board, dir } = await openCtx();

    // --stats: presentation-edge read-model over any knowledge piece (card or record).
    // Computed at the edge — never mutates the store or the domain object. See stats.js.
    if (opts.stats) {
      const piece = await resolvePiece({ board, dir }, ref);
      if (!piece) { console.log(`(no card or record matching "${ref}")`); process.exitCode = 1; return; }
      // Inject the accretion count folded from the log — the same fold the elaborate
      // nudge and lintShape read (stats stays a pure edge computation).
      const pieceKey = piece.kind === 'record' ? (piece.record.curie ?? piece.record.path) : piece.card.id;
      const accretion = foldAccretion(await board.events()).get(pieceKey) ?? 0;
      console.log(renderStats(piece, computeStats(piece, { accretion })));
      return;
    }

    const c = await board.card(ref);
    // presentation-only: a clickable link for this card. linkScheme config picks
    // who opens any knowledge piece — the viewer (kanbento://) or the OS default
    // app (file://, bound pieces only: nothing on disk means nothing to open).
    let link;
    if (c) {
      if (homeConfig().linkScheme === 'file') {
        if (c.binding?.path) link = pathToFileURL(join(dir, c.binding.path)).href;
      } else {
        link = `kanbento://${c.slug}@${c.id.slice(0, 8)}`;
      }
    }
    const out = c && (link ? { ...c, link } : c);
    if (opts.path) {
      // Project against the same object full-card would print (incl. presentation link).
      if (!out) { process.exitCode = 1; return; }
      const hit = resolveDotPath(out, opts.path);
      if (!hit.found) { process.exitCode = 1; return; }
      console.log(formatProjected(hit.value));
      return;
    }
    if (!out) { process.exitCode = 1; return console.log(`(no card matching "${ref}")`); }
    console.log(JSON.stringify(out, null, 2));
  });

program
  .command('elaborate')
  .argument('<ref>', 'card or record to give a body — a card materializes its doc on first use; a record (e.g. a capability) accretes')
  .argument('[text...]', 'inline body (or use -F / piped stdin; or none, to open $EDITOR on the doc)')
  .summary('append a body onto a card (a bound doc) or record — materialized on demand; --replace rewrites instead (deliberate consolidation); --slug re-pins the handle')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin)')
  .option('--replace', 'rewrite the body, dropping the prior one — the deliberate-rewrite path (default appends; a record keeps its frontmatter)')
  .option('--title <text>', "correct the title in the same breath — titles rot as understanding improves (a card: appends CardRetitled, the doc's frontmatter follows; a record: written to its frontmatter, witnessed by the Elaborated event)")
  .option('--slug <slug>', "pin an explicit handle — re-pins the card's slug@id (mirrors capture --slug; overrides a prior pin; collision fails loud; renames the bound doc; emits CardSlugged)")
  .action(act(async ({ board, dir }, ref, text, opts) => {
    // A naming-only invocation (--title/--slug, no inline text, no -F) has no body
    // operand, so stdin is not ours to read: in `while read … done < map.tsv` the fd
    // belongs to the loop, and slurping it both appends garbage and starves the loop.
    // Body-from-stdin keeps its explicit spelling: `elaborate <ref> --title X -F -`.
    const naming = Boolean((opts.title || opts.slug) && !opts.bodyFile && !(text && text.length));
    const content = resolveBody(text, opts, { noEditor: true, noStdin: naming }); // file / inline / stdin (the editor path is in-place, below)
    // --title / --slug alone are valid (correction without a body write); only open
    // $EDITOR when nothing was named at all.
    const interactive = !content.trim() && !opts.title && !opts.slug && process.stdin.isTTY;
    if (!content.trim() && !opts.title && !opts.slug && !interactive) {
      throw new Error('elaborate: no body (inline text, -F <file>, piped stdin, --title, --slug, or run it on a terminal to open $EDITOR)');
    }
    const res = await elaborateCard({ board, dir }, ref, content, { title: opts.title, replace: opts.replace });
    if (res.record) { // a record (position) accretes; --title now follows via frontmatter (no reslug)
      if (opts.slug) throw new Error('elaborate: --slug is a card-only re-pin; a record is named by its filename / CURIE');
      // Interactive $EDITOR only when NOTHING was named — no body write AND no --title.
      // A title-only retitle already happened (wrote:false, retitled:true); never edit.
      if (!res.wrote && !opts.title) { editFile(resolve(dir, res.rel)); return; }
      // Append-drift nudge (note:append-drift): once a record already carries accretion
      // (this is its 2nd+ append since the last consolidation), name the count and point
      // at --replace. Advisory text only — same exit code, no prompt. First append on a
      // clean/consolidated record (accretion < 2) prints nothing extra. A retitle never
      // accretes, so it carries no nudge.
      const nudge = res.accretion >= 2
        ? `  (${ordinal(res.accretion)} trailing append on this record; consider --replace to consolidate)`
        : '';
      const body = res.wrote ? (res.replaced ? '  (replaced)' : '  (appended)') : '';
      console.log(`elaborated ${res.record.curie} → ${res.rel}${body}${res.retitled ? '  (retitled)' : ''}${nudge}`);
      return;
    }
    let { card, rel, wrote, retitled, replaced } = res;
    // Explicit --slug: the deliberate re-pin (mirrors capture --slug). Sacred —
    // overrides a prior pin, collision fails loud, renames the bound doc, emits
    // CardSlugged. Runs after body/title so the doc exists to rename.
    let reslugged = false;
    if (opts.slug) {
      const was = card.slug;
      const { updated, path: newPath } = await applyReslug({ board, dir }, card, opts.slug, { pinned: true });
      card = updated;
      if (newPath) rel = newPath;
      reslugged = card.slug !== was;
    }
    // Interactive editor only when nothing else was named (no body, title, or slug).
    if (!wrote && !opts.title && !opts.slug) editFile(resolve(dir, rel));
    const onlyFlags = !wrote && (opts.title || opts.slug);
    console.log(`elaborated \`${handle(card)}\` → ${rel}${wrote ? (replaced ? '  (replaced)' : '  (appended)') : onlyFlags ? '' : '  (edited)'}${retitled ? '  (retitled)' : ''}${reslugged ? `  (slug → ${card.slug})` : ''}`);
    if (retitled && !opts.slug) {
      // The framing shifted — let the semantic slug catch up. Title is now
      // operator-pinned (CardRetitled just landed); naming applies slug only.
      const events = await board.events();
      if (!slugIsPinned(events, card.id)) fireNaming(card.id, dir);
    }
  }));

program
  .command('reaffirm')
  .argument('<ref>', 'the record to reaffirm — its CURIE (e.g. capability:relations) or a bare slug; a flow card errors (its verification is its done gate)')
  .summary('record a verification: the record was checked against the scope and still holds — stamps verified: git:<sha> (or date: fallback)')
  .action(act(async ({ board, dir }, ref) => {
    const { record, verified } = await reaffirmCard({ board, dir }, ref);
    console.log(`reaffirmed ${record.curie} → verified: ${verified}`);
  }));

program
  .command('graduate')
  .argument('<ref>', 'the record to graduate — its CURIE (e.g. procedure:issue-dedup) or a bare slug; a flow card errors (its status is its stage)')
  .argument('<status>', 'the target status — validated against the record type\'s declared vocabulary (e.g. draft → trusted)')
  .summary('graduate a record\'s status through the CLI, appending an identity-stamped RecordGraduated event — the audit trail a bare frontmatter edit lacks (who armed it, when)')
  .action(act(async ({ board, dir }, ref, status) => {
    const { record, from, to, changed } = await graduateRecord({ board, dir }, ref, status);
    if (!changed) console.log(`${record.curie} is already \`${to}\` — no change`);
    else console.log(`graduated ${record.curie}: ${from ?? '∅'} → ${to}`);
  }));

program
  .command('scope')
  .argument('<ref>', 'the card to scope — a handle (slug@id), slug, id, or prefix')
  .argument('[s]', 'the scope id — validated against the board vocabulary (not unscoped; * is star-scope, not this card). Omit to HEAL: place the bound doc at the template for the card\'s current scope (unscoped → data/cards/)')
  .summary('assign or reassign a card\'s product scope and move the bound doc; omit the value to heal placement for the current scope')
  .action(act(async ({ board, dir }, ref, s) => {
    const res = await scopeCard({ board, dir }, ref, s);
    const h = handle(res.card);
    if (!res.changed) {
      if (s) console.log(`${h} is already @${res.scope}${res.path ? ` → ${res.path}` : ''} — no change`);
      else console.log(`${h} is already placed${res.path ? ` at ${res.path}` : ''} — no change`);
      return;
    }
    const chip = res.scope ? `@${res.scope}` : 'unscoped';
    const from = res.from ? `@${res.from}` : 'unscoped';
    const moved = res.path ? ` → ${res.path}` : '';
    if (res.from === res.scope) console.log(`scoped ${h} ${chip}  (placed)${moved}`);
    else console.log(`scoped ${h}: ${from} → ${chip}${moved}`);
  }));

program
  .command('link')
  .argument('<from>', 'link FROM — a card (slug / id / CURIE / prefix) or a knowledge record (its CURIE, e.g. note:prior-art)')
  .argument('<rel>', 'the relation, e.g. blocks, sibling, about, or a vocabulary name (supports -> epistemic.supports)')
  .argument('<to>', 'link TO — a card or record, same refs')
  .summary('connect two knowledge pieces with a typed relation — cards and records alike (no body needed)')
  .action(act(async ({ board, dir }, from, rel, to) => {
    const res = await linkRefs({ board, dir }, from, rel, to);
    const fromLabel = res.kind === 'card' ? handle(res.from) : res.from.curie;
    const where = res.kind === 'record' ? (res.wrote === false ? '  (already linked)' : '  (frontmatter)') : '';
    console.log(`linked ${fromLabel}  --${res.rel}-->  ${res.target}${where}`);
  }));

program
  .command('unlink')
  .argument('<from>', 'unlink FROM — a card (slug / id / CURIE / prefix) or a knowledge record (its CURIE, e.g. note:prior-art)')
  .argument('<rel>', 'the relation to retract, e.g. blocks, sibling, about, or a vocabulary name (supports -> epistemic.supports)')
  .argument('<to>', 'unlink TO — a card or record, same refs')
  .summary('disconnect two knowledge pieces — retract a typed relation (idempotent; a no-op if absent)')
  .action(act(async ({ board, dir }, from, rel, to) => {
    const res = await unlinkRefs({ board, dir }, from, rel, to);
    const fromLabel = res.kind === 'card' ? handle(res.from) : res.from.curie;
    const gone = res.kind === 'record' ? res.wrote !== false : res.removed;
    const where = res.kind === 'record' && gone ? '  (frontmatter)' : '';
    const note = gone ? '' : '  (no such edge)';
    console.log(`unlinked ${fromLabel}  --${res.rel}-x-  ${res.target}${where}${note}`);
  }));

// Parse --check/--uncheck: single n, multi-index "1,2,3", and/or repeated flags
// (--check 1 --check 2). Commander last-wins by default; we collect repeats so
// agents that stack flags (live: website AC 1..10) don't silently check only the last.
// Returns sorted unique 1-based positions. Each toggle remains one checklistToggle event.
function parseChecklistPositions(raw, flag) {
  // collect yields string[]; a single flag stays a string; join so "1","2,3" → "1,2,3"
  const s = Array.isArray(raw) ? raw.map(String).join(',') : String(raw ?? '');
  if (!/^\d+(,\d+)*$/.test(s)) {
    throw new Error(`checklist: --${flag} takes a 1-based position, comma multi-index (1,2,3), or repeated flags (--check 1 --check 2), got "${Array.isArray(raw) ? raw.join(' ') : raw}"`);
  }
  const positions = s.split(',').map((p) => Number(p));
  for (const pos of positions) {
    if (!Number.isInteger(pos) || pos < 1) {
      throw new Error(`checklist: --${flag} takes a 1-based position, comma multi-index (1,2,3), or repeated flags (--check 1 --check 2), got "${Array.isArray(raw) ? raw.join(' ') : raw}"`);
    }
  }
  return [...new Set(positions)].sort((a, b) => a - b);
}

// Accumulate repeated --check / --uncheck (Commander otherwise keeps only the last value).
function collectChecklistIndex(value, previous) {
  return (previous ?? []).concat(value);
}

program
  .command('checklist')
  .argument('<ref>', 'the card (slug / id / CURIE / prefix)')
  .argument('[list]', 'list name (e.g. "Acceptance Criteria"); omit to read every list; for toggle/retract flags: optional when the card has exactly one list, required when ≥2')
  .argument('[items...]', 'inline whole-text — checkbox (`- [ ]` / `- [x]`) or plain one-per-line (open items); full desired list — restate existing non-retracted items + newcomers (restating keeps ticks); or -F / stdin')
  .summary('a card\'s named checklists — append-only registers of boolean status items (open↔done) with optional discard (--retract); whole-text restates active items + newcomers (preserves ticks; no hard-delete), --check/--uncheck by stable index, --check-all/--uncheck-all, --retract discards a criterion from the contract, read, and --incomplete gate')
  .option('-F, --body-file <path>', 'read the full desired list from a file (- for stdin): plain one-per-line (each line = open item) OR markdown checkboxes (`- [ ]` / `- [x]`); when any checkbox line is present only those count (prose ignored); restate active items + append newcomers (ticks preserved)')
  .option('--check <n>', 'set boolean done=true at 1-based n — repeatable and/or comma multi-index (1,2,3); merge-safe; list name defaults to the sole list when the card has exactly one', collectChecklistIndex)
  .option('--uncheck <n>', 'set boolean done=false at 1-based n — repeatable and/or comma multi-index (1,2,3); sole-list default applies', collectChecklistIndex)
  .option('--check-all', 'check every active item in the named list (or sole list when name omitted)')
  .option('--uncheck-all', 'uncheck every active item in the named list (or sole list when name omitted)')
  .option('--retract <n>', 'discard item(s) at 1-based n — the discard form of the boolean carrier: criterion left the contract (wrong, not merely unmet); append-only soft-discard; out of --incomplete/open; still rendered [~]; not uncheck, not hard-delete; multi-index + sole-list default', collectChecklistIndex)
  .option('--incomplete', 'gate query — exit nonzero if any active (non-discarded) item is unchecked (named list: that list must exist; unnamed: every list on the card; no lists → complete — require a name when a recipe needs a specific list)')
  .action(async (ref, list, items, opts) => {
    const { board, dataDir } = await openCtx();
    const wantCheck = opts.check != null;
    const wantUncheck = opts.uncheck != null;
    const wantCheckAll = !!opts.checkAll;
    const wantUncheckAll = !!opts.uncheckAll;
    const wantRetract = opts.retract != null;
    const wantWrite = opts.bodyFile != null || (items && items.length);

    // --incomplete: exit code IS the answer. Mechanism is name-agnostic; recipes
    // that need "Acceptance Criteria" (or any list) must pass that name.
    if (opts.incomplete) {
      const card = await board.card(ref);
      if (!card) throw new Error(`checklist: no card matching "${ref}"`);
      const { ok, open, missing } = incompleteReport(card.checklists, list ?? null);
      if (!ok) {
        const bits = [];
        if (missing.length) bits.push(`${missing.length} missing/empty list(s)`);
        if (open.length) bits.push(`${open.length} unchecked`);
        console.error(`incomplete — ${bits.join(', ')}:`);
        for (const m of missing) console.error(`  - (no "${m}" list — seed with: kanbento checklist <card> "${m}" -F <file>)`);
        for (const o of open) console.error(`  - ${o}`);
        process.exitCode = 1;
      } else {
        console.log(list ? `"${list}" complete` : 'no incomplete items');
      }
      return;
    }

    if (wantRetract && (wantCheck || wantUncheck || wantCheckAll || wantUncheckAll)) {
      throw new Error('checklist: pass --retract alone, not mixed with --check/--uncheck/--check-all/--uncheck-all');
    }

    if (wantRetract) {
      // Sole-list default (same as --check): name optional when the card has exactly one list.
      let listName = list;
      let cardForList = null;
      if (!listName) {
        cardForList = await board.card(ref);
        if (!cardForList) throw new Error(`checklist: no card matching "${ref}"`);
        const names = Object.keys(cardForList.checklists ?? {});
        if (names.length === 1) listName = names[0];
        else if (names.length === 0) {
          throw new Error('checklist: no lists on this card to retract — seed one with: kanbento checklist <card> <list> ...');
        } else {
          throw new Error(`checklist: name the list to retract (${names.map((n) => `"${n}"`).join(', ')}) — checklist <card> <list> --retract <n>`);
        }
      }
      const positions = parseChecklistPositions(opts.retract, 'retract');
      const changed = [];
      const already = [];
      let lastCard = null;
      for (const pos of positions) {
        const res = await board.checklistRetract(ref, listName, pos - 1);
        lastCard = res.card;
        if (res.changed) changed.push(pos);
        else already.push(pos);
      }
      await rematerialize(board, dataDir);
      const fmt = (xs) => xs.map((n) => `#${n}`).join(', ');
      if (changed.length && already.length) {
        console.log(`retracted "${listName}" ${fmt(changed)} on \`${handle(lastCard)}\` (${fmt(already)} already retracted)`);
      } else if (changed.length) {
        console.log(`retracted "${listName}" ${fmt(changed)} on \`${handle(lastCard)}\``);
      } else {
        console.log(`"${listName}" ${fmt(already)} already retracted  (no-op)`);
      }
      return;
    }

    if (wantCheck || wantUncheck || wantCheckAll || wantUncheckAll) {
      const checkSide = (wantCheck ? 1 : 0) + (wantCheckAll ? 1 : 0);
      const uncheckSide = (wantUncheck ? 1 : 0) + (wantUncheckAll ? 1 : 0);
      if (checkSide && uncheckSide) throw new Error('checklist: pass --check/--check-all OR --uncheck/--uncheck-all, not both');
      if (wantCheck && wantCheckAll) throw new Error('checklist: pass --check OR --check-all, not both');
      if (wantUncheck && wantUncheckAll) throw new Error('checklist: pass --uncheck OR --uncheck-all, not both');
      const done = wantCheck || wantCheckAll;
      // Sole-list default: when the card has exactly one list, the name is optional.
      // Zero lists → clear error; ≥2 → require the name (list the available ones).
      let listName = list;
      let cardForList = null;
      if (!listName || wantCheckAll || wantUncheckAll) {
        cardForList = await board.card(ref);
        if (!cardForList) throw new Error(`checklist: no card matching "${ref}"`);
      }
      if (!listName) {
        const names = Object.keys(cardForList.checklists ?? {});
        if (names.length === 1) listName = names[0];
        else if (names.length === 0) {
          throw new Error('checklist: no lists on this card to toggle — seed one with: kanbento checklist <card> <list> ...');
        } else {
          throw new Error(`checklist: name the list to toggle (${names.map((n) => `"${n}"`).join(', ')}) — checklist <card> <list> --check <n>`);
        }
      }
      let positions;
      if (wantCheckAll || wantUncheckAll) {
        const itemsInList = cardForList.checklists?.[listName];
        if (!itemsInList || !itemsInList.length) throw new Error(`checklist: card has no "${listName}" list`);
        positions = itemsInList.map((_, i) => i + 1);
      } else {
        positions = parseChecklistPositions(done ? opts.check : opts.uncheck, done ? 'check' : 'uncheck');
      }
      // One checklistToggle per index — each event stays merge-safe; batch is a CLI loop.
      const changed = [];
      const already = [];
      let lastCard = null;
      for (const pos of positions) {
        const res = await board.checklistToggle(ref, listName, pos - 1, done);
        lastCard = res.card;
        if (res.changed) changed.push(pos);
        else already.push(pos);
      }
      await rematerialize(board, dataDir);
      const label = done ? 'checked' : 'unchecked';
      const fmt = (xs) => xs.map((n) => `#${n}`).join(', ');
      if (changed.length && already.length) {
        console.log(`${label} "${listName}" ${fmt(changed)} on \`${handle(lastCard)}\` (${fmt(already)} already ${label})`);
      } else if (changed.length) {
        console.log(`${label} "${listName}" ${fmt(changed)} on \`${handle(lastCard)}\``);
      } else {
        console.log(`"${listName}" ${fmt(already)} already ${label}  (no-op)`);
      }
      return;
    }

    if (wantWrite) {
      if (!list) throw new Error('checklist: name the list to write — checklist <card> <list> -F <file>');
      const text = opts.bodyFile != null ? resolveBody([], opts, { noEditor: true }) : items.join('\n');
      const desired = parseChecklistItems(text);
      if (!desired.length) throw new Error('checklist: no items parsed — write plain one-per-line text, or the `- [ ] text` / `- [x] text` checkbox grammar');
      const res = await board.checklistWrite(ref, list, desired);
      await rematerialize(board, dataDir);
      const added = res.events.filter((e) => e.type === 'ChecklistItemAdded').length;
      const checked = res.events.filter((e) => e.type === 'ChecklistItemChecked').length;
      // Unchecked is no longer derived from whole-text (preserve ticks); keep for honesty if any
      // other path ever injects it into the same events list.
      const unchecked = res.events.filter((e) => e.type === 'ChecklistItemUnchecked').length;
      const bits = [added && `+${added} added`, checked && `${checked} checked`, unchecked && `${unchecked} unchecked`].filter(Boolean);
      console.log(`checklist "${list}" on \`${handle(res.card)}\`${bits.length ? ' — ' + bits.join(', ') : ' — no change'}`);
      const rendered = renderChecklists(res.card.checklists, list);
      if (rendered) console.log('\n' + rendered);
      return;
    }

    // read — every list, or a named one
    const card = await board.card(ref);
    if (!card) throw new Error(`checklist: no card matching "${ref}"`);
    const rendered = renderChecklists(card.checklists, list ?? null);
    console.log(rendered || (list ? `"${list}" is empty` : 'no checklists on this card'));
  });

// Case-based decisioning — one namespace, two critical paths: `retain` a precedent, and read
// the `taxonomy` (the default) to classify against. No "list the cases": the taxonomy hands
// over each category's file path and the agent opens it (cases-as-files, the LLM reads).
const cases = program
  .command('cases')
  .summary('case-based decisioning — retain precedents, read the taxonomy to reason from');

cases
  .command('taxonomy', { isDefault: true })
  .summary('the taxonomy: decision categories + when each applies (the map to classify against)')
  .action(async () => {
    const { dir } = await openCtx();
    const tax = await caseTaxonomy(dir);
    if (!tax.length) return void console.log('(no cases yet — retain the first with: kanbento cases retain <category> --when "..." --why "...")');
    console.log(`# case taxonomy · ${tax.length} categor${tax.length === 1 ? 'y' : 'ies'}\n`);
    for (const c of tax) {
      console.log(`- \`${c.slug}\` [${c.count}]  → ${c.path}`);
      if (c.when) console.log(`    when: ${c.when}`);
    }
  });

cases
  .command('retain <category>')
  .summary('record a decision as a precedent under a case category')
  .option('--why <text>', 'the rationale — the payload; why this rule applied here')
  .option('--situation <text>', 'the board features the decision turned on (the projection, not the whole board)')
  .option('--rel <pair...>', 'typed citation key=<ref> — the precedent\'s graph edges (e.g. about=capability:x · about=card-slug); one spelling with capture/note. Written to the case file\'s frontmatter refs so backlinks/maps surface the precedent')
  .option('--when <text>', 'for a NEW category: the criterion that says when this precedent class applies')
  .action(async (category, opts) => {
    const { board, dir } = await openCtx();
    const at = new Date().toISOString().slice(0, 10);
    const id = randomUUID().slice(0, 6); // a stable handle per precedent (the date alone collides)
    let refs = refsFromArgs(opts.rel);
    if (refs) refs = await resolveRelTargets({ board, dir }, refs); // bare handles → stable stored CURIE, as capture/link do
    const res = await retainCase(dir, { category, at, id, why: opts.why, situation: opts.situation, when: opts.when, refs });
    if (res.deduped) return void console.log(`already recorded — identical precedent under \`case:${res.slug}\`; nothing added (${res.count} total)`);
    console.log(`${res.created ? 'new category' : 'retained'} \`case:${res.slug}\` → ${res.path}  (${res.count} precedent${res.count === 1 ? '' : 's'})`);
    console.log(res.block.trimEnd().split('\n').map((l) => `  ${l}`).join('\n')); // echo what was filed — the human verifies their reason was captured
  });

program
  .command('procedures')
  .summary("list the board's procedures — executable knowing-how, discoverable by any agent")
  .action(async () => {
    const { board, dir } = await openCtx();
    const skills = await listSkills({ board, dir });
    if (!skills.length) return void console.log('no procedures — author one with `kanbento note --type procedure`');
    for (const s of skills) {
      // One clock: last-ran is the ProcedureInvoked fold above (a scheduled fire now witnesses
      // it too), so the ⏰ marker carries only the rhythm, not a second, contradictable stamp.
      const sched = s.schedule ? ` · ⏰ daily ${s.schedule.at}` : '';
      // Origin badge: a built-in ships with the tool; a harness skill was discovered in a harness
      // dir (e.g. .grok/skills); a bare local record shows neither.
      const origin = s.builtin ? ' · builtin' : s.harness ? ` · skill @ ${s.harness}` : '';
      // The run witness: runner invocations leave a dir under .kanbento/runs/<slug>/ —
      // count them in. 0 runs shows nothing extra (the last-ran clock already speaks).
      const runs = s.runs?.count ? ` · ${s.runs.count} run${s.runs.count === 1 ? '' : 's'}` : '';
      console.log(`${s.curie}${s.status ? ` · ${s.status}` : ''}${origin} · ${lastRanLabel(s.lastRan ?? s.runs?.last)}${runs}${s.due ? ' · DUE' : ''}${sched}`);
    }
    console.log(`\n${skills.length} procedure(s) — run one with: kanbento do <name>`);
  });


// Finalize one run — the shared dispose path behind `do --finalize` and `--exec`.
// The kernel-facing bits (capture, rematerialize) live here; runner.js stays pure
// mechanics. A file-form run has no SKILL.md copy, so the SOURCE record's current
// frontmatter stands in as the manifest (the folder form always reads its copy).
async function finalizeProcedureRun({ board, dir, dataDir, rec, slug, runDir, dryRun, safe }) {
  let record = null;
  if (!existsSync(join(runDir, 'SKILL.md')) && rec.path && existsSync(resolve(dir, rec.path))) {
    record = (await readFrontmatter(resolve(dir, rec.path))).data;
  } else if (!existsSync(join(runDir, 'SKILL.md'))) {
    record = rec; // a built-in / harness record — the resolved record carries its frontmatter fields
  }
  let captured = false;
  const res = await finalizeRun({
    boardDir: dir, runDir, slug, record, dryRun, safe,
    // The observe disposition IS a board capture — routed through captureCard so the
    // inbox event, the bound doc, and the source lineage all land the standard way.
    capture: async ({ title, body, source }) => {
      const { card } = await captureCard({ board, dir }, body, { title, source: source ?? 'agent', richBody: true });
      captured = true;
      return card;
    },
  });
  if (captured) await rematerialize(board, dataDir);
  if (res.mode === 'dry') console.log(`dry run: would ${res.wouldHave} — disposition.json written, nothing else touched (${runDir})`);
  else if (res.mode === 'observe') console.log(`disposed (observe): captured \`${handle(res.captured)}\` from ${res.manifest ? Object.keys(res.manifest).length : 0} artifact(s)`);
  else console.log(`disposed (effect): hooks/finalize exited 0 — disposition recorded (${runDir})`);
  return res;
}

program
  .command('do')
  .argument('<name>', 'procedure to serve — its slug or CURIE (e.g. curation-pass or procedure:curation-pass)')
  .argument('[pairs...]', "params as key=value — validated against the procedure's declared params: block (env KANBENTO_PARAM_<KEY> also binds; CLI wins)")
  .summary("print a procedure — params interpolate (key=value), an init hook runs first, declared artifacts state the contract; --exec runs the harness sandboxed end-to-end (one validation retry), --finalize validates + disposes a run (observe/dry/effect by status + flags)")
  .option('--finalize [runRef]', 'validate + dispose an existing run instead of compiling a new one — a run-dir timestamp or prefix; default: the latest run')
  .option('--exec [cmd]', 'the full lifecycle in one process: compile → spawn the harness on the prompt → validate artifacts (one retry) → finalize; cmd e.g. "claude -p" (prompt appended as the final argument; else KANBENTO_RUNNER, else config.json `runner` — e.g. in CI: kanbento do issue-dedup issue=${{ inputs.issue_number }} --exec "claude -p")')
  .option('--dry-run', 'finalize records what it WOULD do into the run dir (disposition.json) and touches nothing else — diffable across runs')
  .option('--safe', "cap the disposition at observe even for a trusted procedure (and, under --exec, strip the procedure's declared network — the harness profile's survives)")
  .option('--no-sandbox', 'run --exec without the OS sandbox (loud warning)')
  .action(async (name, pairsRaw, opts) => {
    const { board, dir, dataDir } = await openCtx();
    // `--exec [cmd]` is optional-value, so commander can swallow a FOLLOWING pair as its
    // value (`do x --exec issue=1`). Reclaim by shape: a pair has '=' and no whitespace;
    // a harness command has whitespace (or no '='). Same idiom as reclaimVariadic.
    if (typeof opts.exec === 'string' && /^[^\s=]+=/.test(opts.exec) && !/\s/.test(opts.exec)) {
      pairsRaw = [...(pairsRaw ?? []), opts.exec];
      opts.exec = true;
    }
    // The trailing variadic reuses the pair grammar: every token must LOOK like a pair
    // (shape-detected — see reclaimVariadic); there is no positional text to recover into.
    const { pairs } = reclaimVariadic(pairsRaw, { label: 'do', sep: ['='], recover: false });
    const rec = await resolveProcedure({ board, dir }, name);
    const slug = parseCurie(rec.curie)?.slug ?? name;
    if (opts.finalize !== undefined && opts.exec !== undefined) {
      throw new Error('do: --finalize and --exec are exclusive — --exec already finalizes its own run');
    }
    // --finalize disposes a run that ALREADY happened — params belong to the next one.
    if (opts.finalize !== undefined) {
      if (pairs?.length) throw new Error(`do --finalize: params belong to a new run, not a finished one — drop ${pairs.map((p) => `"${p}"`).join(' ')}`);
      const runDir = await resolveRunDir(dir, slug, typeof opts.finalize === 'string' ? opts.finalize : null);
      await finalizeProcedureRun({ board, dir, dataDir, rec, slug, runDir, dryRun: opts.dryRun, safe: opts.safe });
      return;
    }
    const declared = declaredParams(rec);
    if (pairs?.length && declared == null) {
      throw new Error(`do: ${rec.curie ?? name} is parameterless — it declares no params: block; drop ${pairs.map((p) => `"${p}"`).join(' ')}`);
    }
    // The RUNNER engages only for a folder-form procedure or one declaring params —
    // a bare legacy `do <file-procedure>` keeps the serve path byte-for-byte (no run dir).
    if (!(rec.folder || declared != null)) {
      if (opts.exec !== undefined) throw new Error(`do --exec: ${rec.curie ?? name} does not engage the runner (no folder form, no params: block) — --exec needs a run dir to contract on`);
      const { record, text } = await assembleProcedure({ board, dir }, name, { record: rec });
      // The invocation is a fact kanbento witnesses (the brief was served) — log it here.
      // Execution is presumed; abandonment is the exception, not the modeled case.
      if (record.curie) await board.procedureInvoked(record.curie);
      return void process.stdout.write(text);
    }
    // Validate BEFORE anything executes — a bad invocation leaves no run dir behind.
    // The artifacts declaration is checked NOW too (manifest read time): a typo'd
    // schema notation must not wait for validation time to surface.
    const params = validateParams({ declared, pairs, env: process.env, name: rec.curie ?? name });
    declaredArtifacts(rec);
    // Folder form: the run dir is a full COPY of the skill folder, so SKILL.md's relative
    // references (scripts/, references/, …) resolve beside the compiled prompt, the run is a
    // complete witness of what ran, and the hook gets a safe cwd. File form: a bare dir.
    const runDir = await createRunDir(dir, slug, { copyFrom: rec.folder ? rec.home : null });
    await writeFile(join(runDir, 'params.json'), JSON.stringify(params, null, 2) + '\n', 'utf8');
    // WORKSPACE intake (worktree mode): materialize an isolated git checkout at
    // <runDir>/repo BEFORE the init hook (so a hook may read the checkout) and
    // before the harness. This is the UNSANDBOXED setup phase, so touching the
    // board repo's .git/worktrees is fine; the checkout itself lands under the run
    // dir, already the sandbox write-floor. fs mode = no worktree, zero change.
    const workspace = declaredWorkspace(rec);
    let workspaceDir = null;
    if (workspace.mode === 'worktree') {
      try {
        const repoRoot = await findRepoRoot(dir);
        if (!repoRoot) {
          throw new Error(`procedure ${slug} declares workspace: worktree but ${dir} is not inside a git repository — worktree mode needs a repo to check out from (use workspace: fs, or run inside a git repo)`);
        }
        const branch = workspaceBranch(slug, params, params.branch ?? workspace.branch ?? null);
        const meta = await materializeWorktree({ repoRoot, worktreeDir: join(runDir, 'repo'), branch, base: workspace.base });
        workspaceDir = meta.dir;
        await writeFile(join(runDir, 'workspace.json'), JSON.stringify({ mode: 'worktree', ...meta }, null, 2) + '\n', 'utf8');
      } catch (err) {
        await writeFile(join(runDir, 'error.txt'), `${err.message}\n`, 'utf8');
        throw new Error(`do: ${err.message} — run dir kept at ${runDir} (see error.txt)`);
      }
    }
    let context = {};
    const hook = join(runDir, 'hooks', 'init');
    if (rec.folder && existsSync(hook)) { // hooks are folder-form only — the file form has no folder to hold one
      try {
        // Executed FROM THE COPY (cwd = run dir): scratch files land beside the inputs;
        // the source procedure folder is never touched. KANBENTO_WORKSPACE_DIR is set
        // in worktree mode so the hook can gather against the checkout.
        context = await runInitHook({ hook, runDir, boardDir: dir, params, workspaceDir });
      } catch (err) {
        await writeFile(join(runDir, 'error.txt'), `${err.message}\n${err.stderr ? '\n--- stderr ---\n' + err.stderr : ''}`, 'utf8');
        if (err.stderr) process.stderr.write(err.stderr);
        throw new Error(`do: ${err.message} — run dir kept at ${runDir} (see error.txt)`);
      }
      await writeFile(join(runDir, 'context.json'), JSON.stringify(context, null, 2) + '\n', 'utf8');
    }
    // Compile from the COPY's SKILL.md (folder form) so prompt.md and its body agree with
    // what sits beside it; the file form interpolates the resolved record's own body.
    const copy = rec.folder ? await readFrontmatter(join(runDir, 'SKILL.md')) : null;
    const body = copy ? copy.body : rec.body;
    let compiled = interpolate(body, { params, context, run: { dir: runDir }, ...(workspaceDir ? { workspace: { dir: workspaceDir } } : {}) });
    // A declared artifacts: block generates the ARTIFACTS contract section — after the
    // body, before the precedents/pointers footer — so the agent sees it up front.
    const artifacts = declaredArtifacts(copy ? { ...copy.data, curie: rec.curie } : rec);
    if (artifacts) compiled = `${compiled.trimEnd()}\n\n${renderArtifactsSection(artifacts, runDir)}`;
    // Disposition is a runner-injected instruction, not skill prose — and only in
    // interactive mode, where the session agent must trigger finalize itself (under
    // --exec the runner finalizes after the harness, so injecting it would double-dispose).
    if (artifacts && opts.exec === undefined) compiled = `${compiled.trimEnd()}\n\n${renderDispositionSection(slug)}`;
    const { record, text } = await assembleProcedure({ board, dir }, name, { record: { ...rec, body: compiled } });
    await writeFile(join(runDir, 'prompt.md'), text, 'utf8');
    if (record.curie) await board.procedureInvoked(record.curie);
    if (opts.exec === undefined) {
      // stdout carries ONLY the compiled document — `claude -p "$(kanbento do x issue=2403)"`
      // must receive a clean prompt; errors and status ride stderr.
      return void process.stdout.write(text);
    }
    // --exec: spawn the harness on the compiled prompt (inside the sandbox when it
    // stands), then run the SAME finalize path; an artifact-validation failure
    // re-invokes the harness ONCE with the violations appended — the retry loop
    // lives where determinism lives.
    const template = await resolveExecTemplate(typeof opts.exec === 'string' ? opts.exec : null);
    const grant = resolveGrant(rec.runner ?? null, (await readConfig()).procedures?.[slug] ?? null);
    const sandboxBlock = copy ? copy.data.sandbox ?? null : rec.sandbox ?? null;
    const box = await prepareSandbox({ template, runDir, boardDir: dir, sandbox: sandboxBlock, safe: opts.safe, disabled: opts.sandbox === false });
    // FAIL-CLOSED: an EFFECT disposition must never run unconfined. The mode this
    // run WOULD reach is knowable pre-spawn (the status gate composed with the
    // flags; the artifacts don't decide observe/dry/effect). If it is `effect` and
    // the sandbox failed to stand (--no-sandbox, srt missing, unsupported platform,
    // init throw — all collapse to box.sandboxed===false), refuse BEFORE spawning
    // the harness or finalizing. observe/dry runs still proceed unsandboxed (no
    // effect happens — the prepareSandbox warning already fired).
    const runStatus = (copy ? copy.data.status : rec.status) ?? null;
    const { mode: wouldMode } = effectiveDisposition({ status: runStatus, dryRun: opts.dryRun, safe: opts.safe });
    if (wouldMode === 'effect' && !box.sandboxed) {
      await box.reset();
      throw new Error(
        `do --exec: refusing to run a trusted (effect) procedure UNSANDBOXED — an effect must never run unconfined. ` +
        `Fix one of: install the OS sandbox (npm i @anthropic-ai/sandbox-runtime) and run on a supported platform; ` +
        `or drop the effect for this run (--dry-run, --safe, or a draft-status procedure). ` +
        `--no-sandbox is only valid for non-effect (observe/dry) runs.`,
      );
    }
    try {
      let prompt = text;
      for (let attempt = 1; ; attempt++) {
        const code = await runShell(await box.wrap(assembleRunner(template, grant, prompt)), runDir, harnessEnv(template));
        if (code !== 0) throw new Error(`do --exec: harness exited ${code} — run dir kept at ${runDir}`);
        try {
          await finalizeProcedureRun({ board, dir, dataDir, rec, slug, runDir, dryRun: opts.dryRun, safe: opts.safe });
          return;
        } catch (err) {
          if (!err.violations || attempt >= 2) throw err; // max 1 retry; non-validation errors never retry
          process.stderr.write(`do --exec: artifact validation failed — re-invoking the harness once\n`);
          prompt = `${text}\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${err.violations.map((v) => `- ${v}`).join('\n')}\nFix the artifacts.`;
        }
      }
    } finally {
      await box.reset();
    }
  });

program
  .command('schedule')
  .argument('[procedure]', 'procedure to schedule (slug or CURIE); omit to list current schedules')
  .summary("project a procedure's cadence into the OS scheduler (launchd); --fire is the scheduled entry point (guard + headless agent run, halts at the consent gate)")
  .option('--at <HH:MM>', 'time of day to fire (default 09:00)')
  .option('--remove', 'deregister the schedule')
  .option('--fire', 'the scheduled entry point — guard, then run the routine headless (invoked by launchd)')
  .action(async (procedure, opts) => {
    if (opts.fire) {
      // launchd invokes jobs with cwd `/` — no board is resolvable there. The plist passes the
      // fire key (the state file's own basename), so the fire locates its board-qualified state
      // and runs in the owning board root (read from that state). A human firing a bare slug from
      // inside a board gets a best-effort boardId so the qualified state still resolves.
      if (!procedure) throw new Error('schedule --fire: a procedure is required');
      let boardId = null;
      try { const { board } = await openCtx(); boardId = board.manifest?.board?.id ?? null; }
      catch { /* launchd fires from / — no board there */ }
      const res = await fireSchedule({}, procedure, { boardId });
      if (res.skipped) console.log(`${res.slug}: ${res.reason}`);
      else if (res.failed && !res.ran) { console.error(`${res.slug}: ${res.reason}`); process.exitCode = 1; }
      else if (!res.ran) console.log(`${res.slug}: ${res.reason}`);
      else if (res.failed) { console.error(`${res.slug}: run failed (exit ${res.exitCode}) — lastRun untouched`); if (res.hint) console.error(res.hint); process.exitCode = 1; }
      else console.log(`${res.slug}: ran — lastRun stamped${res.witnessed ? ' + witnessed on the board' : ''}`);
      return;
    }
    const { board, dir } = await openCtx();
    if (!procedure) {
      const list = await annotateSchedules({ board, dir });
      if (!list.length) return void console.log('no schedules — register one with: kanbento schedule <procedure>');
      for (const s of list) {
        const g = s.grant ? `  ·  ${grantSummary(s.grant)}` : '';
        const warn = s.drifted ? '  ⚠ declaration changed — re-register' : '';
        const legacy = s.legacy ? '  ⚠ legacy (no board identity)' : '';
        console.log(`${s.procedure}  ·  ${s.cadence}  ·  at ${s.at}  ·  ${s.lastRun ? 'last run ' + s.lastRun.slice(0, 10) : 'never run'}${g}${warn}${legacy}`);
      }
      console.log(`\n${list.length} schedule(s)`);
      for (const s of list.filter((x) => x.legacy)) {
        console.log(`  hint: ${s.procedure} predates board-scoped schedules — re-run \`kanbento schedule ${s.procedure} --at ${s.at}\` to migrate it`);
      }
      return;
    }
    if (opts.remove) {
      const res = await removeSchedule({ board, dir }, procedure);
      console.log(res.removed ? `deregistered ${res.slug} — plist + state removed` : `${res.slug}: not scheduled (nothing to remove)`);
      return;
    }
    const res = await registerSchedule({ board, dir }, procedure, { at: opts.at });
    for (const n of res.notes) console.log(`  note: ${n}`);
    console.log(`scheduled ${res.curie} · daily at ${res.at} → ${res.plist}`);
    if (res.migrated) console.log(`  migrated a legacy (board-less) schedule for ${res.slug} — old plist unloaded, board-scoped state written`);
    console.log(`  ${res.grantLine}`); // the frozen grant — registering is the consent act, so name what was granted
    console.log(`  launchd ${res.bootstrapped ? 'bootstrapped' : 'bootstrap reported an issue — check `launchctl print gui/<uid>`'}`);
    if (res.stamped) console.log(`  stamped \`schedule: daily @ ${res.at}\` into the record frontmatter`);
  });

program
  .command('watch')
  .argument('[ref]', 'card to watch on — handle slug@id, or a bare id, slug, CURIE, or unique prefix (omit to list)')
  .argument('[question...]', "the matcher's condition (natural language) — required to register a watch")
  .summary('stand an observation on external state; a check fetches → diffs → matches, emitting only silence or an inbox capture')
  .option('--on <namespace:id>', `the referent to watch — rung 1 supports: ${SUPPORTED_NAMESPACES.join(', ')} (e.g. github:owner/repo#12)`)
  .option('--clear', 'clear the watch named by <ref> --on (idempotent no-op if absent)')
  .option('--check', 'run the check pipeline over every active watch (fetch → diff → match)')
  .action(async (ref, question, opts) => {
    const { board, dir, dataDir } = await openCtx();

    // --check: run the pipeline over every active watch. Silence is the default; a hit lands
    // an inbox capture (which changes the board), so rematerialize after.
    if (opts.check) {
      const results = await checkWatches({ board, dir });
      if (!results.length) return void console.log('no active watches — register one with: kanbento watch <ref> --on <namespace:id> "<question>"');
      let hits = 0;
      for (const r of results) {
        const h = handle(await board.card(r.watch.cardId)) ?? r.watch.cardId.slice(0, 8);
        if (r.status === 'hit') { hits++; console.log(`⬢ hit  ${h}  ${r.watch.on}  → captured ${handle(r.card)}\n      ${r.why}`); }
        else if (r.status === 'miss') console.log(`·  no  ${h}  ${r.watch.on}  (changed, condition unmet) — ${r.why}`);
        else if (r.status === 'baseline') console.log(`·  baseline  ${h}  ${r.watch.on}  (first check — snapshot stored)`);
        else if (r.status === 'unchanged') console.log(`·  unchanged  ${h}  ${r.watch.on}`);
        else if (r.status === 'error') console.log(`⚠  error  ${h}  ${r.watch.on} — ${r.error}`);
      }
      console.log(`\n${results.length} watch(es) checked${hits ? `; ${hits} hit(s) captured` : ''}`);
      if (hits) await rematerialize(board, dataDir);
      return;
    }

    // No ref (and no clear): list the active watches + their per-check state.
    if (!ref) {
      const watches = await board.watches();
      if (!watches.length) return void console.log('no active watches — register one with: kanbento watch <ref> --on <namespace:id> "<question>"');
      const state = await readWatchState(board.manifest?.board?.id);
      for (const w of watches) {
        const h = handle(await board.card(w.cardId)) ?? w.cardId.slice(0, 8);
        const s = state[stateKey(w.cardId, w.on)] ?? {};
        console.log(`${h}  ·  ${w.on}`);
        console.log(`    ? ${w.question}`);
        const bits = [];
        bits.push(s.lastChecked ? `checked ${s.lastChecked.slice(0, 10)}` : 'never checked');
        if (s.lastDiffAt) bits.push(`last change ${s.lastDiffAt.slice(0, 10)}`);
        if (s.lastVerdict) bits.push(`verdict: ${s.lastVerdict}`);
        if (s.lastError) bits.push(`⚠ ${s.lastError}`);
        console.log(`    ${bits.join('  ·  ')}`);
      }
      console.log(`\n${watches.length} active watch(es) — check them with: kanbento watch --check`);
      return;
    }

    // A ref: register or clear. Both need --on (the referent identifies the watch).
    if (!opts.on) throw new Error('watch: --on <namespace:id> is required to register or clear a watch');
    assertSupportedOn(opts.on); // rung 1 gate: github-only, named set on rejection
    if (opts.clear) {
      const res = await board.watchCleared(ref, opts.on);
      console.log(res.removed ? `cleared watch on ${handle(res.card)} · ${opts.on}` : `${opts.on}: no such watch on ${handle(res.card)} (nothing to clear)`);
      return;
    }
    const q = (question ?? []).join(' ').trim();
    const res = await board.watchSet(ref, opts.on, q); // throws if the question is empty
    console.log(`watching ${handle(res.card)} · ${res.on}`);
    console.log(`  ? ${res.question}`);
    console.log('  check it with: kanbento watch --check');
  });

program
  .command('refs')
  .argument('[curie]', 'target CURIE (type:slug) — show what points at it')
  .summary('references: backlinks to a CURIE, a card\'s forward edges (--from), or a neighborhood (--around)')
  .option('--from <ref>', "a card's outgoing edges, resolved")
  .option('--around <curie>', 'walk the graph neighborhood around a CURIE')
  .option('--depth <n>', 'neighborhood depth (with --around)', '2')
  .option('--rel <key>', 'filter to one relation (advances, evidence, about, implements, …)')
  .option('--type <type>', 'filter sources/targets to this type')
  .option('--frontier', 'list referenced-but-unresolved CURIEs, ranked by referrers — promotion candidates')
  .action(async (curie, opts) => {
    const { board, dir } = await openCtx();
    if (opts.frontier) {
      const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, title: summary(c), type: c.type, refs: c.payload?.refs }));
      const records = await loadRecords(board.manifest, dir);
      const fr = collectFrontier({ cards, records });
      if (!fr.length) return console.log('(frontier empty — every reference resolves to a record)');
      console.log('frontier · referenced but unresolved (promotion candidates)');
      for (const f of fr) console.log(`  ${f.refs}×  ${f.curie}`);
      return;
    }
    if (opts.from) {
      const piece = await resolvePiece({ board, dir }, opts.from);
      if (!piece) return console.log(`(no card or record matching "${opts.from}")`);
      const refs = piece.kind === 'card' ? piece.card.payload?.refs : piece.record.refs; // a record's frontmatter IS its forward edges
      const label = piece.kind === 'card' ? `${piece.card.id.slice(0, 8)} "${summary(piece.card)}"` : `${piece.record.curie} "${piece.record.title}"`;
      const edges = forwardEdges(board.manifest, refs, { rel: opts.rel, type: opts.type });
      if (!edges.length) return console.log(`${label} — no outgoing refs`);
      console.log(`forward · ${label}`);
      const known = new Set((await loadRecords(board.manifest, dir)).map((r) => r.curie));
      for (const c of await board.pool()) for (const h of cardHandles(c)) known.add(h); // card→card edges resolve to cards
      for (const e of edges) console.log(`  ${e.rel}  ${e.curie}  ${await resolveMark(e.target, dir, known)}`);
      return;
    }
    const target = opts.around ?? curie;
    if (!target) throw new Error('refs: give a <curie>, or --from <ref>, or --around <curie>');
    const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, title: summary(c), type: c.type, state: c.state, refs: c.payload?.refs }));
    const records = await loadRecords(board.manifest, dir);
    if (opts.around) return printNeighborhood(neighborhood({ cards, records }, board.manifest, target, { depth: Number(opts.depth) || 2, rel: opts.rel }));
    const { groups, total } = collectBacklinks({ cards, records }, target, { rel: opts.rel, type: opts.type });
    const rec = records.find((r) => r.curie === target);
    const kids = records.filter((r) => r.parent === target); // taxonomy: nested under this CURIE (folder-derived)
    if (!total && !kids.length && !rec) return console.log(`(nothing references or nests under ${target})`);
    console.log(`${target}${statusTag(board.manifest, records, target)}`);
    if (rec?.parent) console.log(`  ↑ part-of  ${rec.parent}`);
    if (kids.length) {
      console.log(`  ↓ children (${kids.length})`);
      for (const k of kids) console.log(`      ${k.curie}${k.status ? ` [${k.status}]` : ''}  "${k.title}"`);
    }
    for (const g of groups) {
      const p = presentIncoming(board.manifest, g.rel); // read-time inverse/symmetric overlay
      console.log(`  ${p.glyph} ${p.label} (${g.sources.length})`);
      for (const s of g.sources) console.log(`      ${s.kind === 'card' ? 'card   ' + s.ref.slice(0, 8) : 'record ' + s.ref}  ${s.state ?? s.type ?? ''}  "${s.title}"`);
    }
    if (total) console.log(`\n${total} source(s)`);
    const dups = duplicateCuries(records);
    if (dups.length) console.log(`⚠ duplicate CURIE(s): ${dups.join(', ')} — a slug must be unique within its type`);
  });

program
  .command('events')
  .summary('print the raw event log')
  .action(async () => {
    const { board } = await openCtx();
    const evs = await board.events();
    for (const e of evs) console.log(JSON.stringify(e));
    console.log(`\n${evs.length} event(s) -> ${board.log.describe()}`);
  });

program
  .command('board')
  .summary('render + print the BOARD.md read-model projection')
  .option('--lane <pair...>', 'filter to one lane, e.g. website=site-a (prints only; does not write BOARD.md)')
  .action(async (opts) => {
    const { board, dir, dataDir } = await openCtx();
    const path = join(dataDir, 'views', 'BOARD.md');
    // --lane here is a filter, not a capture — there is no positional text to recover into,
    // so a non-pair token is always an error (no silent swallow of a stray word).
    opts.lane = reclaimVariadic(opts.lane, { label: '--lane', sep: ['='], recover: false }).pairs;
    const filter = parseLane(opts.lane);
    if (filter) {
      const [axis, value] = Object.entries(filter)[0];
      process.stdout.write(renderBoard(await board.pool(), board.manifest, { filter: { axis, value } }));
      console.error(`\n(filtered to ${axis}=${value} — printed, not written)`);
    } else {
      process.stdout.write(await materialize(board, path));
      await materializePortfolio(board, dir, dataDir);
      console.error(`\n-> ${path}`);
    }
  });

program
  .command('compile')
  .summary('write the drift baseline (compiled.json) + the operating guide')
  .action(async () => {
    const { board, dir, dataDir } = await openCtx();
    await mkdir(dataDir, { recursive: true });
    const prog = await writeCompiled(dataDir, board.manifest);
    console.log(`compiled "${prog.boardId}" (rev ${prog.revision}) -> ${dataFilePath(dir, 'compiled.json')}`);
    console.log(`operating guide -> ${join(dataDir, 'AGENTS.md')}`);
    const pf = await materializePortfolio(board, dir, dataDir);
    if (pf) console.log('portfolio -> ' + pf);
    printProgram(prog);
    // Scope-declaring boards echo the resolved vocabulary (pattern vs declared)
    // so a typo'd pattern fails visibly instead of silently registering nothing.
    const scopeLine = formatScopeSummary(board.manifest, dir);
    if (scopeLine) console.log(`  ${scopeLine}`);
  });

program
  .command('lint')
  .summary('advisory: check records conform to the schema + conventions (read-only)')
  .option('--format <fmt>', 'text | json', 'text')
  .action(async (opts) => {
    const { board, dir } = await openCtx();
    const cards = (await board.pool()).map((c) => ({ id: c.id, slug: c.slug, type: c.type, title: summary(c), refs: c.payload?.refs, scope: c.scope, parent: c.lineage?.parent ?? null, archived: c.archived, binding: c.binding }));
    const records = await loadRecords(board.manifest, dir, { withBody: true });
    const scopes = resolveScopes(board.manifest, dir); // null when the board declares no scope — the check stays off
    // Built-in/harness runnables are not board records but are real targets for about
    // procedure:… (same shadow chain as `do`). Fold their CURIEs into dangling's known set.
    const knownExtra = await runnableKnownCuries(board.manifest, dir);
    const accretion = foldAccretion(await board.events()); // the shape signal reads the fold, not frontmatter
    const boundDocs = await indexCardBoundDocs(board.manifest, dir);
    const { findings } = lintRecords({ cards, records }, board.manifest, {
      exists: (p) => existsSync(resolve(dir, p)),
      knownExtra,
      accretion,
      scopes,
      dir,
      boundDocs,
    });
    // Protocol conformance over the enactment log — advisory, same as the record checks.
    // The repertoire's pattern keys are advisory→strict (only strict rejects a key outside
    // the core); then each card's enactments are checked against its OWN resolved protocol
    // (per-enactment resolution from the log — self-describing enactments).
    const boardRef = board.manifest.board?.id ?? 'board';
    for (const msg of checkRepertoireStrict(board.manifest)) findings.push({ kind: 'protocol', ref: boardRef, message: msg });
    const events = await board.events();
    const cardIds = [...new Set(events.filter((e) => e.type === 'MoveActed').map((e) => e.cardId))];
    for (const cardId of cardIds) {
      const cardEvents = events.filter((e) => e.cardId === cardId);
      const { proto } = await resolveGoverning(board.manifest, dir, { events, cardId });
      findings.push(...lintProtocolEnactments({ events: cardEvents, proto }));
    }
    const ok = findings.length === 0;
    if (opts.format === 'json') {
      console.log(JSON.stringify(findings, null, 2));
    } else if (ok) {
      console.log('✓ lint clean — every record conforms');
    } else {
      let scopedHeader = false;
      for (const f of findings) {
        if (f.kind === 'scope' && !scopedHeader) {
          // Vocabulary once, above the worklist — not repeated in every remedy.
          const vocab = scopeIds(scopes).join(', ') || 'none resolve yet';
          console.log(`  scope vocabulary: ${vocab}`);
          scopedHeader = true;
        }
        const subject = f.title ? `${f.ref}  "${f.title}"` : f.ref;
        console.log(`  ⚠ ${f.kind.padEnd(11)} ${subject}  —  ${f.message}`);
      }
      console.log(`\n${findings.length} finding(s) — advisory; nothing changed (exit 1 so a hook can gate)`);
    }
    if (!ok) process.exitCode = 1;
  });

program
  .command('map')
  .summary('render each record\'s resolved graph view (views/maps/) + the footprint read-model (views/FOOTPRINTS.md) + the curation read-model (views/CURATION.md) — materialized views (refresh on demand)')
  .action(async () => {
    const { board, dir, dataDir } = await openCtx();
    const n = await writeMaps(board, dir, dataDir);
    await writeFootprints(board, dir, dataDir);
    await writeCuration(board, dir, dataDir);
    console.log(`mapped ${n} record(s) (+ index.md, FOOTPRINTS.md, CURATION.md) -> ${join(dataDir, 'views')}`);
  });

program
  .command('metrics')
  .summary('flow metrics — fold the event log into three regions (upstream funnel · delivery pipeline · system balance) + knowledge accrual; prints the summary and writes views/METRICS.md (read-only)')
  .option('--window <7d|all|N>', 'the observation window: 7d (default), all, or a day count', '7d')
  .option('--format <text|md>', 'stdout format: text (default) or md', 'text')
  .action(async (opts) => {
    const { board, dir, dataDir } = await openCtx();
    const model = foldMetrics(await board.events(), board.manifest, { window: opts.window });
    process.stdout.write(renderMetrics(model, { format: opts.format }));
    const path = join(dataDir, 'views', 'METRICS.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderMetrics(model, { format: 'md' }), 'utf8');
    console.error(`\n-> ${path}`);
  });

program
  .command('diff')
  .summary('show structural changes since the compiled baseline')
  .action(async () => {
    const { board, dir } = await openCtx();
    const prog = compile(board.manifest);
    const baselinePath = dataFilePath(dir, 'compiled.json');
    if (!existsSync(baselinePath)) return console.log('no compiled baseline — run `kanbento compile` first');
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const cs = diffCompiled(baseline, prog);
    if (isEmptyChangeset(cs)) return console.log('no structural changes since the baseline');
    printChangeset(cs);
    const moves = reconcileMoves(cs, await board.pool(), prog);
    if (moves.length) {
      console.log('\nreconciliation preview (run `reconcile` to apply):');
      for (const m of moves) console.log(`  ${m.card.slice(0, 8)}  "${m.title}"  ${m.from} -> ${m.to}  (${m.reason})`);
    }
  });

program
  .command('reconcile')
  .summary('apply structural changes: re-place orphaned cards, re-baseline')
  .action(async () => {
    const { board, dir, dataDir } = await openCtx();
    const baselinePath = dataFilePath(dir, 'compiled.json');
    if (!existsSync(baselinePath)) return console.log('no compiled baseline — run `kanbento compile` first');
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const { applied, changeset, moves } = await board.reconcile(baseline);
    if (!applied) return console.log('no structural changes — nothing to reconcile');
    printChangeset(changeset);
    console.log(moves.length ? '\napplied reconciliation moves:' : '\nno orphaned cards to move');
    for (const m of moves) console.log(`  ${m.card.slice(0, 8)}  ${m.from} -> ${m.to}  (${m.reason})`);
    await writeCompiled(dataDir, board.manifest);
    console.log('\nre-baselined + guide regenerated -> .kanbento/');
    await rematerialize(board, dataDir);
  });

program
  .command('upgrade')
  .summary('bring an existing board current with the installed kanbento — regenerate generated artifacts, reconcile structural drift')
  .option('--dry-run', 'show what would change without writing')
  .action(async (opts) => {
    // Layout first: a ≤0.2 store must be migrated before the board can open at all.
    {
      const { dir } = resolveBoardDir(program.opts().board);
      for (const f of migrateDataFiles(dir, { dryRun: !!opts.dryRun })) {
        console.log(`${opts.dryRun ? 'would move' : 'moved'}: .kanbento/${f.name} -> .kanbento/data/${f.name}`);
      }
      if (opts.dryRun && legacyDataFiles(dir).length) return; // nothing else can be judged until the files are in place
    }
    const { board, dir, dataDir } = await openCtx();
    const baselinePath = dataFilePath(dir, 'compiled.json');
    const baseline = existsSync(baselinePath) ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
    console.log(`${board.manifest.board?.id ?? 'board'} · built by kanbento ${baseline?.toolVersion ?? '(unstamped)'} · installed ${VERSION}`);

    const prog = compile(board.manifest);
    const drift = baseline ? !isEmptyChangeset(diffCompiled(baseline, prog)) : false;

    if (opts.dryRun) {
      if (drift) {
        const cs = diffCompiled(baseline, prog);
        printChangeset(cs);
        for (const m of reconcileMoves(cs, await board.pool(), prog)) console.log(`  ${m.card.slice(0, 8)}  ${m.from} -> ${m.to}  (${m.reason})`);
      } else {
        console.log('no structural drift');
      }
      await migrateRunnable(dir, { dryRun: true });
      await migrateCasesAbout({ board, dir }, { dryRun: true });
      console.log('would regenerate: compiled.json (+ stamp), AGENTS.md, EVOLVING.md, views/, maps, root anchors');
      return;
    }

    await migrateRunnable(dir, { dryRun: false });
    await migrateCasesAbout({ board, dir }, { dryRun: false });

    if (drift) {
      const { changeset, moves } = await board.reconcile(baseline);
      printChangeset(changeset);
      for (const m of moves) console.log(`  ${m.card.slice(0, 8)}  ${m.from} -> ${m.to}  (${m.reason})`);
    }
    await regenerateGenerated(board, dir, dataDir); // baseline + guide + views + maps + gitignore — one list, shared with init
    await writeAnchors(dir); // bring the root discovery anchors current (the drift this verb used to miss)
    console.log(`upgraded to kanbento ${VERSION} — generated layer + root anchors regenerated`);
    if (!gitTracked(dir)) console.log('  ⚠ board not committed — `git add .kanbento && git commit` makes upgrades recoverable');
  });

program
  .command('sync')
  .summary('catch-up: reconcile externally created/edited artifacts into the store')
  .option('--root <dir>', 'corpus root (default: the board dir)')
  .option('--write', 'push board state back to artifact frontmatter')
  .action(act(async ({ board, dir }, opts) => {
    const results = await syncBoard({ board }, resolve(opts.root ?? dir), { write: opts.write });
    if (!results.length) return console.log('no embodied types to sync (a type needs a file/folder embodiment, and at least one artifact on disk)');
    for (const r of results) {
      if (r.mode === 'write') console.log(`type "${r.id}": pushed ${r.pushed} doc(s)  (board -> artifact)`);
      else if (r.mode === 'record') console.log(`type "${r.id}": ${r.indexed} record(s)  — knowledge layer, FS-owned (not carded; \`sweep\` enriches them)`);
      else console.log(`type "${r.id}": indexed ${r.indexed}  — created ${r.created}, moved ${r.moved}, unchanged ${r.unchanged}`);
    }
    if (!opts.write) {
      const byStage = {};
      for (const c of await board.pool()) byStage[c.state] = (byStage[c.state] ?? 0) + 1;
      console.log('\nboard (cards per stage):');
      for (const [s, n] of Object.entries(byStage)) console.log(`  ${s}: ${n}`);
    }
  }));

program
  .command('sweep')
  .summary('catch up on changed record files: extract relations into their frontmatter (mtime-driven, idempotent)')
  .option('--extract <cmd>', 'extractor: a command that reads $KANBENTO_FILE and prints JSON relations; default $KANBENTO_EXTRACTOR')
  .option('--all', 'sweep every record file, not only those changed since the last sweep')
  .option('--cap <n>', 'max relations kept per artifact — bounds open extraction', '5')
  .action(async (opts) => {
    const { board, dir } = await openCtx();
    const markPath = dataFilePath(dir, 'swept.json');
    // The marker carries the mtime watermark (`at`) AND the per-record content-digest
    // baseline (`digests`) — the content-change memory the revised: refresh keys off
    // (sweep-restamps-untouched@67325ca4). Both persist in the same store file.
    const mark = existsSync(markPath) ? JSON.parse(await readFile(markPath, 'utf8')) : {};
    const since = !opts.all && mark.at ? Date.parse(mark.at) || 0 : 0;
    const digests = { ...(mark.digests ?? {}) }; // record path → last-swept content digest
    const extractor = opts.extract ?? process.env.KANBENTO_EXTRACTOR;
    const cap = Number(opts.cap) || 5;
    let changed = 0;
    let enriched = 0;
    let restamped = 0;
    const today = new Date().toISOString().slice(0, 10); // the edit clock is day-granular
    // Only knowledge records (flow:false) are swept — the FS is their write model;
    // flow cards are owned by the log, not enriched here.
    const all = (await Promise.all(recordTypes(board.manifest).map((def) => indexRecords(def, dir)))).flat();
    // The resolve-set the extractor links against: established record CURIEs PLUS
    // anything already referenced (dangling candidates). It grows as the sweep runs,
    // so a later artifact resolves to an earlier mint instead of forking it.
    const known = new Set(all.flatMap((r) => [r.curie, ...refEdges(r.refs).map((e) => e.curie)]).filter(Boolean));
    for (const rec of all) {
      const abs = resolve(dir, rec.path);
      const mtimeMs = statSync(abs).mtimeMs;
      // The mtime watermark stays a cheap "candidate changed" pre-filter (skip files
      // untouched since the last sweep — an unmoved mtime can't hide a content edit);
      // a skipped record keeps its prior digest in the carried-over `digests` map.
      if (mtimeMs <= since) continue;
      changed++;
      // Refresh the `revised:` edit clock the way `elaborate` does — but key it off a
      // CONTENT change, not bare mtime. mtime is bumped by git checkout/merge and
      // artifact materialization without any content edit; restamping on that falsely
      // reset revised: on untouched anchor records and corrupted curation's freshness
      // clock (sweep-restamps-untouched@67325ca4). We compare the file's current byte
      // digest against the baseline captured last sweep: restamp only when it moved.
      // The pre-mutation digest is the human-visible state; a genuine hand edit still
      // resets the clock (preserves mtime-revised-drift@71692bd8).
      const before = await readFile(abs, 'utf8');
      const priorDigest = digests[rec.path];
      let mutated = false;
      if (sweepShouldRestamp(priorDigest, contentDigest(before))) {
        await writeFrontmatterField(abs, 'revised', today);
        restamped++;
        mutated = true;
      }
      if (extractor) {
        const rels = capRels(parseRels(runExtractor(extractor, abs, rec, board.manifest, [...known].filter((c) => c !== rec.curie))), cap);
        if (rels && (await mergeRefs(abs, rec.refs, rels))) {
          enriched++;
          mutated = true;
          for (const e of refEdges(rels)) known.add(e.curie); // mints feed forward to later artifacts
          console.log(`  enriched ${rec.path}`);
        }
      }
      // Re-baseline the digest to the state we LEAVE the file in — so this sweep's own
      // machine writes (the restamp, extracted refs) are folded into the baseline and
      // never read back as a content change next pass. Unmutated → the digest we read.
      digests[rec.path] = mutated ? contentDigest(await readFile(abs, 'utf8')) : contentDigest(before);
    }
    await mkdir(dirname(markPath), { recursive: true });
    await writeFile(markPath, JSON.stringify({ at: new Date().toISOString(), digests }) + '\n', 'utf8');
    console.log(`swept ${changed} changed record(s)${restamped ? `; refreshed ${restamped} revised: stamp(s)` : ''}${extractor ? `; enriched ${enriched}` : ' (no extractor — watermark advanced)'}`);
  });

// Networks are declared in member manifests (`network:`) and discovered by scanning
// the repo — no host flag, no join verb. One parent keeps the namespace clean.
const network = program
  .command('network')
  .summary('cross-board networks — declared in manifests, discovered in the tree');

network
  .command('list', { isDefault: true })
  .summary('list the networks declared across this repo')
  .action(async () => {
    const root = repoRoot(resolveBoardDir(program.opts().board).dir);
    const nets = discoverNetworks(await discoverBoards(root));
    if (!nets.length) return console.log(`(no networks declared under ${root})`);
    for (const n of nets) console.log(`${n.name}  ·  ${n.members} member(s)${n.anchor ? '  ·  ⚓ ' + n.anchor : ''}`);
    console.log(`\n${nets.length} network(s) under ${root}`);
  });

network
  .command('view <name>')
  .summary('render the cross-board view of a network')
  .action(async (name) => {
    const root = repoRoot(resolveBoardDir(program.opts().board).dir);
    const { markdown, path } = await renderNetworkFor(name, await discoverBoards(root));
    process.stdout.write(markdown);
    console.error(path ? `\n-> ${path}` : `\n(anchorless — printed only; name a board "${name}" to persist its NETWORK.md)`);
  });

// The init template ladder (getting-started-doc@66306ba0): a rung per stage count,
// 2..5, keyed by that count. Each ships stages + roles + commitment/delivery points
// ONLY — no types, WIP limits, or DoR/DoD prose (a board grows those as the flow
// earns them). Data, not code: `chain` is the conceptual role chain (help/discovery),
// `stages` maps each label to a real role from the closed vocabulary (protocol.js:
// options/commit/active/loop/done). The default when neither --from nor --template is
// given is the 4-stage board — a bare pool is no longer the starting point. Declared
// above parseAsync so the command's --help / action can reference it (not hoisted).
const TEMPLATES = {
  2: {
    chain: 'options → done',
    blurb: 'pool + delivery — capture, then ship',
    stages: [['pool', 'options'], ['done', 'done']],
  },
  3: {
    chain: 'options → active → done',
    blurb: 'adds work-in-progress between the pool and delivery',
    stages: [['pool', 'options'], ['in_progress', 'active'], ['done', 'done']],
  },
  4: {
    chain: 'options → committed → active → done',
    blurb: 'the default — adds a commitment point before work starts',
    stages: [['pool', 'options'], ['selected', 'commit'], ['in_progress', 'active'], ['done', 'done']],
  },
  5: {
    chain: 'options → committed → active → acceptance → done',
    blurb: 'adds an acceptance checkpoint before delivery',
    stages: [['pool', 'options'], ['selected', 'commit'], ['in_progress', 'active'], ['review', 'loop'], ['done', 'done']],
    // No loop edge: rework is in-place re-dispatch at the checkpoint (card stays put;
    // the producer is re-summoned). A kind:loop flow remains legal grammar for boards
    // that want stage regression; this template does not teach it. See
    // story:loop-edge-declared-but-inert.
  },
};
const DEFAULT_TEMPLATE = 4;

try {
  // Detached auto-sharpener (fireNaming) re-enters here — no public naming verb.
  if (await runFireNamingEntry()) process.exit(0);
  // Protect `- [ ]` / `- [x]` checklist items from Commander option parsing (see protectChecklistArgv).
  await program.parseAsync(protectChecklistArgv(process.argv));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}

// --- setup (init / install) -------------------------------------------------

async function initBoard(dir, label, from, identity = {}, template = null) {
  // Everything kanbento lives under .kanbento/ — including the manifest — so the
  // project root stays clean (no clash with a web app's own manifest.json).
  const dataDir = dataDirIn(dir);
  await mkdir(dataDir, { recursive: true });

  if (hasManifest(dir)) {
    console.log(`manifest: ${manifestPathIn(dir)} (kept)`);
  } else if (from) {
    // Seed the manifest, but give the board its OWN identity — never inherit the
    // seed's board.id/name (that is the template's, not this board's). Derived from
    // the target dir, overridable by --id/--name. Mirrors how `install` vendors.
    const src = resolve(from);
    const seed = await loadManifest(src);
    const id = identity.id ?? basename(dir);
    const seeded = mergeManifests(seed, { board: { ...(seed.board ?? {}), id, name: identity.name ?? id } });
    await writeFile(join(dataDir, 'manifest.json'), JSON.stringify(seeded, null, 2) + '\n', 'utf8');
    console.log(`manifest: .kanbento/ (seeded from ${src} as "${id}")`);
  } else {
    const n = template ?? DEFAULT_TEMPLATE;
    await writeFile(join(dataDir, 'manifest.json'), templateManifest(n, label, identity), 'utf8');
    console.log(`manifest: .kanbento/manifest.json (${n}-stage: ${TEMPLATES[n].chain})`);
  }

  await finalizeBoard(dir, label);
  console.log(`\nboard ready at ${dir} — start with: kanbento capture "<first item>"`);
}

// Vendor a workflow into this board — a one-time COPY (no live resolution), the
// foundation for package management (docs/packages.md). Copies the source
// workflow's manifest (keeping this board's own identity), its companion scripts,
// and records provenance in installed.json (the lockfile seed). The board then
// runs its own concrete copy; re-install to update.
async function installWorkflow(dir, label, source) {
  const dataDir = dataDirIn(dir);
  await mkdir(dataDir, { recursive: true });

  const srcAbs = resolve(source);
  if (!existsSync(srcAbs)) throw new Error(`install: nothing at ${srcAbs}`);
  const srcManifest = statSync(srcAbs).isDirectory() ? manifestPathIn(srcAbs) : srcAbs;
  if (!existsSync(srcManifest)) throw new Error(`install: no manifest found at ${source}`);

  // vendor the workflow, keeping this board's own identity (or deriving one)
  const workflow = await loadManifest(srcManifest);
  const identity = (hasManifest(dir) ? (await loadManifest(manifestPathIn(dir))).board : null) ?? { id: basename(dir), name: basename(dir) };
  const vendored = mergeManifests(workflow, { board: { ...(workflow.board ?? {}), ...identity } });
  await writeFile(join(dataDir, 'manifest.json'), JSON.stringify(vendored, null, 2) + '\n', 'utf8');

  // vendor companion scripts (best-effort; deeper corpus handling is deferred)
  const srcDataDir = statSync(srcAbs).isDirectory() ? dataDirIn(srcAbs) : dirname(srcManifest);
  let scripts = 0;
  if (existsSync(srcDataDir)) {
    for (const f of readdirSync(srcDataDir)) {
      if (f.endsWith('.mjs')) {
        await copyFile(join(srcDataDir, f), join(dataDir, f));
        scripts++;
      }
    }
  }

  // lockfile seed: where it came from + a content hash to pin / detect drift
  const hash = createHash('sha256').update(await readFile(srcManifest, 'utf8')).digest('hex').slice(0, 12);
  const lockPath = dataFilePath(dir, 'installed.json');
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ workflow: { from: srcManifest, hash } }, null, 2) + '\n', 'utf8');

  console.log(`installed workflow "${workflow.board?.id ?? '?'}" from ${srcManifest}`);
  console.log(`  vendored manifest${scripts ? ` + ${scripts} script(s)` : ''}; locked @ ${hash}`);
  await finalizeBoard(dir, label);
  console.log(`\nboard ready at ${dir} — workflow vendored; re-install to update.`);
}

// Shared tail for init / install: the gitignore, compile (drift baseline +
// operating guide), the read-model projection, and the root discovery anchors.
async function finalizeBoard(dir, label) {
  const dataDir = dataDirIn(dir);
  const board = await openBoard({
    manifestPath: manifestPathIn(dir),
    log: new FileLog(dataFilePath(dir, 'events.jsonl')),
    boardDir: dir,
    identify: gitIdentity(dir),
  });
  await regenerateGenerated(board, dir, dataDir);
  console.log('  .kanbento/  manifest · data/ · AGENTS.md · EVOLVING.md · views/BOARD.md · views/maps/');
  if (!String(label ?? '').startsWith('@')) {
    const a = await writeAnchors(dir);
    console.log(`  ${a.agents} AGENTS.md   (root anchor — all tools)`);
    console.log(`  ${a.claude} CLAUDE.md   (root anchor — Claude @import)`);
  }
}

// The two compile targets, written together: compiled.json is the structural
// baseline drift detection diffs against (docs/evolution.md); AGENTS.md is the
// operating guide. Both regenerate from the manifest on every `compile`/`init`.
// Describe the program's verbs for the operating guide — so AGENTS.md's verb list
// is generated from the same command definitions the CLI parses, never re-typed.
function describeVerbs() {
  const describe = (c, prefix = '') => ({
    name: prefix + c.name(),
    args: c.registeredArguments
      .map((a) => (a.required ? `<${a.name()}${a.variadic ? '...' : ''}>` : `[${a.name()}${a.variadic ? '...' : ''}]`))
      .join(' '),
    options: c.options.filter((o) => !o.hidden && !o.flags.includes('--help')).map((o) => o.flags),
    summary: c.summary() || c.description() || '',
  });
  const out = [];
  for (const c of program.commands) {
    out.push(describe(c));
    for (const sub of c.commands) out.push(describe(sub, `${c.name()} `)); // one level of nesting (e.g. `network join`)
  }
  return out;
}

async function writeCompiled(dataDir, manifest) {
  const prog = compile(manifest);
  prog.toolVersion = VERSION; // stamp what built this baseline; drift detection ignores it
  registerBoard(manifest.board?.id, dirname(dataDir)); // self-record in the machine registry (handle -> dir) so `@id` resolves cross-repo
  const compiledPath = dataFilePath(dirname(dataDir), 'compiled.json');
  await mkdir(dirname(compiledPath), { recursive: true });
  await writeFile(compiledPath, JSON.stringify(prog, null, 2) + '\n', 'utf8');
  await writeFile(join(dataDir, 'AGENTS.md'), renderAgents(manifest, { verbs: describeVerbs(), hasVendor: existsSync(join(dataDir, 'vendor')) }), 'utf8');
  await writeFile(join(dataDir, 'EVOLVING.md'), EVOLVING_MD, 'utf8');
  return prog;
}

// Insert or replace the kanbento section inside a (possibly project-owned) file,
// bounded by markers so re-running init never duplicates or clobbers other content.
async function upsertSection(filePath, body) {
  const block = `${MARK_START}\n${body}\n${MARK_END}`;
  if (!existsSync(filePath)) {
    await writeFile(filePath, block + '\n', 'utf8');
    return 'created ';
  }
  const cur = await readFile(filePath, 'utf8');
  if (MARK_RE.test(cur)) {
    await writeFile(filePath, cur.replace(MARK_RE, block), 'utf8');
    return 'updated ';
  }
  await writeFile(filePath, cur.replace(/\n*$/, '\n\n') + block + '\n', 'utf8');
  return 'appended';
}

// Validate a --template value against the ladder; a bad rung errors cleanly.
function resolveTemplate(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || !(n in TEMPLATES))
    throw new Error(`init: --template must be one of ${Object.keys(TEMPLATES).join(', ')} (got "${raw}")`);
  return n;
}

// Render a template's manifest — the board's OWN identity, derived from the target
// (dir basename), with --id/--name overriding when supplied. Name defaults to the id.
function templateManifest(n, label, identity = {}) {
  const derived = String(label || 'board').replace(/^@/, '').split(/[\\/]/).pop() || 'board';
  const id = identity.id ?? derived;
  const name = identity.name ?? id;
  const t = TEMPLATES[n];
  const stages = t.stages.map(([sid, role]) => ({ id: sid, role }));
  const manifest = {
    manifestVersion: '1.0',
    board: { id, name, revision: 0, maturity: 'standard' },
    inbox: { sources: ['human', 'agent', 'request', 'feedback'], landing: stages[0].id },
    stages,
    ...(t.flows ? { flows: t.flows } : {}),
    // Ship the `procedure` type runnable so a fresh board gets the runner out of the box
    // (`kanbento do <slug>`). Runnability is a declared type property (runnable: true), not
    // a magic name — a board may add its own runnable types (runbook/check/…) the same way.
    types: [{ id: 'procedure', embodiment: 'file', path: '.kanbento/procedures/{slug}.md', flow: false, runnable: true }],
    policies: { joining: 'A worker announces its capability profile on arrival.' },
    cardSchema: { core: ['id', 'title', 'state', 'createdAt', 'updatedAt'], types: 'open' },
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

// One-time manifest migration for the runnable type-flag (mirrors the store-data-dir
// migration posture — `upgrade` migrates, no permanent runtime magic). A board authored
// before runnability became a declared property has a `procedure` type with no `runnable`
// key; the runtime keys STRICTLY off `runnable === true` (no legacy id-based fallback), so
// stamp the flag on those boards' `procedure` type or their procedure records stop
// resolving. Idempotent: a type that already carries `runnable` (true OR false) is left as
// authored. Package built-ins are unaffected (always runnable). --dry-run reports only.
async function migrateRunnable(dir, { dryRun }) {
  const path = manifestPathIn(dir);
  if (!existsSync(path)) return;
  const manifest = await loadManifest(path);
  const proc = (manifest.types ?? []).find((t) => t.id === 'procedure');
  if (!proc || Object.prototype.hasOwnProperty.call(proc, 'runnable')) return; // absent, or already declared — nothing to do
  if (dryRun) {
    console.log("would stamp runnable: true on type 'procedure'");
    return;
  }
  proc.runnable = true;
  await writeManifest(path, manifest);
  console.log("stamped runnable: true on type 'procedure'");
}

// Migrate legacy case precedents: lift each `· about <target>` prose citation into the
// case file's frontmatter refs (a real graph edge), best-effort resolving handles → CURIE.
// Idempotent — once lifted there is no prose left to find. A no-op on a board with no cases.
async function migrateCasesAbout(ctx, { dryRun }) {
  const { dir } = ctx;
  if (!existsSync(casesDir(dir))) return;
  const resolve = (h) => resolveRelTarget({ board: ctx.board, dir }, h); // throws on unresolvable — migrateCases keeps verbatim
  const migrated = await migrateCases(dir, { resolve: dryRun ? undefined : resolve, dryRun });
  for (const m of migrated) console.log(`${dryRun ? 'would migrate' : 'migrated'} cases/${m.file} — ${m.targets.length} about → refs`);
}

// Rewrite a manifest in its authored format (JSON or YAML) — the migration's write half.
async function writeManifest(path, manifest) {
  if (path.endsWith('.json')) {
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return;
  }
  const { default: yaml } = await import('js-yaml');
  await writeFile(path, yaml.dump(manifest), 'utf8');
}

// --- per-verb helpers -------------------------------------------------------
// (the verb bodies themselves live in commands.js — this file is the transport)

// Surface a stage's contract on entry (pull-mode). A stage may declare a worker
// (`procedure`) AND an agreement (the fuller Ready·Body·Done form) — surface BOTH: the
// worker pointer, then the DoR the work is now under and the DoD it must reach (the agent
// opens the files for the bodies). A single-declaration stage prints exactly its one form.
function surfaceContract(manifest, state, dir) {
  const proc = stageProcedurePath(manifest, state);
  if (proc) console.log(`▶ procedure: ${resolve(dir, proc)}`);
  const agr = stageAgreementPath(manifest, state);
  if (agr) {
    const path = resolve(dir, agr);
    console.log(`▣ agreement: ${path}`);
    if (existsSync(path)) {
      const { ready, done } = parseAgreement(readFileSync(path, 'utf8'));
      const show = (label, cs) => {
        if (cs.length) console.log(`  ${label}\n` + cs.map((c) => `      ${c.text}`).join('\n'));
      };
      show('Ready (DoR)', ready); // what the work is now under
      show('Done (DoD)', done); // what it must satisfy to leave — verified independently
    }
  }
}

function printMove({ card, warnings, loop }) {
  for (const w of warnings ?? []) console.log(`  ! ${w}`);
  console.log(`${handle(card)}  ->  [${card.state}]  ${summary(card)}`);
  // Loop edge: surface taken/ceiling so the coordinator sees remaining rework budget.
  if (loop) {
    const label = loop.maxIterations != null ? `loop ${loop.taken}/${loop.maxIterations}` : `loop ${loop.taken}`;
    console.log(`  ${label}`);
  }
}

// Request a card on another board: resolve the destination, open it, and capture
// into its inbox with a `<kind>:<origin>` source (provenance). The destination opts
// in by listing the kind in inbox.sources — who-may-request v0; the card lands in
// options, left of the commitment point, an offer the owner disposes.
async function submitTo(destArg, { body, title }, kind, origin) {
  if (!body || !body.trim()) throw new Error(`${kind}: the request body is required (inline text, -F <file>, or piped stdin)`);
  const { dir, label } = resolveBoardDir(destArg);
  if (!hasManifest(dir)) {
    throw new Error(`${kind}: no board for "${destArg}" (resolved ${dir}). The owner records it by running \`kanbento compile\` there.`);
  }
  const dataDir = dataDirIn(dir);
  // The submitter's identity, not the destination's — who pushed the request in.
  const board = await openBoard({ manifestPath: manifestPathIn(dir), log: new FileLog(dataFilePath(dir, 'events.jsonl')), boardDir: dir, identify: gitIdentity(process.cwd()) });
  const card = await board.capture({ source: `${kind}:${origin}`, body: body.trim(), title, payload: { from: origin } });
  await materialize(board, join(dataDir, 'views', 'BOARD.md')); // refresh the destination's read model
  fireNaming(card.id, dir); // a request IS a capture on the dest board — name it there too
  return { card, label, dir };
}

// Operator-pinned slug: capture --slug, or CardSlugged.pinned (elaborate --slug).
// A model-derived CardSlugged has no .pinned — a later pass may re-sharpen those.
function slugIsPinned(events, cardId) {
  return events.some((e) =>
    (e.type === 'ItemCaptured' && e.cardId === cardId && e.slug) ||
    (e.type === 'CardSlugged' && e.cardId === cardId && e.pinned));
}

function namingDisabled() {
  return process.env.KANBENTO_NO_NAMING === '1' || process.env.KANBENTO_NO_RESLUG === '1';
}

// Parse the evaluator reply into { title, slug }. JSON is the contract; a two-line
// reply and a slug-only line (legacy slugEvaluator) are accepted so an old stub
// still sharpens the slug. Missing fields are null — apply-time skips them.
function parseNameReply(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  const fromObj = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const title = obj.title != null ? String(obj.title).trim() : '';
    const slug = obj.slug != null ? String(obj.slug).trim() : '';
    if (!title && !slug) return null;
    return { title: title || null, slug: slug || null };
  };
  try {
    const direct = fromObj(JSON.parse(text));
    if (direct) return direct;
  } catch { /* not a bare JSON blob */ }
  const m = text.match(/\{[^{}]*\}/);
  if (m) {
    try {
      const nested = fromObj(JSON.parse(m[0]));
      if (nested) return nested;
    } catch { /* wrapped text wasn't JSON either */ }
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) return { title: lines[0], slug: lines[1] };
  if (lines.length === 1) return { title: null, slug: lines[0] };
  return null;
}

// One model call for both fields. Pluggable (manifest.nameEvaluator, falling back
// to slugEvaluator) — a script stub in tests keeps the suite off the network.
// Internal auto-sharpener only; the user-facing re-pin is elaborate --slug/--title.
async function nameCard(manifest, card) {
  const cmd = manifest.nameEvaluator ?? manifest.slugEvaluator ?? 'claude -p --model haiku "$KANBENTO_PROMPT"';
  const detail = card.body && card.body !== summary(card) ? `\n\nDetail:\n${card.body.slice(0, 600)}` : '';
  const prompt = `Name this work item by its subject. Reply with ONLY a JSON object {"title":"...","slug":"..."}.
- title: a one-line handle (a few words, no leading verb, no filler)
- slug: lowercase kebab-case, 2-4 words, no leading verb, no filler

Title: ${summary(card)}${detail}`;
  const res = await execCommand(cmd, { KANBENTO_PROMPT: prompt });
  if (!res.ok) return null;
  const parsed = parseNameReply(res.stdout);
  if (!parsed) return null;
  const title = parsed.title ? (parsed.title.split('\n').map((l) => l.trim()).find(Boolean) ?? null) : null;
  const slug = parsed.slug ? slugify(parsed.slug, 48) : null;
  if (!title && !slug) return null;
  return { title, slug };
}

// Fire the naming pass in the background — non-blocking, best-effort. Title and
// slug are advisory (id-keyed), so a sharper name landing a beat after capture
// returns is safe. Opt out with KANBENTO_NO_NAMING=1 (tests / CI / bulk imports);
// KANBENTO_NO_RESLUG=1 is accepted as an alias. Re-enters this CLI via
// KANBENTO_FIRE_NAMING (no public verb — deliberate re-pins go through elaborate).
function fireNaming(id, dir) {
  if (namingDisabled()) return;
  try {
    const cli = process.env.KANBENTO_CLI ?? fileURLToPath(import.meta.url);
    spawn(process.execPath, [cli, '--board', dir], {
      detached: true,
      stdio: 'ignore', // must not inherit a pipe: a harness using spawnSync / `2>&1 | tee` would wait on the child's write-end for EOF
      env: { ...process.env, KANBENTO_FIRE_NAMING: id },
    }).unref();
  } catch { /* best-effort — the heuristic name stands */ }
}

// Internal auto-sharpener entry (spawned by fireNaming). Not a user verb.
// Runs before program.parse so there is no subcommand to register. Best-effort:
// any failure leaves the heuristic title/slug and writes one stderr line.
async function runFireNamingEntry() {
  const id = process.env.KANBENTO_FIRE_NAMING;
  if (!id) return false;
  let card;
  try {
    const boardIdx = process.argv.indexOf('--board');
    const boardRef = boardIdx >= 0 ? process.argv[boardIdx + 1] : undefined;
    const { dir } = resolveBoardDir(boardRef);
    const dataDir = dataDirIn(dir);
    const board = await openBoard({
      manifestPath: manifestPathIn(dir),
      log: new FileLog(dataFilePath(dir, 'events.jsonl')),
      boardDir: dir,
      observe: gitObserver(dir),
      identify: gitIdentity(dir),
    });
    card = await board.card(id);
    if (!card) return true; // gone — best-effort, detached
    const events = await board.events();
    // note:authored-title-doctrine — `title` is authored text or null, so the
    // whole predicate is "nobody named this". No pin scan, no heading test.
    const wantTitle = card.title == null;
    const wantSlug = !slugIsPinned(events, card.id);
    if (!wantTitle && !wantSlug) return true; // nothing underived — skip the call
    const named = await nameCard(board.manifest, card);
    if (!named) {
      console.error(`naming: failed for ${handle(card)} — heuristic name stands`);
      return true;
    }
    let updated = card;
    if (wantTitle && named.title) {
      updated = await board.retitle(card.id, named.title);
      if (updated.binding?.path) {
        try {
          await writeFrontmatterField(resolve(dir, updated.binding.path), 'title', JSON.stringify(updated.title));
        } catch { /* no doc yet, or no frontmatter — the event still landed */ }
      }
    }
    let path;
    if (wantSlug && named.slug && named.slug !== updated.slug) {
      const reslugged = await applyReslug({ board, dir }, updated, named.slug);
      updated = reslugged.updated;
      path = reslugged.path;
    }
    await materialize(board, join(dataDir, 'views', 'BOARD.md'));
    const bits = [];
    if (updated.title !== card.title) bits.push('title');
    if (updated.slug !== card.slug) bits.push(card.slug ? `slug ${card.slug} → ${updated.slug}` : 'slug');
    if (bits.length) console.log(`named \`${handle(updated)}\`${path ? ` → ${path}` : ''}  (${bits.join(', ')})`);
  } catch {
    console.error(`naming: failed${card ? ` for ${handle(card)}` : ''} — heuristic name stands`);
  }
  return true;
}

// Load every embodied type's record files (the fs half of the refs scan).
async function loadRecords(manifest, root, opts) {
  const recs = [];
  for (const def of embodiedTypes(manifest)) {
    recs.push(...(await indexRecords(def, root, opts)));
  }
  return recs;
}

// Materialize PORTFOLIO.md — the position read-model. Gathers the declared position
// records (roots + status), counts each one's inbound investment (cards advancing it),
// and writes the projection. No-op when the board declares no portfolio types.
async function materializePortfolio(board, dir, dataDir) {
  const types = portfolioTypes(board.manifest);
  if (!types.length) return null;
  const recs = [];
  // tag each record with its type id — indexRecords runs per def, so the type is known here
  for (const def of embodiedTypes(board.manifest).filter((t) => types.includes(t.id)))
    for (const r of await indexRecords(def, dir)) recs.push({ ...r, type: def.id });
  const cards = (await board.pool()).filter((c) => !c.archived);
  const investmentOf = (curie) => cards.filter((c) => Object.values(c.payload?.refs ?? {}).flat().includes(curie)).length;
  const positions = recs.map((r) => ({
    curie: r.curie,
    title: r.title,
    status: r.status,
    type: r.type,
    root: r.parent == null,
    investment: r.curie ? investmentOf(r.curie) : 0,
    childCount: recs.filter((x) => (x.ancestors ?? []).includes(r.curie)).length,
  }));
  return writeProjection(join(dataDir, 'views', 'PORTFOLIO.md'), renderPortfolio(positions, board.manifest, {}));
}

// Build the materialized maps: each record's resolved view + the index home page, into
// the gitignored views/maps/ tree (a per-record BOARD.md). The owned projection of the
// human-owned source files. Shared by `map`, init, and upgrade.
async function writeMaps(board, dir, dataDir) {
  const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, handle: c.slug ? `${c.slug}@${c.id.slice(0, 8)}` : c.id.slice(0, 8), title: summary(c), type: c.type, state: c.state, refs: c.payload?.refs }));
  const records = await loadRecords(board.manifest, dir);
  const footprints = recordFootprints(records, cards, await board.events());
  const exists = (p) => existsSync(resolve(dir, p));
  // The curation inspect block's evidence: for a git-verified record with a footprint, the
  // commits that touched it since `verified:`. Git-side (impure) so the renderer stays pure.
  const sinceVerified = (r) => {
    const stamp = typeof r.verified === 'string' ? r.verified : null;
    if (!stamp?.startsWith('git:')) return null;
    const paths = [...(footprints.get(r.curie) ?? new Map()).keys()];
    if (!paths.length) return null;
    const log = gitLogSince(dir, stamp.slice(4), paths);
    return log && log.commits.length ? { sha: stamp.slice(4), ...log } : null;
  };
  const root = join(dataDir, 'views', 'maps');
  await mkdir(root, { recursive: true });
  for (const r of records) {
    const out = join(root, r.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, renderMap(r, { cards, records }, board.manifest, { exists, sinceVerified }), 'utf8');
  }
  await writeFile(join(root, 'index.md'), renderMapIndex(records, board.manifest), 'utf8');
  return records.length;
}

// Materialize FOOTPRINTS.md — the footprint read-model. Joins the worktree stamps in
// the log to each record via the cards that ref it. Derived + regenerable, like the
// maps; a sibling view under views/.
async function writeFootprints(board, dir, dataDir) {
  const cards = (await board.pool()).map((c) => ({
    id: c.id,
    handle: c.slug ? `${c.slug}@${c.id.slice(0, 8)}` : c.id.slice(0, 8),
    refs: c.payload?.refs,
  }));
  const records = await loadRecords(board.manifest, dir);
  const events = await board.events();
  const out = join(dataDir, 'views', 'FOOTPRINTS.md');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderFootprints(records, cards, events), 'utf8');
}

// Materialize CURATION.md — the curation read-model. Ranks records by churn-since-verified:
// commits touching a record's footprint since its `verified:` sha. The git counts happen
// here (impure), keyed by curie, so the renderer stays pure + fixture-testable. Sibling of
// FOOTPRINTS.md under views/.
async function writeCuration(board, dir, dataDir) {
  const cards = (await board.pool()).map((c) => ({
    id: c.id,
    handle: c.slug ? `${c.slug}@${c.id.slice(0, 8)}` : c.id.slice(0, 8),
    refs: c.payload?.refs,
  }));
  const records = await loadRecords(board.manifest, dir, { withBody: true }); // bodies feed the shape annotation (line-count/marker signals)
  const events = await board.events();
  const footprints = recordFootprints(records, cards, events);
  const churn = (curie) => {
    const r = records.find((x) => x.curie === curie);
    const stamp = typeof r?.verified === 'string' ? r.verified : null;
    if (!stamp?.startsWith('git:')) return null;
    const paths = [...(footprints.get(curie) ?? new Map()).keys()];
    if (!paths.length) return null;
    return gitChurnCount(dir, stamp.slice(4), paths);
  };
  const out = join(dataDir, 'views', 'CURATION.md');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderCuration(records, cards, events, { churn }), 'utf8');
}

// Count commits since `sha` that touched any of `paths` (repo-relative). Fail-soft like
// gitObserver: no git / bad sha / not a repo → null, so churn degrades to n/a, never throws.
function gitChurnCount(dir, sha, paths) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-list', '--count', `${sha}..HEAD`, '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // git absent / unknown sha / not a repo — no churn to report
  }
}

// Humanize a procedure's last-run ISO for the listing: 'never ran' when absent, else a
// coarse 'last ran Nd/Nh ago' (day granularity is what a cadence reads — no false
// precision). The DUE flag rides alongside; this is just the clock.
function lastRanLabel(iso) {
  if (!iso) return 'never ran';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'last ran just now';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `last ran ${d}d ago`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `last ran ${h}h ago` : 'last ran just now';
}

// The commits since `sha` over `paths` — short sha · date · subject, newest first, capped.
// Fail-soft (→ null) and the same repo-relative path contract as gitChurnCount.
function gitLogSince(dir, sha, paths, cap = 15) {
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '--format=%h·%ad·%s', '--date=short', `${sha}..HEAD`, '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const all = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { commits: all.slice(0, cap), more: Math.max(0, all.length - cap) };
  } catch {
    return null; // git absent / unknown sha / not a repo — no evidence to show
  }
}

// The derived layer init and upgrade both rebuild — declared in ONE place so the two
// can never drift (the bug that left upgrade not refreshing the anchors, then the
// .gitignore). compile/reconcile/map keep calling the targeted writers directly.
async function regenerateGenerated(board, dir, dataDir) {
  await writeFile(join(dataDir, '.gitignore'), DATA_GITIGNORE, 'utf8');
  await writeCompiled(dataDir, board.manifest);
  await rematerialize(board, dataDir);
  await writeMaps(board, dir, dataDir);
}

// The root discovery anchors — kept out of regenerateGenerated because init guards them
// on `@` workflow installs and logs per file, while upgrade writes them unconditionally.
async function writeAnchors(dir) {
  return {
    agents: await upsertSection(join(dir, 'AGENTS.md'), ANCHOR_AGENTS),
    claude: await upsertSection(join(dir, 'CLAUDE.md'), ANCHOR_CLAUDE),
  };
}

// Resolution status of one forward edge's target (advisory; never blocks).
async function resolveMark(target, root, known) {
  if (known?.has(target.curie)) return '✓';
  if (!target.known) return '⚠ unknown type';
  if (target.nested) return known?.has(target.curie) ? '✓ (nested)' : '⚠ dangling'; // resolved via the record index
  if (target.path == null) return '~ handle';
  if (target.templated) {
    const hits = await indexDocs(root, target.path.replace(/\{[^}]+\}/g, '*'));
    return hits.length ? `✓ ${hits.length} match(es)` : '⚠ unresolved';
  }
  return existsSync(resolve(root, target.path)) ? `✓ ${target.path}` : `⚠ dangling (${target.path})`;
}

// CURIEs more than one record claims — a uniqueness violation within a type's subtree
// (nesting derives the parent from the folder, so a slug must stay unique). Advisory:
// warned, not enforced — consistent with how dangling refs are surfaced.
function duplicateCuries(records) {
  const n = new Map();
  for (const r of records) if (r.curie) n.set(r.curie, (n.get(r.curie) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([c]) => c);
}

// The target record's lifecycle status as a tag, checked against the type's codified
// set (the first read-time shape-check). '' when the target has no status.
function statusTag(manifest, records, curie) {
  const rec = records.find((r) => r.curie === curie);
  if (!rec || rec.status == null) return ''; // existence is implicit; only a declared status shows
  const terms = vocabTerms(typeDef(manifest, parseCurie(curie)?.type ?? '')?.status?.values);
  const bad = terms.length && !terms.includes(rec.status);
  return ` [${rec.status}${bad ? ` ⚠ not in ${terms.join('|')}` : ''}]`;
}

function printNeighborhood(nb) {
  console.log(`neighborhood · ${nb.start} (${nb.nodes.length} node(s))`);
  if (!nb.edges.length) return console.log('  (no edges)');
  const lbl = (key) => (nb.label.get(key)?.kind === 'card' ? `card:${key.slice(0, 8)}` : key);
  const seen = new Set();
  for (const e of nb.edges) {
    const sig = `${e.from}|${e.rel}|${e.to}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    console.log(`  ${lbl(e.from)}  —${e.rel}→  ${lbl(e.to)}`);
  }
}

// Run the pluggable extractor over one file. The same shell-out model as hooks:
// the command reads $KANBENTO_FILE (+ ontology hints) and prints JSON relations.
function runExtractor(cmd, absPath, rec, manifest, known = []) {
  try {
    return execFileSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KANBENTO_FILE: absPath,
        KANBENTO_CURIE: rec.curie ?? '',
        KANBENTO_TYPES: (manifest.types ?? []).map((t) => t.id).join(','),
        KANBENTO_RECORDS: known.join('\n'), // candidate CURIEs the extractor may link to
      },
    });
  } catch {
    return '';
  }
}

function parseRels(out) {
  const m = String(out).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

// Bound open extraction: keep at most `n` relation edges from one artifact, in the
// extractor's (salience-ranked) order. The hard limit, independent of the prompt.
function capRels(rels, n) {
  if (!rels) return rels;
  let left = n;
  const out = {};
  for (const k of Object.keys(rels)) {
    if (left <= 0) break;
    const list = (Array.isArray(rels[k]) ? rels[k] : [rels[k]]).slice(0, left);
    if (list.length) {
      out[k] = list;
      left -= list.length;
    }
  }
  return out;
}

function printProgram(p) {
  console.log(`  wip: ${p.wipEnforcement}`);
  console.log(
    `  stages: ${p.stages
      .map((s) => `${s.id}(${s.role}${s.wip != null ? ` wip=${s.wip}` : ''}${s.gate ? ` gate=dor${s.gate.entry}/dod${s.gate.exit}${s.gate.agreement ? '+agr' : ''}` : ''})`)
      .join(' -> ')}`,
  );
  console.log(`  types: ${Array.isArray(p.types) ? p.types.join(', ') || '(none)' : p.types}`);
  if (p.flows.length) console.log(`  flows: ${p.flows.map((f) => `${f.from}->${f.to}(${f.kind})`).join(', ')}`);
}

function printChangeset(cs) {
  console.log('structural changes since baseline:');
  for (const id of cs.stages.added) console.log(`  + stage ${id}`);
  for (const id of cs.stages.removed) console.log(`  - stage ${id}`);
  for (const r of cs.stages.renamed) console.log(`  ~ stage ${r.from} -> ${r.to} (rename inferred)`);
  for (const c of cs.stages.changed) {
    const parts = [];
    if (c.wip) parts.push(`wip ${c.wip[0]} -> ${c.wip[1]}`);
    if (c.role) parts.push(`role ${c.role[0]} -> ${c.role[1]}`);
    if (c.gate) parts.push(`gate ${c.gate}`);
    console.log(`  ~ stage ${c.id}: ${parts.join(', ')}`);
  }
  for (const t of cs.types.added) console.log(`  + type ${t}`);
  for (const t of cs.types.removed) console.log(`  - type ${t}`);
  for (const f of cs.flows.added) console.log(`  + flow ${f.from}->${f.to} (${f.kind})`);
  for (const f of cs.flows.removed) console.log(`  - flow ${f.from}->${f.to} (${f.kind})`);
  for (const l of cs.lanes.added) console.log(`  + lane ${l}`);
  for (const l of cs.lanes.removed) console.log(`  - lane ${l}`);
  for (const c of cs.classes.added) console.log(`  + class ${c}`);
  for (const c of cs.classes.removed) console.log(`  - class ${c}`);
  for (const r of cs.relations?.added ?? []) console.log(`  + relation ${r}`);
  for (const r of cs.relations?.removed ?? []) console.log(`  - relation ${r}`);
}

// Best-effort: is this board committed to git? (Upgrades regenerate files; git is
// the safety net.) Returns true when we can't tell, so we never nag spuriously.
function gitTracked(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files', '.kanbento'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return true; // not a git repo (or git missing) — don't nag, and don't leak git's stderr
  }
}
