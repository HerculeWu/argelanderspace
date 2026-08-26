# M3c 完成：出版商 HTML 管线移植进 packages/core（2026-08-26）

Milestone M3c（pipeline_html.py + ingest_html/{base,fetch,inline,mathml,aanda,oup}.py 的 bug-for-bug TS 移植）完成。**两篇 golden（aa39341-20 A&A、962260 OUP/MNRAS）逐字段 0 diff，豁免清单为空。** 基线预验：astro env Python 管线离线重跑两篇与 golden 一致（pandoc 无漂移；脚本 /tmp/m3c-baseline/run.py，同时枚举了抓取 URL）。

## 模块映射（bibgraph/ → packages/core/src/pipelines/html/）

- `pipeline_html.py` → `pipeline.ts`（`ingestHtml(source, ports, opts)` async + 导出的 `annotateHtmlDocument`——Python 的 `_annotate_document`，12 个单测直接用它）+ `ports.ts`（`HtmlPagePort`/`HtmlMathmlPort`/`HtmlPipelineConfig` + 默认同 config.py HtmlConfig）。
- `ingest_html/base.py` → `base.ts`（`HtmlAdapter` 接口、`ParsedDoc`、注册表 `HTML_ADAPTERS`/`registerAdapter`/`adapterFor`、`htmlAdapterInfos()` 给 planner 的活注册表钩子）。**`_anchor_matches` 猴补丁改为 `anchorMatches: Map<RichText, Match[]>`**（同 M3a Walker 惯例，结构性不可能泄漏进 JSON）。
- `ingest_html/inline.py` → `inline.ts`（renderInline/AnchorTarget/InlineContext/plainText；InlineContext 多带一个 mathml port——Python 是在 `_inline_math_latex` 里 lazy import）。
- `ingest_html/mathml.py` → 拆开：`annotationLatex`（DOM 读）+ `stripMathDelims` 进 core `mathml.ts`（M2 时 core 无消费者所以全在 infra，现在有了）；pandoc 本体 `mathmlToLatex`/`katexify` 仍是 M2 infra `latex/pandoc.ts`，作为 port 注入。
- `ingest_html/aanda.py` → `aanda.ts`；`oup.py` → `oup.ts`（模块底部 `registerAdapter(new XAdapter())` 注册；`pipeline.ts` 副作用 import 两个适配器——对应 Python 包 `__init__` 的注册语义）。
- `ingest_html/fetch.py` 的纯函数（looksLikeDoi/normalizeSource/docIdFromUrl）→ core `source.ts`（管线组合需要）；**infra `html/fetcher.ts` 改为从 core re-export**（单一实现，M2 fetcher 测试原样绿）。`Fetcher` 类本体留在 infra。
- 接线：`packages/infra/src/html/pipeline.ts`（真 Fetcher 绑 `<outRoot>/.htmlcache` + pandoc mathmlToLatex），同 M3a/b 结构。

## cheerio 在哪、为什么

**cheerio 在 core**（`pipelines/html/*`）：适配器九成是 DOM 行走，若 core 去 cheerio 化则 core 只剩空壳；决策 #11 本就定了 cheerio 是项目解析器。infra 的 port 只回原始文本（`get(url) → {finalUrl, text}`），解析全在 core。core 新增依赖：cheerio ^1.2.0、domhandler ^5.0.3、htmlparser2 ^10.1.0。

## ⚠️ 本里程碑最大的坑：解析器树形语义（bs4 html.parser ≠ htmlparser2/parse5）

**cheerio 1.2 的 `load`（parse5）和 `cheerio/slim`（htmlparser2）都会在块级子元素前自动闭合 `<p>`**（htmlparser2 有硬编码 openImpliesClose + 流浪 `</p>` 补空 p），而 Python html.parser 从不自动闭合。golden 直接抓到两类分歧：

1. aa39341-20：`<p><div class="inset">…</div></p>` 浮动体包装、`<p><pre>ADQL</pre></p>`——bs4 里 pre 留在 p 内成为段落文本，htmlparser2 把它弹成顶层导致整段丢失（差一段，后续 p-N 编号全错）。
2. 962260：`<p class="mixed-citation-compatibility"><span>…<div class="year">…` 参考文献条目——p 被弹开后 year/source/volume 散落被丢弃（106 处 diff）。

解法：**`bs4-parser.ts`——在 htmlparser2 的流式 Parser 回调上手写 bs4 树构建器**（`parseBs4(html) → domhandler Document`，再交给 `cheerio/slim` 的 load 包装成 CheerioAPI 供 CSS 查询）。规则：忽略 Parser 的 implied-close（不自动闭合）；自闭合 `<foo/>` 要闭合（html.parser 的 handle_startendtag），与 auto-close 的区分靠 **Parser 自有 stack 栈顶**（自闭合路径回调时栈顶仍是该标签，auto-close 路径已被 shift）；真结束标签 pop 到最近同名开放元素（bs4 `_popToTag`），无匹配则忽略；void 元素（bs4 的 24 个空元素集）建节点但不压栈；相邻文本合并（对齐 convert_charrefs）。Parser 私有 `stack` 属性类型上不可见，runtime 可读，cast 取用。

次要点：bs4 4.13 的 Tag **恒真**（空 meta/td 也真）——`find() or fallback` 直接按 null 判断移植即可。`get_text(" ")` 语义 = 所有后代文本节点按文档序以 " " 连接（注释和 script/style 原文除外），OUP 参考文献里 ", 1999" 前的空格就是这么来的，必须精确复现。

## bs4 兼容序列化器（serialize.ts）

`table_body` 是逐字节进 JSON 的 HTML 字符串，golden 里是非 ASCII 原样 UTF-8（U+2013/希腊字母/U+2212…），而 dom-serializer/parse5 会编成 `&#x…;`、空元素输出 `<tag/>`。`bs4OuterHtml/bs4ChildrenHtml` 复现 bs4 `str()`：文本只转义 `&<>`、属性值含 `"` 时改单引号、多值属性（class 等）空白归一、void 元素 `<br/>`、空非 void `<tag></tag>`。数学元素喂 pandoc 也走它 → pandoc 输入与 Python 逐字节一致。

## 夹具（packages/core/tests/fixtures/htmlcache/，1.4MB）

从 `data/output/.htmlcache` 归档 **10 个页面条目**（.html+.url 对）：aa39341-20 的 DOI 请求页 + T1–T8 子页，962260 的 DOI 请求页。枚举方法：Python 管线间谍 Fetcher 离线实跑记录全部 GET——**缓存键是请求 URL（DOI 的 doi.org URL），不是最终落地 URL**（重定向后 URL 在 .url 文件里）。图片 download 直写 assets/ 不进 URL 缓存，JSON 里只有确定性 `assets/<fn>` 字符串 → 不归档图片，测试 port 写 1x1 占位 PNG 回 true（M3a raster 惯例）。`manifest.json` 记录 doc_id/源 DOI/请求 URL/页面哈希清单/出处。OUP 表格内联无子页抓取；962260 是 legacy 版式：0 个 math 元素，公式全是图片 → FigureBlock（label "Equation N"）。

注意：缓存的 T*.html 是真实出版商页面，开头带 Joomla PHP notice；**Biome 的 HTML 解析器会对夹具报 parse 错误**（override 关不掉 parse 级），`biome.json` 的 `files.includes` 加了 `"!**/tests/fixtures/**/*.html"` 排除。

## Golden diff 结果

`packages/core/tests/golden-html.test.ts`：两篇各跑真 `ingestHtml` 端到端（fixtures/htmlcache 回放 + 真 pandoc + 占位下载），读写出的 JSON 与 golden 递归逐字段 diff。**均 0 diff，`GOLDEN_ALLOWLIST = []`**（source.path 是出版商 URL 非本地路径；img_path 无 content hash；无抓取时间戳入 JSON）。pandoc 门控 describe.skipIf 同 M3a。

## 测试与验收（2026-08-26 本机）

- `corepack pnpm -r build` ✓（5 包）、`-r typecheck` ✓（5 包）、`pnpm lint` ✓（0 error 0 warning，129 文件）。
- 测试：contracts 17/17、**core 78/78**（64 基线 + golden-html 2 + html 单测 12）、**infra 78/78**（77 基线 + 接线 smoke 1：`html-pipeline.test.ts`，预热 .htmlcache + 真 Fetcher 全离线）。
- 12 个 `test_html_*` 全部移植进 `packages/core/tests/html.test.ts`（夹具 `tests/fixtures/sample_aanda.html` 拷入 core fixtures——无 glob 污染问题，但与 M6 删 Python 树解耦）。

## 上游 Python 侧观察（未修，bug-for-bug 保留）

- `aanda.py::_figure` 的 `label = self._float_label(node) or f"Fig. {n}"` 是**死变量**（算完不用，FigureBlock 用 `f"Figure {n}"`）；`_float_label` 因此也是死代码。TS 版直接未移植。
- `oup.py::_walk` 会把 `div.ref-list`（在 container 内）也喂给 `_blocks` 包装递归——参考文献区因此变成一串 paragraph 块进 structure（golden 里 structure[7] 就是 References 区全文段落）。原样移植，golden 为证。
- `oup.py::_blocks` 里 `section` 分支注释说 "handled by _section"，但**没有 `_section` 方法**（布局本来就是扁平的）——死注释。
- `pipeline_html.py` 无适配器时报错信息写 "Supported: A&A (aanda.org)" 但没提 OUP（OUP 其实也注册了）——报错文本滞后于注册表。

## 留给 M4+

- planner 的活注册表：`htmlAdapterInfos()` 已从 core 导出；`acquire/planner.ts` 的 `DEFAULT_HTML_ADAPTERS` 静态快照仍是默认值（注释已更新指向活注册表），CLI/server 组合层（M5）负责把活注册表传进去。
- infra `Fetcher.getSoup`（parse5 树）仍在但管线不用——M2 API，保留；注释已写明管线走 bs4-parser。
- 出版商站点仍全部 bot-wall（见 publisher-access-status 笔记）：这些适配器是待命能力，golden 夹具是唯一离线来源。
