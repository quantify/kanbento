// A stage agreement — the Ready(DoR) · Body · Done(DoD) contract a stage binds via
// `stage.agreement`. The {DoR} body {DoD} Hoare triple: the body is the agent's
// sovereign zone (do anything, as long as DoR ⇒ DoD), the boundaries are RFC 2119
// constraints. This module is PURE — it parses the markdown into the structured
// contract; surfacing, gating, and independent DoD evaluation are the caller's concern.
//
// A bare procedure is just the body; an agreement with no Ready/Done sections degrades
// gracefully to body-only (so an agreement subsumes a procedure).

const SECTION = /^#{2,}\s+(ready|body|done)\b/i; // ## Ready (DoR) / ## Body / ## Done (DoD)

// RFC 2119 keyword -> severity, strongest first. REQUIRED/RECOMMENDED/OPTIONAL alias the
// three levels; the NOT forms keep their level (a prohibition is still a MUST-strength rule).
const LEVELS = [
  { sev: 'must', re: /\b(?:MUST(?:\s+NOT)?|SHALL(?:\s+NOT)?|REQUIRED)\b/ },
  { sev: 'should', re: /\b(?:SHOULD(?:\s+NOT)?|RECOMMENDED)\b/ },
  { sev: 'may', re: /\b(?:MAY|OPTIONAL)\b/ },
];

// RFC 2119 as the per-criterion enforcement dial: how hard a boundary bites.
export const SEVERITY = { must: 'block', should: 'warn', may: 'inform' };

function severityOf(text) {
  for (const { sev, re } of LEVELS) if (re.test(text)) return sev;
  return null;
}

// A constraint is a list item that carries an RFC 2119 keyword. A bullet without one is
// prose, not a criterion — ignored. Returns { severity, text } or null.
function parseConstraint(line) {
  const item = line.match(/^\s*[-*+]\s+(.*\S)\s*$/);
  if (!item) return null;
  const text = item[1].trim();
  const severity = severityOf(text);
  return severity ? { severity, text } : null;
}

// parseAgreement(md) -> { ready: [{severity,text}], body: string, done: [{severity,text}] }
export function parseAgreement(md) {
  const text = String(md ?? '');
  const ready = [];
  const done = [];
  const bodyLines = [];
  let cur = null;
  let sawSection = false;
  for (const line of text.split('\n')) {
    const m = line.match(SECTION);
    if (m) {
      cur = m[1].toLowerCase();
      sawSection = true;
      continue;
    }
    if (cur === 'body') {
      bodyLines.push(line);
    } else if (cur === 'ready' || cur === 'done') {
      const c = parseConstraint(line);
      if (c) (cur === 'ready' ? ready : done).push(c);
    }
  }
  // No Ready/Body/Done structure -> the whole doc is the body (a bare procedure).
  const body = sawSection ? bodyLines.join('\n').trim() : text.trim();
  return { ready, body, done };
}
