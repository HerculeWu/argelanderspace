# M3b 完成：PDF 管线移植进 packages/core（2026-08-26）

Milestone M3b（`bibgraph/pipeline.py` 的 bug-for-bug TS 移植）完成。**两篇 golden（2603.03522 原生数字 PDF、ads-1983ApJ...270..365M ADS 扫描件）逐字段 0 diff**，豁免清单 2 条（均有逐条 justification，见下）。

## 模块映射

- `pipeline.py::ingest_pdf` → `packages/core/src/pipelines/pdf/pipeline.ts`（`ingestPdf(pdfPath, ports, opts)`，async 因 MinerU port 可能走网络）+ `ports.ts`：
  - `PdfMineruExtract` — MinerU 抽取（infra `MineruClient.extract` 的结构孪生；opts 带 auto-detect 后的完整 mineru config + poll/useCache）。
  - `PdfLinksPort` — `{ hasTextLayer, extract }`（`pdf_links.py` 两次独立打开；infra `pdf/links.ts`）。
  - `PdfTextProviderFactory` — `openText(pdfPath) => PdfTextProvider`（textfix 的 `fitz.open`；infra `openPdfTextProvider`）。
  - `PdfPipelineConfig` + `DEFAULT_PDF_CONFIG`（config.py 默认值）。
- 纯组合复用 M1a 的 `documents/document.ts::buildDocument`（structure → references → textfix → annotate 全在里面），管线只加编排：OCR auto-detect、MinerU 调用、链接抽取的 never-fail 守卫、JSON 落盘 + `meta.output_path` 后置写入。
- 接线：`packages/infra/src/pdf/pipeline.ts`（core 组合 + MineruClient/extractPdfLinks/hasPdfTextLayer/openPdfTextProvider）。
- `diffJson` 报告器从 golden-latex.test.ts 移到 `packages/core/tests/helpers/diff-json.ts`，两个 golden gate 共用（golden-latex 保留 re-export）。

## Golden 生成路径（基线预验：astro env Python 离线复现两篇均 0 diff，脚本 /tmp/m3b-baseline/verify.py）

- **2603.03522** 是 `scripts/reprocess.py` 冻的：`load_cached` + 默认 config 的 `build_document` ⇒ `meta.mineru` **无 is_ocr、无 batch_id**。
- **ads 扫描件**是 `acquire.fetch_pdf.ads_scan_doc` 冻的：`is_ocr=True` 强制（auto-detect 跳过）+ 真实 API 跑的 `batch_id=14ec3277-…` + `_stamp_source` 往写出的 JSON 打 `source.doi`/`acquired_via`（**acquire 的后置文件改写，不在 ingest_pdf 里**）。
- 对照：`data/output/arxivpdf-*`（ingest_pdf auto-detect 路径）带 `is_ocr: false` + batch_id —— 证明 compact 保留 false。

## Golden gate 设计（`packages/core/tests/golden-pdf.test.ts`）

两篇都走真 `ingestPdf` 端到端（test-local ports：真 mupdf 做链接/文本层/textfix 裁剪 + 夹具回放 MinerU 缓存与 batch_id）。ads 的 stamp 用 manifest 里的值在写出的 JSON 上重放 `_stamp_source`。

豁免清单 2 条：
1. `$.source.path` — 冻结时输入 PDF 的绝对路径（机器相关）；filename/n_pages 严格比对。
2. `$.meta.mineru.is_ocr` — 只对 2603.03522 触发：golden 由 reprocess 冻结（is_ocr 从未设置），端到端 auto-detect 得 false（与 arxivpdf-* 一致）；测试体内**断言了该值恰为 false**，豁免不会掩盖行为漂移。

## 夹具（`packages/core/tests/fixtures/pdfminer/<doc_id>/`，1.7MB）

每篇：原 PDF + `mineru/<uuid>_content_list.json` + `source.json` manifest（doc_id/pdf/golden/is_ocr/batch_id/stamp/provenance）。**只归档 content_list**：管线只消费它 + batch_id（middle.json/full.md/images 无人读；`img_path` 是纯字符串透传，不需要图像文件）。infra 另拷了 2603.03522.pdf 到自身 fixtures 钉非 BMP 修复。

## ⚠️ 新发现的 mupdf-js 缺陷（M2 spike 漏网）+ 修复

`StructuredText.walk` 的 `onChar` 用 `String.fromCharCode` 编组 rune（mupdf.js:1141），**>U+FFFF 的码点被截断成低 16 位**（U+1D441 数学斜体 N → U+D441 谚文）。spike 的 clip 样本全是 BMP 字符所以没抓到；2603.03522 的 textfix 裁剪被 golden diff 抓出 23 处。修复（infra `pdf/text-provider.ts::clippedTextOf` + core 测试助手同步）：`asJSON(1)` 的行文本是全保真的，按位置 zip 回 walk 的 quad 流——两者枚举同一 stext 结构，实测两篇 PDF 行数/逐行字符数全等、低 16 位恒匹配；失配时保留 walk 原字符（修复前行为）。infra mupdf-text 套件新增非 BMP 钉测（U+1D454 span clip → "𝑔\n"，PyMuPDF 地面真值）。**pageText/asText 不受影响**（全保真）。

## 测试与验收（2026-08-26 本机）

- `corepack pnpm -r build` ✓ / `-r typecheck` ✓ / `lint` ✓（111 文件 0 error 0 warning）。
- 测试：contracts 17/17、**core 64/64**（48 基线 + golden-pdf 2 + 管线单测 14）、**infra 77/77**（75 基线 + 接线 smoke 1 + 非 BMP 钉测 1）。
- 单测钉的编排语义：auto-detect 仅在 is_ocr 为 null/undefined 时跑（强制 true/false 不探测）；链接抽取失败 → regex-only 不炸；textfix provider 打开失败 → 零值 stats（对应 Python apply_textfix 的 fitz.open catch）；usePdfLinks/useTextfix 开关、poll/cache 透传、writeJson 行为、缺 PDF 抛错。
- `tests/run_tests.py` 无 ingest_pdf 级用例（PDF 侧单测全是 build_document 级，M1a 已移植）——M3b 无新增移植单测组。
- 无 pandoc 依赖（PDF 管线不需要）；测试全离线。

## 上游观察（未修，bug-for-bug 保留）

- **Python**：`ingest_pdf` auto-detect 会**改写调用方的** `config.mineru.is_ocr`；TS 改为解析进局部拷贝（输出等价，调用方无副作用——良性分歧）。
- **Python 工具链不对称**：reprocess.py 冻的 JSON 永远没有 `meta.mineru.is_ocr`，ingest_pdf 冻的永远有——同一篇纸两条路径产出不同（纯 provenance，非行为 bug）。
- **infra MineruClient**（M2 冻结）：构造时即解析 `MINERU_API_KEY`（Python 是首次 API 调用才取）——暖缓存 + 无 env 时 TS 会抛而 Python 能跑。验收后可立项。
- **mupdf npm 包** onChar 16 位截断（上游 bug，本地已绕；可报上游）。

## 留给 M3c（HTML 管线）

- golden gate 模板同 M3a/M3b：`tests/helpers/diff-json.ts` + test-local ports + manifest 夹具。
- `annotation_latex`（cheerio DOM 读取）仍欠，随 M3c。
