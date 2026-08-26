# M1a 完成：documents 纯逻辑移植进 packages/core（2026-08-26）

Milestone M1a（documents-domain 纯逻辑 Python→TS，bug-for-bug）已完成并通过验收门。

## 模块映射（bibgraph/ingest/*.py → packages/core/src/documents/*.ts）

- `citations.py` → `citations.ts`（ReferenceResolver、detectCitations、linkTargets、enrichCitationsWithLinks）
- `crossrefs.py` → `crossrefs.ts`（XrefIndex、detectCrossrefs、enrichCrossrefsWithLinks）
- `annotate.py` → `annotate.ts`（Match、applyMatches、matchToken）
- `references.py` → `references.ts`（parseReferences → ParsedReference = contracts Reference + src_page/src_bbox）
- `structure.py` → `structure.ts`（buildStructure、splitCaption）
- `textfix.py` → `textfix.ts`（repairText、applyTextfix、hasTextLayer）+ `sequence-matcher.ts`（CPython 3.14.2 difflib.SequenceMatcher 逐行移植，isjunk=None + get_opcodes 子集）
- 支撑：`pdf-links.ts`（pdf_links.py 纯部分：LinkAnnot/PdfLinks/几何/parseUri/classifyDest；extract_links 属 M2 infra）、`traverse.ts`、`document.ts`（buildDocument、documentToJson、compact）、`tokens.ts`、`mineru.ts`（MinerU content_list/middle 输入类型）、`pyregex.ts`（内部）

## textfix 的 PdfTextProvider 端口（M2 infra 照此实现）

```ts
interface PdfTextProvider {
  readonly pageCount: number;
  pageSize(pageIdx): { width: number; height: number };  // points；<=0 = 退化页
  pageText(pageIdx): string;            // = PyMuPDF page.get_text("text")，原文
  clippedText(pageIdx, rect: PageRect): string;  // = get_text("text", clip=rect)，原文
  close(): void;                        // applyTextfix 在 finally 调用
}
```

- PageRect 为页面坐标（points，左上原点）。pad/缩放/空白归一化（`[ \t]+`→" "、`\n`→" "、trim）在 core 的 clipLayer 里做，provider 只返回原始文本。
- mupdf 实现按 spike 适配点 3：`toStructuredText().walk({onChar})` + 字符 quad 中心在 rect 内过滤（已与 PyMuPDF 逐字节一致）。
- buildDocument 无 provider 时 textfix 记零 stats（对应 Python fitz 打不开 PDF 的降级路径）。

## 关键兼容事实（后续 milestone 不要"修"）

- Python `\b` 是 Unicode 感知、JS `\b` 仅 ASCII：core 用 `pyregex.ts` 的 `pyRe()` 把 `\b` 改写为 lookaround（否则 "Åström (2019)" 失配）。移植新正则时必须过 pyRe。
- Python `or` 链对 `[]`/`{}` 为假、JS 为真：用 `pyOr()`（MinerU 字段链如 img_caption or chart_caption 必须用它）。
- difflib 移植已差分验证：420 例（含 autojunk purge 路径）与 CPython 3.14.2 逐 opcode 一致；repairText 800 例与 Python repair_text 一致；citation/xref 检测各 10/7 例 tricky 文本一致；fixture 全管线 JSON 与 Python sample_output.json 字段级 0 diff。
- 已知微差异（不影响现实输入，验收后可立项）：Python `re.I` 的 [a-z] 额外匹配 İ/ı（JS /iu 只折 ſ/K）；Python `\d` 匹配 Unicode 数字（TS 仅 ASCII）；str.strip/isspace 与 JS trim/\s 的空白集差 \x1c-\x1f、\x85；JSON 1.0（float）的 text_level 在 Python 不算 int（TS Number.isInteger 算）；非 compact 序列化 TS 省略显式 null（compact 模式完全一致）。
- 潜在崩溃未修（bug-for-bug 保留的语义已防御化）：references 对非字符串 text 会 crash（TS 防御为 ""）；textfix 对短 bbox 会 IndexError（TS 类型层面不可表示）。

## 验收与基线

- Python 基线：`tests/run_tests.py` 210 checks / 0 fail（58 个 test 函数；documents 域 21 个全部移植，html 12/latex 13 → M3，acq 9/crossref 1/resolve 2 → M1b）。
- `corepack pnpm -r build` ✓ / `--filter @argelanderspace/core test` 21/21 ✓ / `-r typecheck` ✓ / `pnpm lint` ✓（biome.json 新增 `**/tests/fixtures/**` override，夹具保持与 Python 源逐字节一致）。
