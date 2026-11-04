// Zero-cost compression: removes politeness, filler and repetition from free text.
// Runs on masked text, so protected spans (placeholders) are never touched.

const RULES = [
  // greetings / sign-offs (PT)
  [/(^|[\n.!?]\s*)(ol[áa]|oi|e a[íi]|bom dia|boa tarde|boa noite)(?!\p{L})(\s+(claude|pessoal|amigo))?\s*[,!.]*\s*/giu, '$1'],
  [/(^|[\n.!?]\s*)(tudo\s+(bem|certo|bom)|como\s+vai|como\s+voc[êe]\s+est[áa])\s*\?\s*/gi, '$1'],
  [/\s*(muito\s+)?\bobrigad[oa]\b(\s+desde\s+j[áa])?\s*[!.]*/gi, ' '],
  [/\s*desde\s+j[áa]\s*(agrade[çc]o)?\s*[!.,]*/gi, ' '],
  [/\s*\bvaleu\b\s*[!.]*/gi, ' '],
  // politeness (PT)
  [/\s*,?\s*\bpor\s+(favor|gentileza)\b\s*,?/gi, ' '],
  [/\s*,?\s*\bse\s+(poss[íi]vel|puder|n[ãa]o\s+for\s+incômodo)\b\s*,?/gi, ' '],
  // request framing (PT): "você poderia me ajudar a criar X" -> "criar X"
  [/\bvoc[êe]\s+(poderia|pode|consegue|conseguiria|podia)\s+(me\s+)?(ajudar\s+a\s+)?(?=\p{L})/giu, ''],
  [/(^|[\n.!?]\s*)(poderia|pode|consegue|conseguiria|podia)\s+(me\s+)?(ajudar\s+a\s+)?(?=\p{L})/giu, '$1'],
  [/\b(eu\s+)?(quero|preciso)\s+(muito\s+)?(que\s+voc[êe]\s+|de\s+uma\s+ajuda\s+para\s+|de\s+ajuda\s+para\s+)/gi, ''],
  [/\b(me\s+)?ajude\s+a\s+/gi, ''],
  // fillers (PT)
  [/\b(basicamente|na\s+verdade|meio\s+que|tipo\s+assim)\b\s*,?\s*/gi, ''],
  [/(^|[\n.!?]\s*)(ent[ãa]o|bem|bom|assim|enfim)\s*,\s*/gi, '$1'],
  [/\s*,?\s*\b(n[ée]|sabe|entende)\s*\?/gi, '.'],
  // greetings / sign-offs (EN)
  [/(^|[\n.!?]\s*)(hi|hello|hey)(\s+(there|claude))?\s*[,!.]+\s*/gi, '$1'],
  [/(^|[\n.!?]\s*)(how\s+are\s+you(\s+doing)?)\s*\?\s*/gi, '$1'],
  [/\s*\b(thanks|thank\s+you)\b(\s+(so\s+much|in\s+advance))?\s*[!.]*/gi, ' '],
  // politeness / framing (EN)
  [/\s*,?\s*\b(please|kindly)\b\s*,?/gi, ' '],
  [/\b(could|can|would)\s+you\s+(please\s+)?(help\s+me\s+)?(?=\p{L})/giu, ''],
  [/\b(i\s+would\s+like|i'd\s+like|i\s+want|i\s+need)\s+(you\s+)?to\s+/gi, ''],
  [/\b(basically|actually|essentially)\b\s*,?\s*/gi, ''],
  // repeated clause: "faça X, faça X," -> "faça X,"
  [/(\b[^,.;:!?\n]{8,}?)(,\s*\1\b)+/giu, '$1'],
  // punctuation noise
  [/([!?])\1+/g, '$1'],
  [/\.{4,}/g, '...'],
];

function normalizeSpaces(s) {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[^\s\d⟦])/g, '$1 ')
    .replace(/^[ ,.;:]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim();
}

function dedupeSentences(s) {
  const seen = new Set();
  return s
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) => {
      const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}⟦⟧]+/gu, ' ').trim();
      if (key.length < 12) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function capitalizeStarts(s) {
  return s.replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
}

export function deterministicCompress(masked) {
  let out = masked;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  out = normalizeSpaces(out);
  // only dedupe single-paragraph text; keep layout of structured prompts
  if (!out.includes('\n')) out = dedupeSentences(out);
  out = capitalizeStarts(normalizeSpaces(out));
  return out;
}
