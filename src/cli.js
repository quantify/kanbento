#!/usr/bin/env node
import { Command } from 'commander';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { openBoard } from './kernel.js';
import { FileLog } from './eventlog.js';
import { resolveBoardDir, resolveInitTarget, manifestPathIn, dataDirIn, hasManifest, repoRoot, registerBoard, gitObserver, gitIdentity } from './boards.js';
import { compile, diffCompiled, isEmptyChangeset, reconcileMoves } from './compile.js';
import { indexRecords, indexDocs } from './binding.js';
import { forwardEdges, collectBacklinks, neighborhood, parseCurie, refEdges, collectFrontier, stageProcedurePath, stageAgreementPath, presentIncoming } from './refs.js';
import { parseAgreement } from './agreement.js';
import { lintRecords } from './lint.js';
import { renderMap, renderMapIndex, renderFootprints, renderCuration, recordFootprints } from './map.js';
import { writeFrontmatterBlock, writeFrontmatterField } from './frontmatter.js';
import { execFileSync, spawn } from 'node:child_process';
import { execCommand } from './hooks.js';
import { materialize, materializeNetwork, renderNetwork, renderBoard, renderPortfolio, writeProjection, handle } from './projection.js';
import { slugify } from './slug.js';
import { resolveBody, editFile } from './input.js';
import { renderAgents } from './agents.js';
import { EVOLVING_MD } from './evolving.js';
import { renderSchema } from './protocol.js';
import { loadManifest, mergeManifests, typeDef, vocabTerms, embodiedTypes, recordTypes, portfolioTypes } from './manifest.js';
import { discoverBoards, deriveRoster, discoverNetworks, anchorOf } from './network.js';
import { retain as retainCase, taxonomy as caseTaxonomy } from './cases.js';
import { captureCard, noteCard, elaborateCard, reaffirmCard, applyReslug, syncBoard, parseLane, mergeRefs, linkRefs, unlinkRefs, resolvePiece, listSkills, assembleProcedure, revisedStale } from './commands.js';

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

// .kanbento/.gitignore written by init: ignore regenerated state. The manifest,
// compiled.json (drift baseline), AGENTS.md guide, and events.jsonl log stay committed.
const DATA_GITIGNORE = ['# kanbento — generated state, regenerated on demand', 'views/', 'runs/', '*.tmp', 'last-engineered-context.txt', ''].join('\n');

// --- board context ----------------------------------------------------------

// Open the board named by the global --board (for verbs that operate on one).
async function openCtx() {
  const g = program.opts();
  const { dir } = resolveBoardDir(g.board);
  const manifestPath = g.manifest ? resolve(g.manifest) : manifestPathIn(dir);
  if (!existsSync(manifestPath)) {
    throw new Error(`no board at ${dir} — run: kanbento init ${g.board ?? ''}`.trim());
  }
  const dataDir = dataDirIn(dir);
  const board = await openBoard({ manifestPath, log: new FileLog(join(dataDir, 'events.jsonl')), boardDir: dir, observe: gitObserver(dir), identify: gitIdentity(dir) });
  board.on('hook', (e) => {
    if (e.phase === 'before') console.error(`  hook ${e.hook}: ${e.verdict.approve ? 'approve' : 'VETO'} — ${e.verdict.reason}`);
    else if (e.output) console.error(`  hook ${e.hook}: ${e.output}`);
  });
  return { board, dir, dataDir };
}

// Write-through after a state change: re-render the read-model projection.
const rematerialize = (board, dataDir) => materialize(board, join(dataDir, 'views', 'BOARD.md'));

// One shape for every state-changing verb: open the board, act, re-render the read
// model. The wrapper owns rematerialize, so a handler cannot forget it and leave a
// stale BOARD.md. Read-only verbs keep calling openCtx() directly.
const act = (fn) => async (...args) => {
  const ctx = await openCtx();
  await fn(ctx, ...args);
  await rematerialize(ctx.board, ctx.dataDir);
};

// Render a network by name: derive its roster from the discovered boards (the
// members that declare it), open each member's read model, and project. Persists
// to the anchor board (the one named like the network) when present; else prints.
async function renderNetworkFor(name, boards) {
  const members = [];
  for (const r of deriveRoster(boards, name)) {
    try {
      const b = await openBoard({ manifestPath: manifestPathIn(r.location), log: new FileLog(join(dataDirIn(r.location), 'events.jsonl')), boardDir: r.location });
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

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';

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
  .option('--id <id>', 'board id (else derived from the target dir; overrides a --from seed\'s identity)')
  .option('--name <name>', 'board display name (defaults to the id)')
  .action(async (target, opts) => {
    const { dir, label } = resolveInitTarget(target ?? program.opts().board);
    await initBoard(dir, label, opts.from, { id: opts.id, name: opts.name });
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
  .option('--source <src>', 'attribution', 'agent')
  .option('--key <idem>', 'idempotency key — re-runs return the same card')
  .option('--lane <pair...>', 'set partition field(s), e.g. website=site-a (a lane axis derives from them)')
  .option('--rel <pair...>', 'typed relation key=type:slug — the families: advances=capability:x · evidence=strategy:y · about=note:z (key:curie also accepted; sets payload.refs.<key>)')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin); a rich body is bound as the card doc (one-step capture + elaborate); with inline text too, the text stays the title')
  .option('--title <text>', "one-line title (overrides a title derived from the text/body — the sibling of request --title)")
  .action(act(async ({ board, dir }, text, opts) => {
    const body = resolveBody(text, opts, { noEditor: true }); // inline text, -F <file>, or piped stdin
    // An explicit --title wins; else inline text AND -F together means the text is the
    // title and the file the body — so the file's first line can't silently overwrite it.
    const title = opts.title ?? (opts.bodyFile && text?.length ? text.join(' ') : undefined);
    // A body from -F/stdin is a document (not a one-liner), so bind it as the card's doc —
    // the one-step form of capture-then-elaborate. Inline text stays a plain inline body.
    const richBody = !!opts.bodyFile || (!(text && text.length) && !process.stdin.isTTY);
    const { card, artifact, boundDoc } = await captureCard({ board, dir }, body, { ...opts, richBody, title });
    console.log(`captured \`${handle(card)}\``); // the handle — what you pull/transition with
    console.log(`  ${card.title}`);
    console.log(`  ${card.id}  ·  state=${card.state}  type=${card.type ?? 'untyped'}`);
    if (artifact) console.log(`  → ${artifact.show}  (${artifact.workspace ? 'workspace' : 'tracked'} — start here)`);
    if (boundDoc) console.log(`  → ${boundDoc}  (doc)`);
    surfaceContract(board.manifest, card.state, dir); // capture lands a card in a stage too — surface its contract
    if (!opts.slug) fireReslug(card.id, dir); // auto-sharpen a DERIVED slug in the background; an explicit --slug is sacred
  }));

program
  .command('note')
  .argument('[text...]', 'the knowledge to keep (or use -F / piped stdin)')
  .summary('capture a unit of knowledge — a file in the knowledge layer, not a card (no status, never on the board)')
  .option('--type <type>', 'record type, flow:false (default: the builtin note -> .kanbento/notes/{slug}.md)')
  .option('--slug <slug>', 'pin the filename slug (else derived from the first line)')
  .option('--rel <pair...>', 'typed relation key=type:slug — the families: advances=capability:x · evidence=strategy:y · about=note:z (key:curie also accepted; sets frontmatter refs.<key>)')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin); with inline text too, the text stays the title')
  .action(async (text, opts) => {
    const { board, dir } = await openCtx(); // no board mutation — the file IS the write model, nothing to rematerialize
    const body = resolveBody(text, opts, { noEditor: true });
    const title = opts.bodyFile && text?.length ? text.join(' ') : undefined;
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
  .action(act(async ({ board }, from, into, opts) => {
    const card = await board.merge(from, into, { title: opts.title });
    console.log(`merged ${from} → \`${handle(card)}\` "${card.title}"`);
  }));

program
  .command('pool')
  .summary('list every card')
  .action(async () => {
    const { board } = await openCtx();
    const cards = await board.pool();
    if (!cards.length) return console.log('(pool is empty)');
    for (const c of cards) {
      const iter = c.iterationCount ? `  ↺${c.iterationCount}` : '';
      console.log(`${handle(c)}  [${c.state}]  ${c.type ?? 'untyped'}  ${c.title}${iter}`);
    }
    console.log(`\n${cards.length} card(s)`);
  });

program
  .command('card')
  .argument('<ref>', 'card handle slug@id, or a bare id, slug, CURIE, or unique prefix')
  .summary('print one card as JSON')
  .action(async (ref) => {
    const { board } = await openCtx();
    const c = await board.card(ref);
    console.log(c ? JSON.stringify(c, null, 2) : `(no card matching "${ref}")`);
  });

program
  .command('elaborate')
  .argument('<ref>', 'card or record to give a body — a card materializes its doc on first use; a record (e.g. a capability) accretes')
  .argument('[text...]', 'inline body (or use -F / piped stdin; or none, to open $EDITOR on the doc)')
  .summary('write a body onto a card (a bound doc) or append to a record — materialized on demand')
  .option('-F, --body-file <path>', 'read the body from a file (- for stdin)')
  .option('--title <text>', "correct the card's title in the same breath — titles rot as understanding improves (appends CardRetitled; the doc's frontmatter follows)")
  .action(act(async ({ board, dir }, ref, text, opts) => {
    const content = resolveBody(text, opts, { noEditor: true }); // file / inline / stdin (the editor path is in-place, below)
    const interactive = !content.trim() && !opts.title && process.stdin.isTTY;
    if (!content.trim() && !opts.title && !interactive) throw new Error('elaborate: no body (inline text, -F <file>, piped stdin, or run it on a terminal to open $EDITOR)');
    const res = await elaborateCard({ board, dir }, ref, content, { title: opts.title });
    if (res.record) { // a record (position) accretes — no retitle, no reslug follow-up
      if (!res.wrote) editFile(resolve(dir, res.rel));
      console.log(`elaborated ${res.record.curie} → ${res.rel}${res.wrote ? '  (appended)' : '  (edited)'}`);
      return;
    }
    const { card, rel, wrote, retitled } = res;
    if (!wrote && !opts.title) editFile(resolve(dir, rel)); // interactive: edit the doc in place (frontmatter + any existing body)
    console.log(`elaborated \`${handle(card)}\` → ${rel}${wrote ? '' : opts.title ? '' : '  (edited)'}${retitled ? '  (retitled)' : ''}`);
    if (retitled) {
      // The framing shifted — let the semantic slug catch up. An explicit --slug
      // stays sacred: ItemCaptured stores a slug only when one was pinned.
      const pinned = (await board.events()).some((e) => e.type === 'ItemCaptured' && e.cardId === card.id && e.slug);
      if (!pinned) fireReslug(card.id, dir);
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
  .option('--about <ref>', 'what the decision was about (a card handle or CURIE) — provenance')
  .option('--when <text>', 'for a NEW category: the criterion that says when this precedent class applies')
  .action(async (category, opts) => {
    const { dir } = await openCtx();
    const at = new Date().toISOString().slice(0, 10);
    const id = randomUUID().slice(0, 6); // a stable handle per precedent (the date alone collides)
    const res = await retainCase(dir, { category, at, id, ...opts });
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
    for (const s of skills)
      console.log(`${s.curie}${s.status ? ` · ${s.status}` : ''}${s.builtin ? ' · builtin' : ''} · ${lastRanLabel(s.lastRan)}${s.due ? ' · DUE' : ''}`);
    console.log(`\n${skills.length} procedure(s) — run one with: kanbento do <name>`);
  });


program
  .command('do')
  .argument('<name>', 'procedure to serve — its slug or CURIE (e.g. curation-pass or procedure:curation-pass)')
  .summary("print a procedure — instructions + precedents + pointers to its views; execute with judgment")
  .action(async (name) => {
    const { board, dir } = await openCtx();
    const { record, text } = await assembleProcedure({ board, dir }, name);
    // The invocation is a fact kanbento witnesses (the brief was served) — log it here.
    // Execution is presumed; abandonment is the exception, not the modeled case.
    if (record.curie) await board.procedureInvoked(record.curie);
    process.stdout.write(text);
  });

program
  .command('reslug')
  .argument('<ref>', 'card to re-slug')
  .summary('(internal, auto-fired at capture) refine a card slug via the model')
  .action(act(async ({ board, dir }, ref) => {
    const card = await board.card(ref);
    if (!card) return; // gone — best-effort, detached
    const slug = await llmSlug(board.manifest, card);
    if (!slug || slug === card.slug) return;
    const { updated, path } = await applyReslug({ board, dir }, card, slug);
    console.log(`reslugged \`${handle(updated)}\`${path ? ` → ${path}` : ''}  (was ${card.slug})`);
  }));

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
      const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, title: c.title, type: c.type, refs: c.payload?.refs }));
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
      const label = piece.kind === 'card' ? `${piece.card.id.slice(0, 8)} "${piece.card.title}"` : `${piece.record.curie} "${piece.record.title}"`;
      const edges = forwardEdges(board.manifest, refs, { rel: opts.rel, type: opts.type });
      if (!edges.length) return console.log(`${label} — no outgoing refs`);
      console.log(`forward · ${label}`);
      const known = new Set((await loadRecords(board.manifest, dir)).map((r) => r.curie));
      for (const e of edges) console.log(`  ${e.rel}  ${e.curie}  ${await resolveMark(e.target, dir, known)}`);
      return;
    }
    const target = opts.around ?? curie;
    if (!target) throw new Error('refs: give a <curie>, or --from <ref>, or --around <curie>');
    const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, title: c.title, type: c.type, state: c.state, refs: c.payload?.refs }));
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
    console.log(`compiled "${prog.boardId}" (rev ${prog.revision}) -> ${join(dataDir, 'compiled.json')}`);
    console.log(`operating guide -> ${join(dataDir, 'AGENTS.md')}`);
    const pf = await materializePortfolio(board, dir, dataDir);
    if (pf) console.log('portfolio -> ' + pf);
    printProgram(prog);
  });

program
  .command('lint')
  .summary('advisory: check records conform to the schema + conventions (read-only)')
  .option('--format <fmt>', 'text | json', 'text')
  .action(async (opts) => {
    const { board, dir } = await openCtx();
    const cards = (await board.pool()).map((c) => ({ id: c.id, refs: c.payload?.refs }));
    const records = await loadRecords(board.manifest, dir, { withBody: true });
    const { findings, ok } = lintRecords({ cards, records }, board.manifest, { exists: (p) => existsSync(resolve(dir, p)) });
    if (opts.format === 'json') {
      console.log(JSON.stringify(findings, null, 2));
    } else if (ok) {
      console.log('✓ lint clean — every record conforms');
    } else {
      for (const f of findings) console.log(`  ⚠ ${f.kind.padEnd(11)} ${f.ref}  —  ${f.message}`);
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
  .command('diff')
  .summary('show structural changes since the compiled baseline')
  .action(async () => {
    const { board, dataDir } = await openCtx();
    const prog = compile(board.manifest);
    const baselinePath = join(dataDir, 'compiled.json');
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
    const { board, dataDir } = await openCtx();
    const baselinePath = join(dataDir, 'compiled.json');
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
    const { board, dir, dataDir } = await openCtx();
    const baselinePath = join(dataDir, 'compiled.json');
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
      console.log('would regenerate: compiled.json (+ stamp), AGENTS.md, EVOLVING.md, views/, maps, root anchors');
      return;
    }

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
    const { board, dir, dataDir } = await openCtx();
    const markPath = join(dataDir, 'swept.json');
    const since = !opts.all && existsSync(markPath) ? Date.parse(JSON.parse(await readFile(markPath, 'utf8')).at) || 0 : 0;
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
      if (mtimeMs <= since) continue;
      changed++;
      // Refresh the `revised:` edit clock the way `elaborate` does — only elaborate
      // stamped it before, so a hand-edited record kept a stale/absent `revised:`
      // while its content moved on (CURATION.md then under-reported the edit). Stamp
      // TODAY only when the file was modified after its current stamp (or has none):
      // that day-granular staleness test (revisedStale) is idempotent — a restamp sets
      // revised=today and mtime≈now (same day), so an unchanged record is never touched again.
      if (revisedStale(rec.revised, mtimeMs)) {
        await writeFrontmatterField(abs, 'revised', today);
        restamped++;
      }
      if (!extractor) continue;
      const rels = capRels(parseRels(runExtractor(extractor, abs, rec, board.manifest, [...known].filter((c) => c !== rec.curie))), cap);
      if (rels && (await mergeRefs(abs, rec.refs, rels))) {
        enriched++;
        for (const e of refEdges(rels)) known.add(e.curie); // mints feed forward to later artifacts
        console.log(`  enriched ${rec.path}`);
      }
    }
    await writeFile(markPath, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf8');
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

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}

// --- setup (init / install) -------------------------------------------------

async function initBoard(dir, label, from, identity = {}) {
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
    await writeFile(join(dataDir, 'manifest.json'), starterPool(label), 'utf8');
    console.log('manifest: .kanbento/manifest.json (bare pool)');
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
  await writeFile(join(dataDir, 'installed.json'), JSON.stringify({ workflow: { from: srcManifest, hash } }, null, 2) + '\n', 'utf8');

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
    log: new FileLog(join(dataDir, 'events.jsonl')),
    boardDir: dir,
    identify: gitIdentity(dir),
  });
  await regenerateGenerated(board, dir, dataDir);
  console.log('  .kanbento/  manifest · compiled.json · AGENTS.md · EVOLVING.md · views/BOARD.md · views/maps/');
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
    if (c.name() === 'reslug') continue; // internal — auto-fired at capture, not a user-facing verb
    out.push(describe(c));
    for (const sub of c.commands) out.push(describe(sub, `${c.name()} `)); // one level of nesting (e.g. `network join`)
  }
  return out;
}

async function writeCompiled(dataDir, manifest) {
  const prog = compile(manifest);
  prog.toolVersion = VERSION; // stamp what built this baseline; drift detection ignores it
  registerBoard(manifest.board?.id, dirname(dataDir)); // self-record in the machine registry (handle -> dir) so `@id` resolves cross-repo
  await writeFile(join(dataDir, 'compiled.json'), JSON.stringify(prog, null, 2) + '\n', 'utf8');
  await writeFile(join(dataDir, 'AGENTS.md'), renderAgents(manifest, { verbs: describeVerbs() }), 'utf8');
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

function starterPool(label) {
  const id = String(label || 'board').replace(/^@/, '').split(/[\\/]/).pop() || 'board';
  return (
    JSON.stringify(
      {
        manifestVersion: '1.0',
        board: { id, name: id, revision: 0, maturity: 'pool' },
        inbox: { sources: ['human', 'agent', 'request', 'feedback'], landing: 'backlog' },
        stages: [{ id: 'backlog', role: 'options' }],
        policies: { joining: 'A worker announces its capability profile on arrival.' },
        cardSchema: { core: ['id', 'title', 'state', 'createdAt', 'updatedAt'], types: 'open' },
      },
      null,
      2,
    ) + '\n'
  );
}

// --- per-verb helpers -------------------------------------------------------
// (the verb bodies themselves live in commands.js — this file is the transport)

// Surface a stage's contract on entry (pull-mode). An `agreement` (the fuller
// Ready·Body·Done form) wins over a bare `procedure`: show the DoR the work is now under
// and the DoD it must reach; the agent opens the file for the body.
function surfaceContract(manifest, state, dir) {
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
    return;
  }
  const proc = stageProcedurePath(manifest, state);
  if (proc) console.log(`▶ procedure: ${resolve(dir, proc)}`);
}

function printMove({ card, warnings }) {
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log(`${handle(card)}  ->  [${card.state}]  ${card.title}`);
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
  const board = await openBoard({ manifestPath: manifestPathIn(dir), log: new FileLog(join(dataDir, 'events.jsonl')), boardDir: dir, identify: gitIdentity(process.cwd()) });
  const card = await board.capture({ source: `${kind}:${origin}`, body: body.trim(), title, payload: { from: origin } });
  await materialize(board, join(dataDir, 'views', 'BOARD.md')); // refresh the destination's read model
  fireReslug(card.id, dir); // a request IS a capture on the dest board — sharpen its slug there too
  return { card, label, dir };
}

// Ask the fastest model for a semantic slug; slugify the reply so a chatty model
// can't produce a bad handle. Pluggable (manifest.slugEvaluator) — a script stub in
// tests keeps the suite off the network.
async function llmSlug(manifest, card) {
  const cmd = manifest.slugEvaluator ?? 'claude -p --model haiku "$KANBENTO_PROMPT"';
  const detail = card.body && card.body !== card.title ? `\n\nDetail:\n${card.body.slice(0, 600)}` : '';
  const prompt = `Give a short, lowercase, kebab-case slug (2-4 words, no leading verb, no filler) naming this work item by its subject. Reply with ONLY the slug.\n\nTitle: ${card.title}${detail}`;
  const res = await execCommand(cmd, { KANBENTO_PROMPT: prompt });
  return res.ok ? slugify(res.stdout, 48) : null;
}

// Fire the slug refinement in the background — non-blocking, best-effort. The slug is
// advisory (id-keyed), so a sharper handle landing a beat after capture returns is
// safe. Opt out with KANBENTO_NO_RESLUG=1 (tests / CI / bulk imports).
function fireReslug(id, dir) {
  if (process.env.KANBENTO_NO_RESLUG === '1') return;
  try {
    const cli = process.env.KANBENTO_CLI ?? fileURLToPath(import.meta.url);
    spawn(process.execPath, [cli, '--board', dir, 'reslug', id], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort — the heuristic slug stands */ }
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
  const cards = (await board.pool()).map((c) => ({ id: c.id, identity: c.binding?.identity ?? c.id, handle: c.slug ? `${c.slug}@${c.id.slice(0, 8)}` : c.id.slice(0, 8), title: c.title, type: c.type, state: c.state, refs: c.payload?.refs }));
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
  const records = await loadRecords(board.manifest, dir);
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
