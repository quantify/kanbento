import { join, basename, isAbsolute, normalize, resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { kanbentoHome } from './boards.js';
import { HARNESS_PROFILES, HARNESS_TOOL_GRAMMAR } from './harness-profiles.js';

// The RUNNER-COMMAND seam — how kanbento turns a prompt into a harness invocation.
// One runner, three triggers: hand (`do --exec`), clock (`schedule --fire`), CI.
// Everything template-shaped lives here so schedule and do resolve identically:
// the template grammar ({prompt}/{model}/{tools}), the ~/.kanbento/config.json
// read, grant resolution, shell assembly, and (rung 3) the OS sandbox wrap that
// contains the whole harness process via @anthropic-ai/sandbox-runtime.

// The harness flag grammar lives HERE, in one named constant — never scattered
// through logic. A config.json without a `runner` key gets this default FOR
// SCHEDULE (the deployed harness, Claude Code, works out of the box); `do --exec`
// deliberately has NO default — the harness is named explicitly (flag/env/config).
// Placeholders: {prompt}, {model}, {tools} (tools rendered per the resolved
// harness's grant grammar — comma-joined for claude, repeated --allow for grok;
// see renderToolGrant). The prompt
// sits BEFORE --allowedTools: that flag is VARIADIC in the claude CLI, so a
// trailing positional prompt would be swallowed as another tool name.
export const DEFAULT_RUNNER_TEMPLATE = 'claude -p {prompt} --model {model} --allowedTools {tools}';

// Read ~/.kanbento/config.json (under KANBENTO_HOME). Returns {} when absent or
// unreadable — every consumer defaults from there.
export async function readConfig() {
  try {
    return JSON.parse(await readFile(join(kanbentoHome(), 'config.json'), 'utf8'));
  } catch {
    return {}; // no config — callers default
  }
}

// The runner TEMPLATE: an explicit config.json `runner` string, else the default template.
export function runnerTemplate(cfg) {
  return typeof cfg.runner === 'string' ? cfg.runner : DEFAULT_RUNNER_TEMPLATE;
}

// The `do --exec` template — EXPLICIT, no detection, no PATH probing, no claude
// default: the flag's own value ("--exec 'claude -p'"), else the KANBENTO_RUNNER
// env override, else config.json's `runner`. Nothing set is an error naming all
// three ways (an implicit harness would be a silent grant of the whole session).
export async function resolveExecTemplate(flagValue = null) {
  if (typeof flagValue === 'string' && flagValue.trim()) return flagValue.trim();
  if (process.env.KANBENTO_RUNNER) return process.env.KANBENTO_RUNNER;
  const cfg = await readConfig();
  if (typeof cfg.runner === 'string') return cfg.runner;
  throw new Error(
    'do --exec: no harness command — pass one (--exec "claude -p"), set KANBENTO_RUNNER, or set `runner` in ~/.kanbento/config.json',
  );
}

// Resolve the effective grant: declared frontmatter defaults, overlaid by the home
// config's per-procedure override (override wins wholesale, per key). Model absent
// → null (inherit the runner default); tools absent → [] (no extra grant).
export function resolveGrant(declared, override) {
  const d = declared ?? {};
  const o = override ?? {};
  return {
    model: o.model ?? d.model ?? null,
    tools: o.tools ?? d.tools ?? [],
  };
}

// A one-line human summary of a grant — printed at register (informed consent) and shown
// in the list + brief. "model=default · tools=Bash(kanbento *), Read" (or "tools=none").
export function grantSummary(grant) {
  const g = grant ?? {};
  const model = g.model || 'default';
  const tools = g.tools?.length ? g.tools.join(', ') : 'none';
  return `model=${model} · tools=${tools}`;
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Run a shell command with inherited stdio (the harness streams straight through
// to the user / the launchd log). Resolves the exit code; a spawn failure is 1.
// `env` (optional) REPLACES the child's environment — the --exec harness-spawn
// path passes a filtered allowlist (harnessEnv) so the untrusted-text-reading
// session never inherits the operator's secrets; omitted (schedule's usage, the
// deterministic hooks) inherits process.env unchanged.
export function runShell(cmd, cwd, env = undefined) {
  return new Promise((res) => {
    const child = spawn('sh', ['-c', cmd], { cwd, stdio: 'inherit', ...(env ? { env } : {}) });
    child.on('exit', (code) => res(code ?? 0));
    child.on('error', () => res(1));
  });
}

// The env the HARNESS SESSION runs with under `do --exec` — a safe baseline plus
// the keys the harness profile declares it needs (its own API credential). An
// ALLOWLIST, not a denylist: only named keys pass, so a newly-invented secret key
// leaks nothing by default. The session reads UNTRUSTED procedure input (issue
// text) — it must never inherit GH_TOKEN, npm/cloud tokens, etc. Applies whether
// sandboxed or not (defense in depth: an unsandboxed observe run still shouldn't
// hand secrets to the agent).
//
// Verified empirically against srt 0.0.65: SandboxManager.wrapWithSandbox injects
// its network plumbing (HTTP_PROXY/HTTPS_PROXY/NO_PROXY/NODE_EXTRA_CA_CERTS/GIT_*/
// … — the whole proxy + CA family) INLINE, as an `env VAR=val …` prefix baked into
// the wrapped command STRING, NOT read from the parent process env. So replacing
// the outer spawn env can't clobber srt's proxy/CA — the allowlist is safe, and a
// denylist fallback is unnecessary. (Only PATH is needed for srt's wrapper to find
// `env`/the shell; it is in the baseline.)
const SAFE_ENV_BASELINE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'SHELL'];

export function harnessEnv(template, base = process.env) {
  const harness = basename((template.trim().split(/\s+/)[0] ?? ''));
  const profile = HARNESS_PROFILES[harness] ?? null;
  const allow = new Set([...SAFE_ENV_BASELINE, ...(profile?.env ?? [])]);
  const env = {};
  for (const k of allow) if (base[k] != null) env[k] = base[k];
  // The LC_* locale family (LC_ALL, LC_CTYPE, …) — pass whichever are present.
  for (const k of Object.keys(base)) if (k.startsWith('LC_') && base[k] != null) env[k] = base[k];
  return env;
}

// Render a list of tool-permission RULES into the resolved harness's grant grammar,
// as a shell-ready fragment: RULES are shell-quoted, FLAGS are not. An empty list
// returns '' so the {tools} substitution's empty-drop still elides a dangling flag.
// Claude joins the rules into one comma value (the template carries `--allowedTools`);
// grok repeats `--allow` per rule (the flag is PART of the expansion). An unknown
// harness (no grammar row) comma-joins — the pre-existing claude-shaped default.
export function renderToolGrant(harness, tools) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  if (!list.length) return '';
  const g = HARNESS_TOOL_GRAMMAR[harness] ?? null;
  if (g?.flag) return list.map((t) => `${g.flag} ${shellQuote(t)}`).join(' ');
  return shellQuote(list.join(g?.join ?? ','));
}

// Substitute {prompt}/{model}/{tools} in a template's whitespace-separated tokens. A grant
// placeholder ({model}/{tools}) that resolves empty is dropped ALONG WITH its adjacent flag
// token (the previous token starting with '-') so nothing dangles — `--model {model}`
// vanishes entirely when the grant has no model. {prompt} is never dropped. {tools} renders
// per the resolved harness's grant grammar (renderToolGrant, keyed off the template's first
// token) — an ALREADY shell-ready fragment, pushed as-is. {prompt}/{model} substitute a raw
// value that IS shell-quoted here: the command runs under `sh -c`, and the default tool
// grammar — `Bash(kanbento *)` — carries parens, spaces, and globs by design; unquoted it
// would misparse.
function substituteTemplate(template, grant, prompt) {
  const harness = basename((template.trim().split(/\s+/)[0] ?? ''));
  const toolsFrag = renderToolGrant(harness, grant?.tools); // '' when the grant has no tools
  const raw = {
    '{prompt}': prompt ?? '',
    '{model}': grant?.model || '',
  };
  const tokens = template.split(/\s+/).filter(Boolean);
  const out = [];
  const dropDanglingFlag = () => { if (out.length && out[out.length - 1].startsWith('-')) out.pop(); };
  for (const tok of tokens) {
    if (tok === '{tools}') {
      if (toolsFrag === '') { dropDanglingFlag(); continue; }
      out.push(toolsFrag); // already shell-ready — do NOT re-quote
    } else if (Object.prototype.hasOwnProperty.call(raw, tok)) {
      const val = raw[tok];
      if (val === '' && tok !== '{prompt}') { dropDanglingFlag(); continue; }
      out.push(shellQuote(val));
    } else {
      out.push(tok);
    }
  }
  return out.join(' ');
}

// Assemble the runner invocation from a template + a grant + the prompt. A template
// carrying {prompt}/{model}/{tools} placeholders gets them substituted (empty grant segments
// dropped); a placeholder-free template (a bare `claude -p`, or the KANBENTO_RUNNER stub) is
// used as-is — grant flags simply don't reach a template that never asked for them. The
// prompt lands where {prompt} says; a template WITHOUT {prompt} gets it appended
// shell-quoted as the FINAL argument (`claude -p <prompt>` — but a variadic flag like
// claude's --allowedTools would swallow a trailing positional, hence the placeholder).
export function assembleRunner(template, grant, prompt) {
  const hasPlaceholder = /\{(prompt|model|tools)\}/.test(template);
  const base = hasPlaceholder ? substituteTemplate(template, grant, prompt) : template;
  if (template.includes('{prompt}')) return base;
  return `${base} ${shellQuote(prompt)}`;
}

// --- the OS sandbox around --exec (rung 3) -----------------------------------

// Procedure `sandbox:` ceiling (runner-sandbox-no-ceiling@0c64a9c1). Profile
// grants are kanbento-owned (harness boot needs) and are NOT ceiling-checked;
// procedure-authored grants are untrusted SKILL.md and must stay under the board
// perimeter: no `/`, no `~`, no `..` escape, no absolute path outside board/run,
// no wildcard network (`*`). Violations fail loud at config derivation — never
// silently widen the perimeter.
export function ceilingProcedureSandbox(sandbox, { runDir, boardDir }) {
  if (sandbox == null) return { write: [], read: [], network: [] };
  if (typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    throw new Error('do: sandbox: must be a map { network, read, write }');
  }
  const list = (v) => (Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : []);
  const under = (base, p) => {
    const b = resolve(base);
    const t = resolve(p);
    return t === b || t.startsWith(b + sep);
  };
  const checkFs = (entries, kind) => {
    const out = [];
    for (const raw of entries) {
      const s = String(raw);
      if (s === '/' || s === '~' || s === '~/' || s.startsWith('~/') || s.startsWith('~\\')) {
        throw new Error(
          `do: sandbox ${kind}: ${JSON.stringify(s)} is above the procedure ceiling ` +
          `(no / or ~ — use run-dir-relative paths or paths under the board)`,
        );
      }
      const norm = normalize(s);
      if (norm === '..' || norm.startsWith(`..${sep}`) || norm.startsWith('../') || norm.split(/[/\\]/).includes('..')) {
        throw new Error(
          `do: sandbox ${kind}: ${JSON.stringify(s)} escapes via .. — not allowed on procedure sandbox:`,
        );
      }
      if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
        if (!under(runDir, s) && !under(boardDir, s)) {
          throw new Error(
            `do: sandbox ${kind}: ${JSON.stringify(s)} is outside the board/run dir — ` +
            `procedure sandbox: cannot widen past the board perimeter`,
          );
        }
      }
      out.push(s);
    }
    return out;
  };
  const checkNet = (entries) => {
    const out = [];
    for (const raw of entries) {
      const s = String(raw).trim();
      if (!s) continue;
      // Wildcard domains are profile-only (harness API reach). A procedure that
      // needs egress names explicit hosts — a PR adding api.evil.com is reviewable;
      // `*` is not.
      if (s === '*' || s.includes('*')) {
        throw new Error(
          `do: sandbox network: ${JSON.stringify(s)} uses a wildcard — ` +
          `procedure sandbox: requires explicit hosts (no *)`,
        );
      }
      out.push(s);
    }
    return out;
  };
  return {
    write: checkFs(list(sandbox.write), 'write'),
    read: checkFs(list(sandbox.read), 'read'),
    network: checkNet(list(sandbox.network)),
  };
}

// Derive the srt config by merging three layers (verified against srt 0.0.65 —
// its zod schema requires EVERY listed field; the README omits some):
//   floor    — the run dir is writable, the board readable, ~/.ssh never readable,
//              no network (the implicit propose/dispose perimeter)
//   manifest — the procedure's `sandbox:` block { network: [...], read: [...], write: [...] }
//              after the procedure ceiling (above); a PR widening access is a visible
//              SKILL.md diff AND must clear the ceiling
//   profile  — the per-harness row from harness-profiles.js (what the harness
//              binary itself needs to boot, e.g. claude's ~/.claude + *.anthropic.com)
// --safe clamps the PROCEDURE's fs+network grants to empty (floor + profile only);
// the harness still reaches its own API via the profile. Formerly only network was
// stripped — write/read kept flowing, contrary to the --safe intuition.
export function deriveSandboxConfig({ runDir, boardDir, sandbox = null, profile = null, safe = false }) {
  const p = profile ?? {};
  const list = (v) => (Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : []);
  const s = ceilingProcedureSandbox(sandbox, { runDir, boardDir });
  // --safe: procedure grants gone; profile (harness boot) + floor remain.
  const procWrite = safe ? [] : s.write;
  const procRead = safe ? [] : s.read;
  const procNet = safe ? [] : s.network;
  return {
    filesystem: {
      allowWrite: [runDir, ...list(p.write), ...procWrite],
      allowRead: [boardDir, ...list(p.read), ...procRead],
      denyRead: ['~/.ssh'],
      denyWrite: [],
    },
    network: {
      allowedDomains: [...list(p.network), ...procNet],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
  };
}

const UNSANDBOXED = (why) => `do --exec: running UNSANDBOXED — ${why}\n`;

// Stand up the sandbox around a harness invocation. Returns a control handle:
//   { sandboxed, wrap(cmd) → cmd', reset() }
// Degradation is LOUD but never fatal: srt missing (an optionalDependency),
// an unsupported platform, --no-sandbox, or an init failure all warn
// "running UNSANDBOXED" on stderr and hand back identity wrap/reset — the
// propose/dispose architecture still holds; containment is the layer lost.
export async function prepareSandbox({ template, runDir, boardDir, sandbox = null, safe = false, disabled = false, stderr = process.stderr }) {
  const none = { sandboxed: false, wrap: async (cmd) => cmd, reset: async () => {} };
  // Ceiling check ALWAYS runs (even under --no-sandbox / srt-missing): a procedure
  // that asks for write:/ or network:* is a contract violation, not a soft degrade.
  // deriveSandboxConfig applies the ceiling; --safe still strips procedure grants.
  const harness = basename((template.trim().split(/\s+/)[0] ?? ''));
  const profile = HARNESS_PROFILES[harness] ?? null;
  // Throws on ceiling violation — do NOT catch this into the UNSANDBOXED path.
  const cfg = deriveSandboxConfig({ runDir, boardDir, sandbox, profile, safe });
  if (disabled) {
    stderr.write(UNSANDBOXED('--no-sandbox'));
    return none;
  }
  let srt;
  try {
    srt = await import('@anthropic-ai/sandbox-runtime');
  } catch {
    stderr.write(UNSANDBOXED('@anthropic-ai/sandbox-runtime is not installed (npm i @anthropic-ai/sandbox-runtime)'));
    return none;
  }
  const { SandboxManager } = srt;
  try {
    if (SandboxManager.isSupportedPlatform && !SandboxManager.isSupportedPlatform()) {
      stderr.write(UNSANDBOXED(`platform ${process.platform} is not supported by the sandbox runtime`));
      return none;
    }
    // The profile keys off the harness binary — the basename of the template's first
    // token (`claude -p …` → claude). An unknown harness gets no profile, loudly:
    // the floor + the procedure's declared grants still apply.
    if (!profile) stderr.write(`do --exec: no sandbox profile for harness "${harness}" — floor + procedure grants only\n`);
    await SandboxManager.initialize(cfg);
    return {
      sandboxed: true,
      wrap: async (cmd) => SandboxManager.wrapWithSandbox(cmd),
      reset: async () => { try { await SandboxManager.reset(); } catch { /* teardown is best-effort */ } },
    };
  } catch (e) {
    stderr.write(UNSANDBOXED(`sandbox init failed: ${e.message}`));
    try { await SandboxManager.reset(); } catch { /* nothing stood up */ }
    return none;
  }
}
