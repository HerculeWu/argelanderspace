# M2 完成：infra 适配器进 packages/infra（2026-08-26）

Milestone M2（副作用适配器）已完成并通过验收门。模块映射沿用 M1 惯例：一个 Python 文件 → 一个 TS 文件；端口实现 core 的 `PdfTextProvider` / `AdsSource` / `CrossrefSource` / `OpenAlexSource` / `PdfDownloader`。所有网络类客户端收 `fetchImpl` 注入（默认全局 fetch），测试全离线。

## 模块映射（bibgraph/ → packages/infra/src/）

- `ingest/textfix.py`（fitz 半）→ `pdf/text-provider.ts`：`MupdfTextProvider implements PdfTextProvider`（pageCount/pageSize/pageText/clippedText/close）+ `openPdfTextProvider`。
- `pdf_links.py` → `pdf/links.ts`：`extractPdfLinks(pdfPath): PdfLinks` + `hasPdfTextLayer`。
- `ingest_latex/assets.py` → `pdf/raster.ts`（转换器半：`rasterizePdfPage`/`pdfToPng`/`epsToPng`/`zoomFor`/`pngSize`）+ `latex/assets.ts`（`AssetResolver` 全量：locate/within 守卫/out_name/缓存）。
- `ingest_latex/pandoc_ast.py` + `ingest_html/mathml.py`（pandoc 半）→ `latex/pandoc.ts`：`latexToAst`/`fragmentToBlocks`/`bibtexToCsl`/`mathmlToLatex` + 纯函数 `katexify`/`stripMathDelims` + `havePandoc`/`pandocPath`。**KaTeX 清洗变换放 infra 的理由**：它们只为清洗 pandoc 输出而存在，core 无消费者，M1a/M1b 未移植。`annotation_latex`（DOM 读取）留给 M3 cheerio 适配器。
- `library/sources/{ads,crossref,openalex}.py` → `sources/{ads,crossref,openalex}.ts` + `sources/cache.ts`；ADS/OpenAlex 归一化器（`normalizeAdsDoc`/`normalizeOpenAlex`）随客户端落 infra（Crossref 的在 core，M1b 已钉）。
- `ingest_html/fetch.py` → `html/fetcher.ts`：`Fetcher`（get/getSoup(cheerio)/download）+ `looksLikeDoi`/`normalizeSource`/`docIdFromUrl`。
- `ingest_latex/fetch.py` → `latex/arxiv-source.ts`：`ArxivFetcher.downloadEprint` + `extractArxivSource` + `findMainTex` + `acquireSource` + id 解析。
- `mineru_client.py` → `mineru/client.ts`：`MineruClient`（extract/loadCached）+ `MineruConfig` + `MineruError`。
- `acquire/fetch_pdf.py::_download_pdf` → `acquire/pdf-downloader.ts`：`FetchPdfDownloader implements PdfDownloader` + `NotAPdfError`。
- 共享件：`lib/http.ts`（Throttler/fetchText/fetchBytes/fetchStreamedBytes/requests 风解码）、`lib/proc.ts`（findOnPath/runCapture）、`lib/pyjson.ts`（见下）、`lib/untar.ts`、`lib/unzip.ts`（手写 ustar/zip 读取器，node:zlib 自带解压——**零新增重依赖**，依赖只有 mupdf + cheerio + core）。

## mupdf 精确 API（spike 适配点落地）

- 打开：`mupdf.Document.openDocument(readFileSync(path), "pdf")`；页面 `loadPage(i)`；尺寸 `page.getBounds()`（CropBox，宽高 = x1-x0/y1-y0）。
- 文本：`page.toStructuredText().asText()` ≡ `get_text("text")`（实测每页字符数与 PyMuPDF 全等）。
- 裁剪：`toStructuredText().walk({onChar, endLine})`，**quad 中心（四点平均）在 rect 内**才收 + 行尾补 `\n`——与 PyMuPDF `clip=` **逐字节一致**（spike 两个 clip 值 'an\n' / 'chosing an optimal Υ\n' 复验通过）。注意：spike 早期脚本 text_js.mjs 用的相交过滤**不**等价（会多收边缘字符），memory 里的中心法才是终稿。
- 链接：`page.getLinks()` + `ln.isExternal()` / `ln.getURI()` / `ln.getBounds()`；dest 用 `doc.resolveLinkDestination(link)`（内部走 name tree，无需单独 `loadNameTree("Dests")`），返回 0-based page + **左上原点** x/y（y-flip 已删）。`#nameddest=` 剥前缀 + `decodeURIComponent`。
- 栅格化：`page.toPixmap([z,0,0,z,0,0], mupdf.ColorSpace.DeviceRGB, false)` → `pix.asPNG()`；200 DPI 渲染首页 = 1700×2200（spike 与 PyMuPDF MD5 相同）。
- 内存纪律：page/stext/pixmap 用完即 `.destroy()`，doc 在 finally 里 destroy（WASM 堆不自动回收）。

### mupdf 链接类型映射（实测确认）

PyMuPDF kind 5 (LINK_GOTOR) 的远端跳转在 mupdf 里是 `isExternal()=true` 且 URI 形如 `file:url.pdf#page=1&view=Fit`——mupdf 给 GoToR 加 `file:` scheme。映射：external 且非 `file:` → "uri"；`file:` → "other"；`#nameddest=` → goto + classifyDest；`#page=N` → goto + "goto"；其余无 scheme → "other"。1610.08981 实测：PyMuPDF kinds {4:856, 5:1} ↔ TS goto 856 + other 1 + uri 0 ✓。

## 关键决策与坑

- **缓存键字节级兼容 Python**（`lib/pyjson.ts`）：sources 的键 = `sha1(path + "?" + json.dumps(params, sort_keys=True))`，复现了 Python 的键排序（码点序）、`", "`/`": "` 分隔符、ensure_ascii \uXXXX 转义（含 0x7f 与代理对）。**实证**：公式算出的 crossref `0dfc3c7f…` 和 openalex `bc548d3c…` 键与 `data/library/cache/` 里现存文件名完全一致 → 旧缓存直接复用。缓存**内容**只保 parse 级一致（JSON.stringify vs json.dumps 的 ensure_ascii，同 M1b graph.json 先例）。
- **OpenAlex `api_key`（批准的刻意分歧）**：`$OPENALEX_API_KEY` 存在时拼到线上请求的 `api_key` 参数（Python 完全忽略它），但**不进缓存键**（响应内容与 key 无关，缓存与 Python 互通）。
- **MinerU `use_cache` 是死代码——原样保留的 Python bug**：探测用的是字面量 `content_list.json`，而真实 MinerU zip 解出来是 `<uuid>_content_list.json`（data/output 下 4 个真实缓存目录全部如此），所以该短路从不触发，重新摄入会重跑全流程。测试两条都钉了（字面量存在→离线命中；仅 uuid 前缀→重跑）。验收后可立项修。
- **tar/zip 手写**：`lib/untar.ts` 支持 gzip/纯 tar + GNU longname(L)/PAX(x) path/size 覆盖 + Python `filter="data"` 语义（绝对路径剥头、`..` 逃逸抛错、symlink/device 抛错）+ 炸弹上限（800MB/5 万成员）；`lib/unzip.ts` 走 EOCD→中央目录，stored/deflate，extractall 风名字消毒。fixture 用 Python tarfile/zipfile 生成，双向验证过。
- **pandoc 发现**：`findOnPath("pandoc")` 惰性解析（Python 是 import 时解析一次；惰性让测试/CLI 启动后还能补 PATH——良性改进）。缺失报错点名 PATH 和 astro env 路径（`/home/wwu/miniforge3/envs/astro/bin`）。测试文件在模块顶层把 astro bin 加进 PATH（`describe.skipIf` 在 collection 时求值，beforeAll 太晚）。
- **requests→fetch 语义分歧（已记录）**：文本解码 = Content-Type charset → text/* 无 charset 按 ISO-8859-1（requests 默认；WHATWG TextDecoder 把该标签映射到 windows-1252，0x80-9F 有差）→ 否则 UTF-8（requests 用 chardet 猜，近似）。`URLSearchParams` vs `urlencode`：`~`/`*` 编码方向相反，服务端解码等价，缓存键不受影响。undici/requests 都透明解 gzip，短读检查（decoded ≥ compressed）不会误触发。
- BeautifulSoup(html.parser) → cheerio（决策 11）：DOM 细节若有差，M3 golden diff 兜底。

## 验收

- `corepack pnpm -r build` ✓ / `-r typecheck` ✓ / `lint` ✓（0 error 0 warning）
- infra 测试 **73/73 绿**（8 文件，全离线；pandoc/gs 门控在本机均实跑）：mupdf-links 8、mupdf-text 4、mupdf-raster 9、pandoc 9、sources 13、fetcher 16、mineru 10、pdf-downloader 4。
- 既有基线不变：core 34/34、contracts 17/17。
- 复验数字（vs spike）：1610.08981 23 页逐页链接数 [99,41,…,0,0] 全等、总 857（856 goto + 1 other）；cite.Bosma1978→p20 dest (38.508,331.633 左上原点)；% 编码 dest 7 条解码出 `cite.2009A&A...`；ADS 扫描件 0 链接、有 OCR 文本层；前 6 页字符数 [5659,5671,6346,6565,4058,2797]；clip 两值逐字节等；首页 200DPI PNG 1700×2200。
- 夹具：`packages/infra/tests/fixtures/`（两个 spike PDF + 真实 crossref/openalex 缓存响应修剪版 + 合成 ADS docs + tar/zip/EPS/PDF/PNG 小件，共 3.4MB）。

## 留给 M3+

- 管线装配（ingestHtml/ingestLatex/ingestPdf 端口实现）还没开始——M3 的活。
- `annotation_latex` 的 cheerio 移植随 M3 HTML 适配器。
- Crossref/OpenAlex 的 UA 字符串仍是 `HubbleSpace/0.1 (…)`（保线上一致）；改名扫尾（M5/M6）统一换。
- 上游 Python bug 清单新增：MinerU use_cache 死代码（见上）。
