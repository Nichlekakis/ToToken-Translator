import { deterministicCompress } from './deterministic.js';
import { detectLanguage } from './detect.js';
import { canMask, freeTextLength, mask, placeholdersIntact, stripPlaceholders, unmask } from './protect.js';
import { hasCredentials, llmRewrite } from './rewriter.js';
import { RewriteCache, recordStat } from './store.js';
import { estimateTokens } from './tokens.js';

const REPLY_HINT = {
  pt: 'Reply in Brazilian Portuguese.',
};

export const RAW_PREFIX = '!raw';

function stripRaw(text) {
  const t = text.trimStart();
  return t.startsWith(RAW_PREFIX) ? t.slice(RAW_PREFIX.length).trimStart() : null;
}

// Cache marker for "sent unchanged": avoids storing the text twice.
const SAME = 0;

const inflight = new Map();

// Looks up what was sent for this text before, without creating anything. Used
// for conversation history and whenever the mode is "off". It ignores the current
// settings on purpose: a past message must be sent exactly as it was the first
// time, or the whole conversation loses its prompt cache.
export function cachedText(text, { cache }) {
  if (!text) return text;
  const raw = stripRaw(text);
  if (raw !== null) return raw;
  const hit = cache?.get(RewriteCache.key(text));
  return hit === undefined || hit === SAME ? text : hit;
}

// Compresses one free-text prompt. Never throws: on any problem it returns the
// best safe version it has (local result, or the original text).
export async function compressText(text, opts) {
  const { config, cache } = opts;
  if (!text || !text.trim()) return { text, method: 'skip' };
  const raw = stripRaw(text);
  if (raw !== null) return { text: raw, method: 'raw' };
  const key = RewriteCache.key(text);
  const hit = cache?.get(key);
  if (hit !== undefined) return { text: hit === SAME ? text : hit, method: 'cache' };
  if (config.mode === 'off') return { text, method: 'off' };
  // concurrent requests carrying the same new prompt share one rewrite
  if (inflight.has(key)) return { ...(await inflight.get(key)), method: 'cache' };
  const p = compressFresh(text, opts)
    .catch(() => ({ text, method: 'none', failure: 'internal' }))
    .then((r) => {
      // Remember the decision even when nothing changed, so a retry of the same
      // request cannot produce a different text.
      cache?.set(key, r.text === text ? SAME : r.text);
      return r;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Whether the paid rewrite is worth it for this prompt.
function llmGate(candidate, lang, { config, headers, model }) {
  if (config.mode !== 'auto') return false;
  if (!hasCredentials(headers, config.rewriterApiKey)) return false;
  // Rewriting a prompt for a Haiku-class request costs as much as it could save.
  if (model && /haiku/i.test(model)) return false;
  if (lang === 'en' && !config.rewriteEnglish) return false;
  const free = freeTextLength(candidate);
  return free >= config.minCharsForLLM && free <= config.maxCharsForLLM;
}

async function compressFresh(text, opts) {
  const { config, headers = null, fetchImpl, record = true } = opts;
  const started = Date.now();
  if (text.length > config.maxChars || !canMask(text)) return { text, method: 'none' };

  const { masked, pieces } = mask(text);
  if (freeTextLength(masked) < 12) return { text, method: 'none' };
  const lang = detectLanguage(stripPlaceholders(masked));
  let candidate = deterministicCompress(masked);
  if (!placeholdersIntact(candidate, pieces.length)) candidate = masked;
  let method = 'local';
  let failure = null;
  let usage = null;

  if (llmGate(candidate, lang, opts)) {
    const translate = config.translate && lang === 'pt';
    const r = await llmRewrite(candidate, pieces.length, { config, headers, translate, fetchImpl });
    usage = r.usage || null;
    if (r.ok) {
      candidate = r.text;
      method = 'llm';
      if (translate && REPLY_HINT[lang]) candidate += `\n${REPLY_HINT[lang]}`;
    } else {
      failure = r.reason;
    }
  }

  let out = unmask(candidate, pieces);
  const before = estimateTokens(text);
  let after = estimateTokens(out);
  if (after >= before || !out.trim()) {
    out = text;
    after = before;
    method = 'none';
  }

  if (record && (method !== 'none' || failure)) {
    recordStat({
      method,
      lang,
      before,
      after,
      ms: Date.now() - started,
      ...(usage ? { rwIn: usage.input_tokens || 0, rwOut: usage.output_tokens || 0 } : {}),
      ...(config.logSamples ? { sample: out.slice(0, 400), orig: text.slice(0, 80) } : {}),
      ...(failure ? { failure } : {}),
    });
  }
  return { text: out, method, lang, before, after, failure };
}
