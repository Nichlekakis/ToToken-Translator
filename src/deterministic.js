// Zero-cost compression: removes politeness, filler and repetition from prose.
// It runs on masked text and works line by line. Contract: a line that no rule
// matches comes out byte-for-byte identical, and lines that look like code, logs
// or data are never touched at all.

const S = String.raw`(^\s*|[.!?]\s+)`; // sentence start
const Q = String.raw`(?=[^.!?]*\?)`; // the sentence is a question
const PF = String.raw`(?:,?\s*por\s+favor\s*,?\s+)`;
const r = (source, rep = '') => [new RegExp(source, 'giu'), rep];

const RULES = [
  // --- Portuguese: greetings and sign-offs
  r(S + String.raw`(?:ol[áa]|oi+|opa|e a[íi]|bom dia|boa tarde|boa noite)(?:\s+(?:claude|pessoal|amigo|galera|time))?\s*(?:[,!.]+\s*|(?=tudo\s)|$)`, '$1'),
  r(S + String.raw`(?:tudo\s+(?:bem|certo|bom|joia)|como\s+vai|como\s+voc[êe]\s+est[áa])\s*\?+\s*`, '$1'),
  r(String.raw`[,;]?\s*desde\s+j[áa]\s*,?\s*(?:agrade[çc]o|(?:muito\s+)?obrigad[oa])\s*[!.]*`, ' '),
  // "obrigado a fazer X" means "required to": only drop it as a closing thanks
  r(String.raw`(^\s*|[.!?,;]\s*)(?:muito\s+)?obrigad[oa](?:\s+desde\s+j[áa]|\s+pela\s+ajuda)?\s*(?:[!.,]+|$)`, '$1'),
  r(String.raw`(^|[.!?,]\s*)valeu\s*(?:[!.,]+\s*|$)`, '$1'),
  // --- Portuguese: request framing, only where it opens a sentence and is
  // clearly a request: it says "me" or "por favor", or it is a conditional
  // question. "você poderia me ajudar a criar X" -> "criar X", while "Você pode
  // usar qualquer lib." (a permission) and "Pode ser que..." are left alone.
  r(S + String.raw`(?:ser[áa]\s+que\s+)?(?:voc[êe]\s+)?(?:poderia|pode|consegue|conseguiria|podia)\s+(?:${PF}(?:me\s+)?|me\s+${PF}?)(?:ajudar\s+a\s+)?(?=\p{L})`, '$1'),
  r(S + String.raw`voc[êe]\s+(?:poderia|conseguiria|podia)\s+(?:ajudar\s+a\s+)?(?=\p{L})` + Q, '$1'),
  r(String.raw`\b(?:eu\s+)?(?:quero|preciso)\s+(?:muito\s+)?que\s+voc[êe]\s+(?=\p{L})`),
  r(S + String.raw`(?:eu\s+)?(?:quero|preciso)\s+de\s+(?:uma\s+)?ajuda\s+para\s+`, '$1'),
  r(S + String.raw`(?:${PF})?me\s+ajud[ea]\s+a\s+`, '$1'),
  // --- Portuguese: politeness
  // only as a clause of its own: "o que significa por favor em inglês" keeps it
  r(String.raw`(^\s*|[.!?,;]\s*)por\s+(?:favor|gentileza)\b\s*,?\s*`, '$1'),
  r(String.raw`\s*,?\s*\bpor\s+(?:favor|gentileza)\s*(?=[,.;!?]|$)`),
  r(String.raw`\s*,?\s*\bse\s+n[ãa]o\s+for\s+inc[ôo]modo\b\s*,?`, ' '),
  // --- Portuguese: fillers
  r(String.raw`\b(?:basicamente|na\s+verdade|meio\s+que|tipo\s+assim)\b\s*,?\s*`),
  r(S + String.raw`(?:ent[ãa]o|bem|bom|assim|enfim|olha)\s*,\s*`, '$1'),
  r(String.raw`\s*,\s*(?:n[ée]|sabe|entende)\s*\?`, '.'),
  // --- English: greetings and sign-offs
  r(S + String.raw`(?:hi|hello|hey)(?:\s+(?:there|claude|team|all))?\s*[,!.]+\s*`, '$1'),
  r(S + String.raw`how\s+are\s+you(?:\s+doing)?\s*\?+\s*`, '$1'),
  r(S + String.raw`(?:i\s+)?hope\s+you(?:'re|\s+are)\s+(?:doing\s+)?well\s*[.!]+\s*`, '$1'),
  r(String.raw`(^\s*|[.!?,;]\s*)(?:thanks|thank\s+you)(?:\s+(?:so\s+much|a\s+lot|in\s+advance))?\s*(?:[!.,]+|$)`, '$1'),
  // --- English: request framing (sentence start only, so "what would you
  // recommend" and "how can you tell" keep their meaning), then politeness
  r(S + String.raw`(?:please\s*,?\s+)?(?:could|can|would|will)\s+you\s+(?:please\s+)?help\s+me\s+(?:to\s+)?(?=\p{L})`, '$1'),
  r(S + String.raw`(?:could|can|would|will)\s+you\s+please\s+(?=\p{L})`, '$1'),
  r(S + String.raw`please\s*,?\s+(?:could|can|would|will)\s+you\s+(?=\p{L})`, '$1'),
  r(S + String.raw`(?:could|would)\s+you\s+(?!(?:be|have|recommend|prefer|say|suggest|like)\b)(?=\p{L})` + Q, '$1'),
  r(S + String.raw`(?:i\s+would\s+like|i'd\s+like|i\s+want|i\s+need)\s+you\s+to\s+`, '$1'),
  r(String.raw`(^\s*|[.!?,;]\s*)please\b\s*,?\s*`, '$1'),
  r(String.raw`\s*,?\s*\bplease\s*(?=[,.;!?]|$)`),
  r(String.raw`\b(?:basically|essentially)\b\s*,?\s*`),
  // --- repetition and punctuation noise
  r(String.raw`(\b[^,.;:!?⟦⟧]{8,80}?)(?:,\s*\1)+(?=\s*(?:[,.;!?]|$))`, '$1'),
  // "!!!" after a word, never operators such as ?? or !!flag
  r(String.raw`(?<=\p{L})([!?])\1+(?=\s|$)`, '$1'),
  r(String.raw`\.{4,}`, '...'),
];

const MAX_LINE = 2000;
// Indented lines and lines with code-like symbols are copied verbatim.
// So are lines with runs of spaces (aligned columns, padded terminal output).
const VERBATIM = /^(?: {2,}|\t)|[ \t]{3,}|[{}[\]<>=;|\\$^~]|::|->|^\s*(?:[#>@]|\/\/|--\s)/;
const LIST_MARKER = /^\s?(?:[-*+•]|\d+[.)])\s+/;

function tidy(s) {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;])(?=\s|$)/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/([.!?])\s*[,;]/g, '$1')
    .replace(/,\s*([.!?])(?=\s|$)/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .replace(/^[.!?]+(?=\s|$)\s*/, '')
    .replace(/[\s,;]+$/, '')
    .trim();
}

function capitalize(s, lineStart) {
  let out = s.replace(/([.!?]\s+)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
  if (lineStart) out = out.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  return out;
}

function dedupeSentences(s) {
  const seen = new Set();
  return s
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      // a question and a statement with the same words are different sentences
      const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}⟦⟧?]+/gu, ' ').trim();
      if (key.length < 12) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

// Returns the compressed line, or null when the whole line was filler.
function compressLine(line) {
  if (!line.trim() || line.length > MAX_LINE || VERBATIM.test(line)) return line;
  const marker = line.match(LIST_MARKER)?.[0] ?? '';
  const body = line.slice(marker.length);
  let out = body;
  // removing one filler can expose the next ("Bom, então, ..."): two passes settle it
  for (let pass = 0; pass < 2; pass++) for (const [re, rep] of RULES) out = out.replace(re, rep);
  out = dedupeSentences(out);
  if (out === body) return line;
  out = capitalize(tidy(out), /^\p{Lu}/u.test(body));
  if (!out) return null;
  return marker + out;
}

export function deterministicCompress(masked) {
  const lines = masked.split('\n');
  const out = [];
  let changed = false;
  for (const line of lines) {
    const next = compressLine(line);
    if (next !== line) changed = true;
    if (next !== null) out.push(next);
  }
  return changed ? out.join('\n').trim() : masked;
}
