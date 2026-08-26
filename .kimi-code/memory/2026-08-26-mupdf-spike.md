# mupdf npm 可行性验证（TS 迁移 Phase 0 spike）

- **日期**：2026-08-26
- **目的**：验证 Artifex 官方 `mupdf` npm 包（WASM）能否在 Python→TS 迁移中替代 PyMuPDF (fitz)
- **方法**：subagent 对项目实际用到的三类 fitz 调用做双向对比实测（mupdf@1.28.0 vs PyMuPDF 1.27.2.3）
- **裁决：✅ 全部可用，TS 迁移不需要 Python sidecar。** 最大技术风险已排除。

## 项目里 PyMuPDF 的全部用途（仅三处）

1. `bibgraph/pdf_links.py` — 采集 PDF 超链接注释：`page.get_links()`、hyperref named destinations（`cite.<bibkey>` / `figure.3` / `section.7`）、`doc.resolve_names()`、`page.get_text("text")` 文本层探测
2. `bibgraph/ingest/textfix.py` — 文本层探测 + 按 bbox 裁剪取字 `page.get_text("text", clip=Rect)`（修复 MinerU OCR 的 '?' 空洞）
3. `bibgraph/ingest_latex/assets.py` — 矢量图栅格化 `page.get_pixmap(matrix)` → PNG（EPS 走 Ghostscript，与本次迁移无关）

## 测试 PDF（本地，均在 data/ 下）

- `data/output/arxivpdf-1610.08981/arxivpdf-1610.08981.pdf` — born-digital arXiv PDF（hyperref，主测目标）
- `data/output/arxivpdf-astro-ph-9707253/...pdf` — 1997 年老 arXiv
- `data/output/ads-1983ApJ...270..365M/...pdf` — ADS 扫描件（注意：实测**它带 OCR 文本层**，两个库判定一致）
- `data/input/2603.03522.pdf` — born-digital

## 逐项结果

| 能力 | 判定 | 证据 |
|---|---|---|
| 链接/named dest 采集 | ✅ 有差异需适配 | 4 个 PDF 每页链接数完全一致；抽样 dest 名与目标页全对上（`cite.Bosma1978`→p20、`section.7`→p9） |
| 文本层 + bbox 裁剪取字 | ✅ 有差异需适配 | 文本层判定 4/4 一致；「字符中心在 rect 内」遍历法与 PyMuPDF `clip=` 输出**逐字节相同** |
| 栅格化 | ✅ 完全等价 | 200 DPI 渲染同页均得 1700×2200 PNG，**MD5 相同**（同一 MuPDF 渲染器） |

性能：WASM 冷启动 ~51ms；23 页全文渲染 157ms/页（PyMuPDF 127ms/页）。包体 14MB、零传递依赖。

## 移植适配点（spike 已验证写法，直接照做）

1. **无 `kind` 枚举**：用 `link.isExternal()`；内部链接 URI 形如 `#nameddest=cite.X`，需剥前缀 + `decodeURIComponent`（如 `cite.2021A%26A...` → `cite.2021A&A...`）
2. **y 坐标原点**：mupdf 的 dest y 已是左上原点，TS 移植时**删掉** `pdf_links.py` 里的 y 翻转（`1.0 - ty/th`）
3. **裁剪取字**：无 `clip=` 参数，用 `toStructuredText().walk({onChar})` 按「字符 quad 中心在 rect 内」过滤，约 15 行；`asJSON()` 只到行级，词级需自行用空格切分 + quad 合并
4. **pixmap**：`page.toPixmap([z,0,0,z,0,0], mupdf.ColorSpace.DeviceRGB, false)` → `pix.asPNG()`，一一对应
5. name tree：`doc.asPDF().loadNameTree("Dests")` 等价 `doc.resolve_names()`（338 条目一致）

## 参考工件

`/tmp/mupdf-spike/`（临时目录，可能被系统清理）：`links_py.py` / `links_js.mjs` / `text_py.py` / `text_js.mjs` / `raster_py.py` / `raster_js.mjs` + 对照 JSON + MD5 相同的 `page1_js.png`/`page1_py.png`。移植 PDF 管线时若已丢失，按上文适配点重写即可，不必重跑 spike。

## 对计划的影响

- Phase 0 技术风险项关闭，剩余仅「冻结 golden files」（用 Python 管线对固定论文集存档，作为 TS 移植的 diff 验收标准）
- PDF 管线（Phase 3）从高风险降为机械移植 + 上述适配层
- 环境备忘：Node v24 / npm 11 可用；PyMuPDF 对照解释器为 `/home/wwu/miniforge3/envs/astro/bin/python`；pandoc 在 astro env 的 bin 里，跑 LaTeX 管线需把它加进 PATH
