import markedCjkFriendly from "marked-cjk-friendly";

/**
 * Display-layer fix for CommonMark's `*`/`**` delimiter rule next to CJK punctuation
 * (bold wrapped in CJK corner brackets and followed by a CJK letter otherwise shows literal
 * asterisks). Shared by every web Markdown
 * renderer. Deliberately NOT applied in core's text-codec, which defines the text Doc IR
 * and frozen agent output.
 *
 * Actual coverage (marked-cjk-friendly, marked 18): `*`/`**`, `_`/`__` and GFM strikethrough
 * `~`/`~~` all become valid delimiters when a CJK character or CJK punctuation is on either side
 * of the run, so it is slightly looser than "CJK letter on one side, CJK punctuation on the other"
 * (e.g. a bold run in corner brackets between Latin letters is bold, and `__` / `~~` runs
 * next to CJK render too; the cases are spelled out in the test). Text with no
 * CJK next to the delimiters is unchanged CommonMark/GFM (`snake_case_name`, `foo**bar**baz`,
 * `a **(x)**b`). Pinned by tests/cjk-emphasis.test.ts.
 */
export const cjkEmphasis = () => markedCjkFriendly();
