import { cachedText, compressText } from './compressor.js';

function isHumanTurn(msg) {
  if (msg.role !== 'user') return false;
  if (typeof msg.content === 'string') return true;
  if (!Array.isArray(msg.content)) return false;
  return !msg.content.some((b) => b && b.type === 'tool_result');
}

// Rewrites a /v1/messages (or count_tokens) body in place.
// - The newest human turn is compressed (and cached).
// - Earlier user turns only get their cached rewrite, so history is byte-stable
//   between requests and prompt caching keeps hitting.
export async function transformBody(body, { config, cache, headers, fetchImpl, compressNew = true }) {
  if (!body || !Array.isArray(body.messages) || config.mode === 'off') return { changed: false, results: [] };
  const msgs = body.messages;
  let lastIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastIdx = i;
      break;
    }
  }
  let changed = false;
  const results = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== 'user') continue;
    const fresh = compressNew && i === lastIdx && isHumanTurn(msg);
    const apply = async (text) => {
      if (fresh) {
        const r = await compressText(text, { config, cache, headers, fetchImpl });
        results.push(r);
        return r.text;
      }
      return cachedText(text, { config, cache });
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
