# kanbento

**A kanban board that lives in your repo and is operated by agents.**

Work coordination for the agentic world: the board is a directory (`.kanbento/`),
state is an append-only event log, and the humans hold the gates while agents do
the work. No server, no signup, no UI to visit — an agent runs one command and
the board exists, versioned alongside the code it coordinates.

```
npm install -g kanbento
```

## 60 seconds

```bash
cd your-repo
kanbento init                      # board + operating guide + root anchors
                                   #   (--template 2..5 picks the flow depth; default 4:
                                   #    options → committed → active → done)
kanbento capture --slug login-fix "ship the login fix"
kanbento commit login-fix          # cross the commitment point
kanbento transition login-fix in_progress
kanbento transition login-fix done
```

Every command appends events to `.kanbento/events.jsonl` and re-renders
`.kanbento/views/BOARD.md` — a markdown map of every card and where it sits.
Humans read the views; agents read them too, then act through the CLI.

## Why it's shaped this way

- **The repo is the substrate.** Agents already live in your repo. A hosted
  tracker makes every agent round-trip an API call and makes the human the sync
  bottleneck; a board in the repo travels with branches, clones, and worktrees.
  `.kanbento/` is to work what `.git/` is to history.
- **Events, not state.** Nothing is stored except an append-only JSONL log;
  every view is a fold over it. You get history, audit, and blame for *work*
  the same way git gives it to you for code — who decided what, when, at which
  gate.
- **A real process model, not a todo list.** Options sit left of an explicit
  **commitment point**; WIP limits bound the committed stages; Definition of
  Ready / Definition of Done criteria are evaluated at stage entry and exit.
  This is Kanban as agents can execute it — the flow discipline is data, not
  tribal knowledge.
- **Knowledge is first-class, separate from flow.** Cards are imperatives
  ("do once"); records and notes are declaratives ("this holds"). The knowledge
  layer accumulates while cards come and go.

## The board

A board is defined by a manifest (`.kanbento/manifest.json`) describing stages,
WIP limits, gates, types, and relations. `kanbento schema` prints the full
grammar. The default flow (`--template 4`; rung 5 adds an `↻` acceptance
checkpoint before delivery):

```
○ backlog  →  ◆ selected  →  ▶ in_progress  →  ✓ done
  options     commit          active            delivered
```

- `○` **options** — captured, uncommitted, discardable. Capture freely; the
  inbox is where ideas wait to earn commitment.
- `◆` **the commitment point** — crossing it is a decision (`kanbento commit`).
  Its entry gate is your Definition of Ready.
- `▶` / `↻` **committed work** — WIP-limited stages; `↻` marks a checkpoint
  with a feedback edge back (review loops are declared flow edges, not
  exceptions).
- `✓` **done** — the delivery point; its entry gate is your Definition of Done.

Gates are **advisory by default**: an agent (or a hook) evaluates the criteria
and records a verdict on the event log — approve or veto, with the reason kept
forever. Structure is added when the flow earns it, not up front.

## Cards, records, notes

```bash
kanbento capture "fix the flaky auth test" --type bug      # a flow card
kanbento note "retry backoff decision" --slug retry-policy # knowledge, no stage
kanbento elaborate retry-policy -F decision.md             # give it a body
```

Flow types (`story`, `bug`, yours) move through stages. **Record types** you
declare in the manifest (`flow: false`) are the knowledge layer: each record is
a markdown file with frontmatter, a lifecycle status of your choosing, and a
stable address — a CURIE like `capability:auth` — independent of where the file
lives. Records never appear on the board; they accumulate, get revised, and get
verified.

## Relations — the graph

```bash
kanbento link fix-auth blocks release-v2
kanbento link fix-auth advances capability:auth
kanbento refs capability:auth            # backlinks: everything advancing it
kanbento refs --from fix-auth            # a card's forward edges
```

Typed edges connect cards and records alike: `blocks`, `parent`, `sibling`,
plus contribution edges (`advances`, `implements`) with derived inverses.
Root records project into `views/PORTFOLIO.md` — a position book showing where
investment (cards advancing each position) is actually going.

## Routines — knowing-how as a command

```bash
kanbento procedures        # list them, with last-ran / due
kanbento do curate         # print one: instructions + precedents + pointers
```

A **procedure** is executable knowledge — a recipe an agent runs with judgment,
not a script. Procedures are markdown records with an optional `cadence:`
(`7d`, `20 commits`); invocations are logged, so due-ness is derived, not
scheduled. Three built-ins ship with the CLI: `pulse` (orient: what needs
attention), `curate` (knowledge upkeep), and `status-update` (draft an outbound
status report from local evidence — git + board events — for the human to
approve and send). A built-in can be a folder co-locating deterministic
extraction scripts with the prose. Boards add their own, and a local procedure
with a built-in's name overrides it.

Harness-independent by construction: any agent that can run a CLI can run
`kanbento do pulse` — or be pointed at it with `claude -p "kanbento do pulse"`.

**Experimental:** a routine with a daily cadence can be handed to the OS scheduler with
`kanbento schedule <procedure> [--at HH:MM]` (`--remove` to deregister, bare
`kanbento schedule` to list). kanbento never runs a daemon: it registers a
launchd agent (macOS) that fires `kanbento schedule <slug> --fire` on the
schedule. `--fire` is a two-stage job — a deterministic guard (skip unless the
cadence window has elapsed) then a headless agent run that **halts at the
consent gate**: it drafts, it never sends. A procedure can declare its
least-privilege runner needs in a `runner:` block (a model suggestion and a
`tools:` list) next to its `cadence:`. The effective grant — declaration overlaid
by any home-config override — is resolved and **frozen at registration**:
registering is the consent act, and `--fire` assembles the runner from the frozen
grant alone, never a live re-read (so editing a procedure.md can't silently
escalate its own permissions — a changed declaration prints a re-register
warning in the listing). `~/.kanbento/config.json` holds the harness template
(`runner`, e.g. `claude -p {prompt} --model {model} --allowedTools {tools}`, with
`{prompt}`/`{model}`/`{tools}` placeholders; a template without `{prompt}` gets
the prompt appended at the end) plus per-procedure overrides (`procedures.<slug>`).

## Cases — decisions that compound

```bash
kanbento cases taxonomy    # the decision categories this board has learned
kanbento cases retain discard-junk-capture --about a1b2c3 --why "..."
```

When an operator (human or agent) makes a judgment call, it can be retained as
a **precedent** under a case category. The next agent facing the same class of
decision reads the taxonomy and reasons from precedent instead of from scratch.
This corpus is board-local and compounds with use.

## Grounding — the board meets the working tree

Every verb observes the git worktree at execution time and stamps events with
the branch and dirty set — the model↔world join captured live, not
reconstructed from commit archaeology later.

```bash
kanbento reaffirm capability:auth   # "checked against the code; still holds"
kanbento map                        # per-record graph views + curation queue
```

`reaffirm` stamps a record with `verified: git:<sha>`; the curation view ranks
records by code churn since their last verification, so knowledge that has
drifted from reality surfaces first.

## Working across boards

```bash
kanbento request @platform "need a staging database for auth tests"
kanbento network view delivery       # the cross-board view
```

Boards connect as a **projection, never a protocol**: a network's state is read
from its member boards at render time — no event bus, no cross-board
transaction, no board can stall another. `request` pushes a card-creation
request into another board's inbox (it lands as an option; the owner decides).
Networks are declared by their members and discovered by scanning the tree,
docker-compose style.

## Built for agents, legible to humans

`kanbento init` writes an **operating guide** (`.kanbento/AGENTS.md`) — the
generated contract any agent can read: what the stages mean, what the gates
require, which verbs exist — plus root anchors so agents discover the board
mid-task. State is always readable as markdown under `.kanbento/views/`; the
CLI is the only writer. Humans review the views, hold the gates, and adjust
the manifest; agents do everything else.

## Commands

Run `kanbento --help` for the full list, `kanbento <cmd> --help` for any verb.
The essentials:

| verb | does |
|------|------|
| `init` | create a board (manifest + guide + anchors) |
| `capture` / `note` | add work to the inbox / add knowledge to the layer |
| `commit` / `transition` / `archive` | move cards; cross the commitment point |
| `elaborate` / `link` / `refs` | bodies, typed edges, backlinks |
| `procedures` / `do` | list / run executable knowledge |
| `cases` | decision taxonomy + precedents |
| `reaffirm` / `map` / `lint` | verification stamps, graph views, conventions check |
| `request` / `network` | cross-board requests and views |
| `board` / `pool` / `card` / `events` | read state at any granularity |
| `schema` / `compile` / `diff` / `reconcile` | the manifest and its evolution |

## Requirements

Node.js ≥ 22. Git is optional but recommended — worktree stamps,
principal attribution, and verification pins degrade gracefully without it.

## License

[FSL-1.1-Apache-2.0](./LICENSE) — free to use, modify, and redistribute for
anything except offering kanbento itself as a competing service; each release
automatically becomes Apache-2.0 two years after publication. The license only
ever loosens.
