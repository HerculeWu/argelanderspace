/**
 * Whether a Markdown link destination may become a clickable anchor in agent-reachable content.
 * Allowed: http/https/mailto, and relative or //host destinations (they resolve to http(s));
 * everything else (javascript:, data:, vbscript:, credentials in the URL, control characters) is text.
 */
export function safeLink(href: string): boolean {
  if (Array.from(href).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(href, "http://workbench.invalid");
    return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
