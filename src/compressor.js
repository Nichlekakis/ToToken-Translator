import { VERSION } from './config.js';
import { deterministicCompress } from './deterministic.js';
import { detectLanguage } from './detect.js';
import { freeTextLength, mask, unmask } from './protect.js';
import { llmRewrite } from './rewriter.js';
import { RewriteCache, recordStat } from './store.js';
import { estimateTokens } from './tokens.js';

const REPLY_HINT = {
  pt: 'Reply in Brazilian Portuguese.',
};

export const RAW_PREFIX = '!raw';

export function cacheSalt(config) {
  return `${VERSION}|${config.mode}|${config.translate}|${config.rewriterModel}`;
}

const inflight = new Map();

// Compresses one free-text prompt. Never throws: on any problem it returns the
// best safe version it has (deterministic result, or the original text).
export async function compressText(text, opts) {
  const { config, cache } = opts;
  if (config.mode === 'off' || !text || !text.trim()) return { text, method: 'off' };
  if (text.trimStart().startsWith(RAW_PREFIX)) {
    return { text: text.trimStart().slice(RAW_PREFIX.length).trimStart(), method: 'raw' };
  }
  const key = RewriteCache.key(text, cacheSalt(config));
  const hit = cache?.get(key);
  if (hit !== undefined) return { text: hit, method: 'cache' };
  // concurrent requests carrying the same new prompt share one rewrite
  if (inflight.has(key)) return { ...(await inflight.get(key)), method: 'cache' };
  const p = compressFresh(text, key, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function compressFresh(text, key, { config, cache, headers = null, fetchImpl, record = true }) {
  const started = Date.now();

  const { masked, pieces } = mask(text);
  const lang = detectLanguage(masked.replace(/⟦\d+⟧/g, ' '));
  let candidate = deterministicCompress(masked);
  let method = 'local';
  let failure = null;

  const canLLM = config.mode === 'auto' && headers && freeTextLength(candidate) >= config.minCharsForLLM;
  if (canLLM) {
    const translate = config.translate && (lang === 'pt' || lang === 'en');
    const r = await llmRewrite(candidate, pieces.length, { config, headers, translate, fetchImpl });
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
  if (after >= before) {
    out = text;
    after = before;
    method = 'none';
  }

  cache?.set(key, out);
  if (record) {
    recordStat({ method, lang, before, after, ms: Date.now() - started, ...(failure ? { failure } : {}) });
  }
  return { text: out, method, lang, before, after, failure };
}

// Looks up a previous rewrite without creating one (used for conversation history).
export function cachedText(text, { config, cache }) {
  if (config.mode === 'off' || !text) return text;
  if (text.trimStart().startsWith(RAW_PREFIX)) return text.trimStart().slice(RAW_PREFIX.length).trimStart();
  const hit = cache?.get(RewriteCache.key(text, cacheSalt(config)));
  return hit !== undefined ? hit : text;
}
