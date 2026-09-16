// Per-harness sandbox profiles — DATA, not logic. What each harness binary itself
// needs inside the `do --exec` sandbox just to boot and think: its own config dir
// writable, its API reachable. Keyed by the basename of the runner template's first
// token (`claude -p …` → `claude`). An unknown harness simply has no row — the
// caller warns and proceeds with the floor + the procedure's declared grants.
//
// Shape per row: { write: [paths], read: [paths], network: [domains], env: [keys] }
// — the paths/domains merge into the srt config by deriveSandboxConfig; `env` is
// the ALLOWLIST of process.env keys the harness SESSION carries (its own API
// credential), consumed by harnessEnv (runnercmd.js). `~` expansion is srt's own
// (its path fields accept ~-prefixed globs).
//
// The claude row was verified empirically 2026-07-14 (procedure-runner@bce35f33):
// a full `claude -p` session runs sandboxed with exactly these grants.
export const HARNESS_PROFILES = {
  claude: {
    write: ['~/.claude', '~/.claude.json', '/tmp'],
    read: ['~'],
    network: ['*.anthropic.com', 'api.anthropic.com', 'sentry.io', '*.sentry.io'],
    // The session's own credential — the only secret it legitimately needs. Every
    // other secret in the operator's env (GH_TOKEN, npm/cloud tokens) stays OUT:
    // the session reads UNTRUSTED procedure input and must not inherit them.
    env: ['ANTHROPIC_API_KEY'],
  },
};

// Per-harness TOOL-GRANT grammar — how a harness's own CLI accepts a scoped
// permission grant, so the record's declared `runner.tools` (a list of rules)
// flows to EACH harness as least-privilege scoping, not just claude. DATA, not
// logic: the renderer (renderToolGrant, runnercmd.js) expands `{tools}` per the
// resolved harness's row.
//
// Kept SEPARATE from HARNESS_PROFILES on purpose. A profile row asserts an
// empirically-verified SANDBOX boot grant (its own config dir, its API host); a
// tool-grammar row is just the CLI's documented flag syntax, cheap to declare and
// carrying no such claim. Separating them lets grok carry a faithful grant grammar
// WITHOUT implying a sandbox profile it does not yet have (which would also silence
// the "no sandbox profile" warning in prepareSandbox).
//
// Shape per row — one of two grammars {tools} expands into:
//   { join: ',' }        one flag, value = the rules joined (claude: the template
//                        supplies `--allowedTools`, so {tools} → `A,B`)
//   { flag: '--allow' }  the flag REPEATS per rule ({tools} → `--allow A --allow B`;
//                        the flag is PART of the expansion, not the template)
// A harness with no row falls back to comma-join — the pre-existing behavior.
export const HARNESS_TOOL_GRAMMAR = {
  claude: { join: ',' },
  grok: { flag: '--allow' },
  // codex: omitted until its per-tool grant flag is confirmed — falls back to
  // comma-join rather than guess a grammar.
};
