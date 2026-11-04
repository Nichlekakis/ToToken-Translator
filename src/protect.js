// Masks spans that must reach the model byte-for-byte (code, tags, URLs, paths,
// identifiers, quoted literals) behind placeholders like ⟦0⟧, so no compression
// step can alter them. Precision depends on this.

const PATTERNS = [
  /```[\s\S]*?```/g, // fenced code
  /~~~[\s\S]*?~~~/g,
  /<([A-Za-z][\w:-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g, // paired tags (system-reminder, etc.)
  /<[A-Za-z][\w:-]*(?:\s[^<>]*)?\/>/g, // self-closing tags
  /`[^`\n]+`/g, // inline code
  /\bhttps?:\/\/[^\s<>"'`)]+/g, // URLs
  /(?:^|(?<=[\s(]))(?:~|\.{1,2})?\/[\w.\-@/]*[\w\-@/]/g, // unix paths (no trailing dot)
  /\b[\w.-]+(?:\/[\w.-]+)*\/[\w.-]*[\w-]/g, // relative paths (src/app.js)
  /\b[A-Za-z]:\\[\w.\-\\ ]+/g, // windows paths
  /"[^"\n]{1,200}"/g, // double-quoted literals
  /“[^”\n]{1,200}”/g,
  /(?:^|(?<=\s))--?[A-Za-z][\w-]*(?:=\S+)?/g, // CLI flags
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/g, // dotted.names / calls
  /\b[A-Za-z]*_[A-Za-z0-9_]+\b/g, // snake_case
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, // camelCase
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g, // PascalCase with inner capital
  /\b\w+\(\)/g, // calls()
  /#\d+\b/g, // issue / PR refs
];

export const PLACEHOLDER_RE = /⟦(\d+)⟧/g;

export function mask(text) {
  const spans = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  // keep outermost, non-overlapping spans
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const chosen = [];
  let end = -1;
  for (const s of spans) {
    if (s[0] >= end) {
      chosen.push(s);
      end = s[1];
    }
  }
  const pieces = [];
  let out = '';
  let pos = 0;
  for (const [a, b] of chosen) {
    out += text.slice(pos, a) + `⟦${pieces.length}⟧`;
    pieces.push(text.slice(a, b));
    pos = b;
  }
  out += text.slice(pos);
  return { masked: out, pieces };
}

export function unmask(masked, pieces) {
  return masked.replace(PLACEHOLDER_RE, (whole, i) => (pieces[Number(i)] ?? whole));
}

// True when every placeholder appears exactly once.
export function placeholdersIntact(text, count) {
  const seen = new Map();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const i = Number(m[1]);
    seen.set(i, (seen.get(i) || 0) + 1);
  }
  if (seen.size !== count) return false;
  for (let i = 0; i < count; i++) if (seen.get(i) !== 1) return false;
  return true;
}

// Characters of free text left once protected spans are removed.
export function freeTextLength(masked) {
  return masked.replace(PLACEHOLDER_RE, '').replace(/\s+/g, ' ').trim().length;
}
