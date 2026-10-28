/**
 * The file name a PDF Doc records, from what the caller was given (the upload's `x-filename`, the local path of
 * `attach_local_pdf`): its last path segment with control characters replaced. Null when nothing usable is left
 * (empty, or over 255 characters). The upload route and the Copilot tool both come through here.
 */
export function normalizePdfFilename(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? "document.pdf";
  const cleaned = [...last]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? "_" : character;
    })
    .join("");
  return !cleaned || cleaned.length > 255 ? null : cleaned;
}
