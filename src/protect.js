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
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // e-mails
  /(?:^|(?<=[\s(]))(?:~|\.{1,2})?\/[\w.\-@/]*[\w\-@/]/g, // unix paths (no trailing dot)
  /\b[\w.-]+(?:\/[\w.-]+)*\/[\w.-]*[\w-]/g, // relative paths (src/app.js)
  /\b[A-Za-z]:\\[\w.\-\\ ]+/g, // windows paths
  /(?<![\w/])\.[A-Za-z][\w-]*(?:\.[\w-]+)*/g, // dotfiles (.env, .gitignore)
  /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b(?!\()/g, // file names (report-2.pdf)
  /"[^"\n]{1,200}"/g, // double-quoted literals
  /“[^”\n]{1,200}”/g,
  /(?<![\p{L}\p{N}])'[^'\n]{1,200}'(?![\p{L}\p{N}])/gu, // single-quoted literals
  /(?:^|(?<=\s))--?[A-Za-z][\w-]*(?:=\S+)?/g, // CLI flags
  /\$\{?[A-Za-z_]\w*\}?/g, // $VAR, ${VAR}
  /\b\w+(?:::\w+)+/g, // Rust / C++ paths (std::vector)
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/g, // dotted.names / calls
  /\b[A-Za-z]*_[A-Za-z0-9_]+\b/g, // snake_case
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, // camelCase
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g, // PascalCase with inner capital
  /\b\w+\(\)/g, // calls()
  /\bv?\d+(?:\.\d+){2,}(?:-[\w.]+)?/g, // versions (1.2.3, v22.4.0-rc.1)
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, // commit hashes
  /#\d+\b/g, // issue / PR refs
];

export const PLACEHOLDER_RE = /⟦(\d+)⟧/g;

// Text that already contains our placeholder brackets cannot be masked safely.
export function canMask(text) {
  return !/[⟦⟧]/.test(text);
}

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
  const pieces = [];
  let out = '';
  let pos = 0;
  for (const [a, b] of spans) {
    if (a < pos) continue;
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
  const seen = new Set();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const i = Number(m[1]);
    if (i >= count || seen.has(i)) return false;
    seen.add(i);
  }
  return seen.size === count;
}

export function stripPlaceholders(masked) {
  return masked.replace(PLACEHOLDER_RE, ' ');
}

// Characters of free text left once protected spans are removed.
export function freeTextLength(masked) {
  return stripPlaceholders(masked).replace(/\s+/g, ' ').trim().length;
}
