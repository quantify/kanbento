import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Resolve a submission/capture body from the CLI's input methods, explicit over
// ambient: a file (-F, with - for stdin), inline text, piped stdin, then — only on
// a terminal — an interactive editor; finally '' (the caller turns that into a
// helpful "body required" error). The two file/stdin paths are the automation-grade
// ones; the editor is the human ad-hoc fallback.
export function resolveBody(text, opts, { noEditor = false } = {}) {
  // -F always wins, INCLUDING the stdin form: `-F -` with inline text means
  // "the text is the title, stdin is the body" — falling through to the text
  // here silently dropped the heredoc (the stdin sibling of the 7b346f3 bug).
  if (opts.bodyFile === '-') {
    try { return readFileSync(0, 'utf8'); } catch { return ''; }
  }
  if (opts.bodyFile) return readFileSync(resolve(opts.bodyFile), 'utf8');
  if (text && text.length) return text.join(' ');
  if (!process.stdin.isTTY) {
    try { return readFileSync(0, 'utf8'); } catch { return ''; } // piped stdin / heredoc
  }
  if (!noEditor && process.stdin.isTTY) return editBody(); // no input arrived on a terminal → open $EDITOR
  return ''; // noEditor: the caller edits its doc in place instead (see editFile)
}

// Open $EDITOR on a file, in place — shell: true so an editor that carries args
// composes (e.g. EDITOR="code --wait"). Returns the spawn result (status).
export function editFile(path) {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  return spawnSync(`${editor} "${path}"`, { shell: true, stdio: 'inherit' });
}

// The interactive fallback for a FRESH body (git-style): edit an empty temp markdown
// file and take what is written. No template — the body IS markdown, so there is
// nothing to strip (a `#` is a heading, not a comment). TTY-only, so a
// non-interactive run never reaches it.
export function editBody() {
  const tmp = join(tmpdir(), `kanbento-${randomUUID()}.md`);
  writeFileSync(tmp, '', 'utf8');
  try {
    const r = editFile(tmp);
    return r.status === 0 ? readFileSync(tmp, 'utf8') : '';
  } finally {
    try { unlinkSync(tmp); } catch { /* temp cleanup is best-effort */ }
  }
}
