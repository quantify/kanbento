// Minimal dot-path projection — resolve a field out of a plain object without
// a JSONPath/jq engine. Leading dot optional (`.title` == `title`). Segments
// split on `.` only, so keys may contain spaces (`checklists.Acceptance Criteria.0.text`).
// Bare integer segments index arrays via ordinary property access.

/**
 * Walk `path` against `obj`.
 * @returns {{ found: true, value: unknown } | { found: false }}
 */
export function resolveDotPath(obj, path) {
  if (path == null) return { found: false };
  let p = String(path);
  if (p.startsWith('.')) p = p.slice(1);
  if (p === '') return { found: false };

  const segs = p.split('.');
  let cur = obj;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return { found: false };
    if (!(seg in cur)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

/** Format a resolved value for stdout: scalars raw (pipe-friendly); object/array JSON. */
export function formatProjected(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return String(value);
}
