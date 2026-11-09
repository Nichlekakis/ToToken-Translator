// Remembers the prompts the user actually typed, as reported by the plugin's
// UserPromptSubmit hook. With it the proxy can tell a typed prompt from the text
// Claude Code writes itself (subagent tasks, summaries, titles, command bodies)
// and compress only the former.
const TTL_MS = 30 * 60 * 1000;
const MAX = 50;
const MIN_PARTIAL = 12;

export class TypedPrompts {
  constructor() {
    this.items = new Map(); // prompt -> time
    this.hooked = false; // true once the hook has reported at least one prompt
  }

  add(prompt, now = Date.now()) {
    const text = String(prompt || '').trim();
    this.hooked = true;
    if (!text) return;
    this.items.delete(text);
    this.items.set(text, now);
    while (this.items.size > MAX) this.items.delete(this.items.keys().next().value);
  }

  // True when the block is a typed prompt, alone or wrapped in extra context.
  matches(block, now = Date.now()) {
    const text = String(block || '').trim();
    for (const [prompt, at] of this.items) {
      if (now - at > TTL_MS) {
        this.items.delete(prompt);
        continue;
      }
      if (text === prompt || (prompt.length >= MIN_PARTIAL && text.includes(prompt))) return true;
    }
    return false;
  }
}
