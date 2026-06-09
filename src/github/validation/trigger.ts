/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the trigger regex: the phrase must appear at a word/line boundary so
 * `@agentic` does not match `@agent`. Mirrors claude-code-action's pattern.
 */
function triggerRegex(phrase: string): RegExp {
  return new RegExp(`(^|\\s)${escapeRegExp(phrase)}([\\s.,!?;:]|$)`, "i");
}

/** True when `text` contains the trigger phrase at a boundary. */
export function checkContainsTrigger(text: string | undefined, phrase: string): boolean {
  if (!text || !phrase) return false;
  return triggerRegex(phrase).test(text);
}

/**
 * Extract the instruction that follows the trigger phrase. Returns the text
 * after the first phrase occurrence, trimmed. If the phrase is absent, returns
 * the whole text trimmed (caller decides whether that is valid).
 */
export function extractInstruction(text: string | undefined, phrase: string): string {
  if (!text) return "";
  const re = triggerRegex(phrase);
  const match = re.exec(text);
  if (!match) return text.trim();
  const start = (match.index ?? 0) + match[0].length;
  return text.slice(start).trim();
}
