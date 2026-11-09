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
// `typed` (optional) is the registry of prompts the user typed. With it, only a
// typed prompt is compressed; text written by Claude Code itself is left alone.
function isTyped(text, body, typed) {
  if (!typed) return true;
  if (typed.hooked) return typed.matches(text);
  // No hook has reported yet (plugin not installed): at least skip the tool-less
  // side requests Claude Code makes for titles and summaries.
  return Array.isArray(body.tools) && body.tools.length > 0;
}

export async function transformBody(body, { config, cache, headers, fetchImpl, typed, compressNew = true }) {
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
      if (!fresh || !isTyped(text, body, typed)) return cachedText(text, { cache });
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
