// Offline token estimate. Claude's tokenizer splits English words into ~1 token
// and accented or non-English words into several, so the estimate weights them
// differently. Use `totoken bench --api` for exact counts via count_tokens.
export function estimateTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)) {
    const w = m[0];
    if (!/[\p{L}\p{N}_]/u.test(w[0])) {
      n += 1;
    } else if (/^[\x00-\x7f]+$/.test(w)) {
      n += Math.max(1, Math.ceil(w.length / 5));
    } else {
      n += Math.max(1, Math.ceil(w.length / 2.5));
    }
  }
  return n;
}
