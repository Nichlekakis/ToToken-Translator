import { cachedText, compressText } from './compressor.js';

function isHumanTurn(msg) {
  if (typeof msg.content === 'string') return true;
  if (!Array.isArray(msg.content)) return false;
  return !msg.content.some((b) => b && b.type === 'tool_result');
}

// Rewrites a /v1/messages (or count_tokens) body in place.
// - The newest human turn is compressed (and the result remembered).
// - Earlier user turns only get what was sent for them before, so history is
//   byte-stable between requests and prompt caching keeps hitting.
export async function transformBody(body, { config, cache, headers, fetchImpl, compressNew = true }) {
  if (!body || !Array.isArray(body.messages)) return { changed: false, results: [] };
  const msgs = body.messages;
  const lastIdx = msgs.findLastIndex((m) => m && m.role === 'user');
  let changed = false;
  const results = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg || msg.role !== 'user') continue;
    const fresh = compressNew && i === lastIdx && isHumanTurn(msg);
    const apply = async (text) => {
      if (!fresh) return cachedText(text, { cache });
      const r = await compressText(text, { config, cache, headers, fetchImpl, model: body.model });
      results.push(r);
      return r.text;
    };
    if (typeof msg.content === 'string') {
      const next = await apply(msg.content);
      if (next !== msg.content) {
        msg.content = next;
        changed = true;
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          const next = await apply(block.text);
          if (next !== block.text) {
            block.text = next;
            changed = true;
          }
        }
      }
    }
  }
  return { changed, results };
}
