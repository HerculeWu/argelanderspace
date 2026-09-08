# Stage 5 定稿计划：LaTeX 解析线路重构（IR 化）（2026-09-04 grilling 三轮 Q1–Q13 拍板，用户确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`。起点 = Stage 4 关闭后的 main。
> ⚠️ **参考资产**：prototype 已全量转移至 **`/tmp/texToHTML`**（2026-09-04，2063 条目/字节级校验一致；含其自身 git 未追踪的核心代码 `src/build/` 与 `docs/PRD.md`/`DESIGN.md`，中文）。原移动硬盘已被用户挪作他用——**/tmp 副本可能是孤本，且 /tmp 会被系统清理**；若丢失，问用户是否另有备份。

## 状态

**2026-09-04：设计 grilling 完成（三轮 Q1–Q13 全锁定，用户确认"达成共识"），MS1 开工。** commit/执行进度随 milestone 追加在本节。

**2026-09-04：MS1（编译执行层）实现完成，四道门全绿，未 commit（待对抗审查 + 用户 smoke）。** 验证结论/坑位详见 `2026-09-04-stage5-ms1.md`：mathnum 补丁点实测成立（amsmath 只 patch `\tagform@` + 环境白名单 + `\ifmeasuring@`；内核回退 `\@eqnnum`）；零干扰（.aux 逐字节相同）有成形测试；两颗 golden fixture 因 figures 是 148B 占位 stub 无法编译，只冻结了合成 fixture（battery/minimal），golden 重冻留 MS2。

**2026-09-04：MS1 对抗审查一轮（BLOCK → 全部修复，四门复测全绿，未 commit）。** B1 hyperref+`\tag` 击穿插桩（`\Hy@make@anchor` 在 `\protected@edef` 内爆炸）→ 捕获 group 内 `\let\Hy@make@anchor\@empty` + `\protected@xdef`，新增 hyperref 回归 fixture（冻结 + 真编译）；B2 预扫描误伤注释行 → 逐行剥注释 + 整文匹配（多行 `\usepackage{% minted}` 仍拒）。非阻塞：N1 伪 mathnum（含宏号）parser 层丢弃+计数；N2 `\tag*` 不捕获=已知限制；N3 事件加 `file` 字段（`\CurrentFile`，主/子文件可靠、生成文件回读滞留主文件名——去重不可靠，已文档化）；N4 裸 DOI 需后缀含字母；N5/N6 交叉注释+缺失资产测试。详见 `2026-09-04-stage5-ms1.md` 审查修复记录节。

**2026-09-04：MS1 landed + push 前关闭。** 复核 APPROVE（独立 fixture 复验 B1：事件值与 pdftotext 真值逐一对齐 `(1)(B)(2)(T1)(3)(4)(A*)(5)(6)`；B2 边界全过；两文档行补记：verbatim 过匹配存照、hyperref 下 aux 带 label 的 tag 号有外层花括号 `"{B}"` vs 事件 `"B"`，MS2 join 须剥）。commit：memory `edd8fb6` + MS1 代码 `d91471d`（测试 541→610 左右：core 177/infra 84，真编译用例本机全跑零 skip）。

**2026-09-04：MS2（融合层）实现完成，四道门全绿，未 commit（待对抗审查）。** 详见 `2026-09-04-stage5-ms2.md`。要点：contracts `TexDocIrSchema`（DocIr.extend + version + source/meta，seed 字段同名）；unified-latex 源树（自管 signature 表 + \input 合并 + 有界宏展开，含 undelimited 单 token 参数）；编号 join = mathnum 事件（env 块+序）/section 事件（\@sect 已扩 subsubsection）/**lot/lof（\@writefile 记录，修掉 label-before-caption 笔误）**/aux/计数回退；两 golden 重冻至 `tests/golden/tex/`（figure stub 换真实最小字节，旧管线复跑不敏感已证），人工抽查对 ar5iv 全对（节/式/图/表/refs）。测试 core 177→222、contracts 32→39。

**2026-09-04：MS2 对抗审查一轮（BLOCK → 修复，四门复测全绿，未 commit）。** B1 plain-table 题注丢失（holder 注册条件错用 opts 字段）/B2 center 包裹 tabular 空表体（findTabularDeep 递归布局透明 env）/B3 comment 环境内容混入 code 块（verbatim 节点按 env 名丢弃 + 附带修复 `\small{…}`/`{\small…}` 剥壳使 2012.05220 的 ADQL code 块回归旧 golden 库存）全修复+复冻；N1 宏展开 pass 上限警告、N2 缺产物静默化、N3 golden 抽查补题注/表体/code 库存断言。详见 `2026-09-04-stage5-ms2.md` 审查修复记录节。测试 core 222→228。

**2026-09-08：MS3a（存储切换+消费侧重接）完成，四门全绿，未 commit。** 详见 `2026-09-08-stage5-ms3a.md`：CLI/acquire/upload 全链路接新 tex 管线（`IngestPipelines` 端口改返 TexDocIr）；`/api/paper/:id/ir` 落盘即读（旧形投影容忍至 MS4）；raw `/api/paper/:id` 删除；agent read/show/ref/list 直读存 IR（token 约定不变，ref 锚点 p-7→p-6 属段落切分差异）；seed/graph 零改动（references 字段对照：共享条目 authors/year/title/doi/arxiv_id 全同，2012.05220 编译态 .bbl 少一条=印刷真值）；warnings 经 onProgress 进 job log；顺带修出行尾注释空格丢失 bug（已复冻 golden）。E2E smoke 全过（CLI ingest→library build→agent 命令→server curl）。测试 core 228→229、其余持平。

**2026-09-08：MS3b（旧管线全删+依赖清理）完成，四门全绿，未 commit。** 详见 `2026-09-08-stage5-ms3b.md`：`pipelines/latex/`、infra latex{pandoc,pipeline,assets}、infra/pdf、documents{annotate,citations,crossrefs,geom,document}、旧测试套件/旧 golden/孤儿 fixtures 全删；mupdf 依赖+tsup external 移除（**createRequire banner 保留——真消费者是 `ws`，移除实测炸 bundle**）；DocumentSchema/buildDocIr 与两个投影回退点保留至 MS4，两颗旧 golden 转桥接 fixture（`core/tests/fixtures/document-*.json`）。**pandoc shim 退役**（无 shim 全绿）；测试 622→511。

**2026-09-08：MS4a（发布打包修复+文档换代+memory 收尾）完成，四门全绿，未 commit。** app bundle 随包 `dist/argelander.sty`（`copy-assets.mjs`；缺失时插桩静默降级已实测并修复）；npm pack 复验：67 文件、零 mupdf、createRequire banner 在、pristine prefix 摄入带事件流。README/skills/AGENTS.md/web README 换代 pandoc→TeX Live（外部依赖只剩 TeX Live + 可选 dvisvgm）；memory 四件同步（product-and-architecture 管线/存储段重写、pitfalls 增补（stale dist/banner=ws/dvisvgm 传递依赖/插桩资产随包）、development-log Stage 5 执行记录、known-issues subequations 条目关闭）。**MS4b 待做**：存量迁移执行（Q5/Q12）+ 旧形投影回退删除。测试计数持平（511）。

**2026-09-08：MS4b（存量迁移+fallback 删除+smoke 手册）完成，四门全绿，未 commit（待用户 smoke + commit 拍板）。Stage 5 代码侧至此全落地。** 迁移（Q5/Q12）：备份 `literatures.stage5-backup.tar.gz`（358MB，验收后可删）→ 清 `output/*/.json`+`assets/`（保留 `src/` 与 `.latexcache`）→ 缓存离线重摄入。**arxiv 12 颗：7 成功**（1609.05917 pdflatex 失败自动 xelatex 成功/2012.05220/2501.17225/2603.03522/2607.17040/1610.08981/1804.10121）；**5 编译失败按缺失附件处理，根因逐个诊断**：0902.1039（老 aa.cls `\newcommand{\bibfont}`×现代 natbib）、1307.2657（emulateapj-rtx4.cls 不在 TeX Live；实测改名 TeX Live 的 emulateapj.cls 可编译，未自动应用）、1307.8124（aa.cls 未随包；换新版又触发 longtable 单列模式错）、2603.00229（`\na` 宏/aas_macros 缺）、astro-ph-9707253（**plain TeX 格式非 LaTeX**）。**28 颗非 LaTeX 时代残留（pdf 5/html 21/upload 2，另 document/ 空目录）按 Q5 缺失附件处理**。`library build --offline`（两轮——第二轮补齐最后摄入的 1610.08981/1804.10121 挂接）：works 35→36（+1=Palomar 正典 work 显现——之前被 upload doc 的 doi stamp 遮蔽，非 bug），**8 个 work 带 doc（7 文档全覆盖，2607.17040 挂 2 work）**，零悬空 doc_ids，全部 works 的 note/label/star/read/tags 与迁移前逐字节一致。Boot 验证过（/api/papers 列全 7 颗/ir/library refs=36/images pdf.svg 200）。Fallback 删除：contracts `document.ts` 整删（Reference schema 移入 `doc-ir.ts`）+ golden.test.ts；core `documents/{ir,tokens,traverse}.ts` 与对应测试+桥接 fixtures；`render.ts` 手术（删 5 个 Document 渲染函数、收养 citeShort/segments*）；server /ir 无 version → 404 "pre-migration document, re-ingest it"；cli loadDocIr 无 version → throw。smoke 手册 `docs/manual-test-stage5.md`（§0-§9，迁移表/摄入/zip 上传/阅读器/CLI/编译失败面/遗留物；zip 上传幂等证据真实跑过）。测试 511→455（contracts 30/core 138/web 105/infra 57/server 92/cli 33）。

**2026-09-08：smoke R1 修复（图转换器 dvisvgm → pdftocairo/gs）完成，四门全绿，未 commit。** 用户 smoke 发现 `arxiv-2501.17225` 的图在阅读器里丢全部文字——实证诊断：`dvisvgm --pdf --no-fonts` 在真实 figure PDF 上不忠实（Chrome 实测 32k path 零字形渲染、零 `<image>`，内嵌位图整批丢失）；`pdftocairo -svg` 完全忠实。修复：infra `tex/figures.ts` 改 PDF→`pdftocairo -svg`、EPS→`gs pdfwrite`+`pdftocairo` 两步（沿用旧管线 gs 习惯 `-dSAFER -dEPSCrop`），dvisvgm 全退役；测试换**带文字/内嵌位图的真实 matplotlib fixture**（glyph `<use>` 计数 + viewBox 对 pdfinfo + `<image>` 存在断言——三角 stub 再也混不过关）；golden assets 与 7 颗存量文档的 72 个 SVG 全部按同名集重物化（零 EPS 存量）；Chrome 对 pdftoppm 真值抽验 All_in_one_XY + fig08（12 内嵌位图）全对。Q4/Q9 锁定决策已加修订注记。测试 455→457（infra 57→59）。

## 范围变更（Q8）

原 Stage 5（论文写作）**删除**，不顺延。新 Stage 5 = 重新定义文档解析后的 IR，**IR 即存储形式**，streamView（网页流式渲染）与 agent 内容均从 IR 渲染；**UX 不增不减**；pagedView（prototype 的 SVG 伪 PDF 视图）**不进 repo**，仅为 prototype 开发期验证手段。

## 目标管线（双通道融合）

```
.tex 源码树 ──unified-latex 解析──┐（\input 合并、有界宏展开层）
                                  ├─融合（jsonl 源码行号对齐锚定）→ 新 IR → 落盘 <doc_id>.json
latexmk 编译（隔离 workspace）────┘（.aux/.bbl/.toc/.fls + 插桩 .sty 的 .argelander.jsonl）
```

## 锁定决策（Q1–Q13）

1. **全文树来源（Q1=B）**：unified-latex（**MIT license**，© Brade/Siefken，与项目 MIT 零冲突；官方 `@unified-latex/unified-latex-util-macros` 提供 `\newcommand` 提取+展开）从 `.tex` 源码出全文树；编译产物负责权威锚定。自写**有界宏展开层**（提取 `\newcommand`/`\renewcommand` → 使用点展开；病态构造降级为原样保留）。藏在宏里的 `\cite`/`\label` 由编译事件兜底（.sty patch 的是展开后的内部命令）。否决 A（编译器全量 dump：内容捕获侵入、风险最大）与 C（tex4ht：又一套外部工具行为差异）。
2. **编号语义（Q2=a，用户要求 memory 明确）**：**全面印刷忠实**——显示号 = 编译器真号（`.aux \newlabel` + mathnum 事件）；**未编号 display 公式不再显示 (N)**（推翻 Stage 3.1"一切 display-math 自产 1..N 编号"）；结构 id（`sec-N`/`fig-N`/`eq-N`/`ref-N`/`tab-N`）照旧生成、承担寻址/深链接，与印刷号解耦。crossref chip/agent 引用的号从此 = 论文里的真号。
3. **IR 存储边界（Q3 全采纳）**：存储 = 新 IR 单文件，沿用 `<doc_id>.json` 文件名 + schema 内 `version` 字段；内容 = 现 DocIr 同构扩展 + references/bib + source/meta 身份块（seed/stamp 要用）；**原生 segments**（cite/xref/math 段直存，`[[cite:…]]` token + occurrences 双轨退役）；砍掉 write-only 的 index 桶与 stats；regex fallback 注释层（documents/citations.ts/crossrefs.ts/annotate.ts）**删除**；目标 **web 消费零改动**。
4. **工具链（Q4 全采纳；2026-09-08 smoke R1 修订）**：白名单 = `latexmk` + `pdflatex`/`xelatex` + `bibtex`/`biber`（latexmk 自动调，全 TeX Live 自带）+ **按需** `pdftocairo`（poppler-utils）+ `gs`（ghostscript，仅 EPS 两步转换用）（缺失/失败只降级图片，不失败摄入）；~~poppler 不引；gs 不直接调（dvisvgm 传递依赖）~~ **（smoke R1 修订：dvisvgm `--pdf --no-fonts` 在真实 figure PDF 上丢全部文字与内嵌位图——经验证伪，改引 poppler + gs 直调，与 prototype 像素核验过的主路对齐）**；**引擎 = pdflatex 优先、编译失败自动换 xelatex 重试**；双引擎皆败 = 硬失败 + 错误分类指路（COMPILE_ERROR/TIMEOUT/UNSUPPORTED，`!` 行摘录；minted/shell-escape 预扫描拒绝）。**不做无编译降级解析**。**关键洞察：不做 pagedView 则 IR 不需要 XDV**——消费的全是引擎无关产物，引擎因此自由。
5. **存量迁移（Q5+Q12）**：删旧 `<doc_id>.json` + 旧 `assets/`，**保留 `src/` 与 `.latexcache`** → 全部条目（含 upload 族）免用户操作自动重摄入；**不加新 CLI 表面**，agent 执行期脚本化批量重跑；无 `src/` 条目 = 缺失附件处理（work 保留、doc 栏空、可上传补）。编译产物留 `<doc_id>/build/`（`.aux`/`.bbl`/`.toc`/`.fls`/`.argelander.jsonl`；成功丢 `.log`，失败摘 `!` 行进 job error）。
6. **pagedView 边界（Q6）**：IR **不留 page 字段**（严格 YAGNI，后续需要再说）；扩展版 `.sty` 以 prototype 为蓝本**自写**进 repo；`.aux`/`.bbl`/`.toc` 解析按我们 schema 重写（借鉴不搬码）；XDV 降层/dvisvgm 页面管线/dviasm/像素对拍报表整体不进。
7. **锚点与 agent 契约（Q7 全采纳）**：只承诺 id scheme 稳定（`sec-N` 形式照旧），不承诺同文档重摄入逐锚点稳定（web 未知锚点已有静默兜底）；**agent markdown token 约定原样保留**（`[cite:…]`/`[ref:…]`/`$$…$$`/`[Figure omitted…]`），改从新 IR 生成；skills 文档只更新环境前提（pandoc → TeX Live）。
8. **图片物化（Q9 全采纳；2026-09-08 smoke R1 修订）**：光栅图/SVG 源图字节直通；PDF 矢量图 → **`pdftocairo -svg`** 出 **SVG**；EPS → 两步（`gs -sDEVICE=pdfwrite` → tmp PDF → `pdftocairo -svg`）；转换失败/工具缺失 → 该图降级（块+caption 保留、无图，摄入不失败）；**TikZ/pgfplots 不渲染（维持现状不增功能），记 known-issues 遗留**（用户明确）。**（smoke R1 修订：原定的 `dvisvgm --pdf`/`--eps` 路线被真实图经验证伪——Q9 当年的"0.1s 干净矢量"只在无文字的三角 stub 上验过；真实 matplotlib 图经 dvisvgm 丢全部文字（Chrome 实测 0 字形）且内嵌位图 XObject 整批丢弃；pdftocairo 输出经 headless Chrome 对 pdftoppm 真值逐图核对文字+位图齐全。dvisvgm 全面退役。）**
9. **测试策略（Q10 全采纳）**：分层——大量单测吃**冻结编译产物**（fixture 冻 `.aux`/`.bbl`/`.toc`/jsonl+源码树，融合层单测不跑编译）+ 少量真编译 e2e（`HAVE_LATEXMK` 探测 gating，照 `HAVE_PANDOC` 先例）；两颗 golden（2501.17225/2012.05220）新管线**重冻** + 人工抽查，维持普通回归定位；pandoc/mupdf 全套测试随依赖删除；2607.17040 不进 golden，留手动 smoke。
10. **插桩 .sty 覆盖（Q11 全采纳）**：**cite（兜宏展开+对拍）、label、section 保留**（prototype 已有蓝本）+ **新增 mathnum 事件族**（挂钩 display-math 编号排版点，每印一号写 jsonl：`\theequation` 真值+源码行号+环境名；`\tag` 值天然正确；amsmath 逐行排号 → align 行级事件）；**`\ref`/`\eqref`/`\autoref` 不插桩**（源码可见+`.aux` 足够）。**盲区机制**：numbered 但未 `\label` 的公式（`.aux` 没有它）由 mathnum 事件覆盖；**插桩失败 → 干净编译重试** → 编号降级 `.aux`+源码数数 + warning；编译本身失败才硬报错（Q4）。
11. **执行流程（Q13）**：MS 切分见下；沿用 Stage 4 流程——每 MS 四道门（`corepack pnpm -r build|test|typecheck` + 根 lint）→ subagent 独立对抗审查 → 双过自行 commit（用户已授权，不逐次问）；**push 待用户 smoke 通过**。

## Milestone 切分

- **MS1 编译执行层**：新命名空间 `packages/core/src/pipelines/tex/`（ports + facts 纯解析）+ `packages/infra/src/tex/`（workspace 隔离：tmpdir/拷源/拒 symlink/资源护栏；latexmk runner：pdflatex→xelatex 回退、`-interaction=nonstopmode -recorder`、minted/shell-escape 预扫描、错误分类 `!` 摘录、超时；产物收集进 `<doc_id>/build/`；dvisvgm 图片物化）+ `argelander.sty`（cite/label/section/mathnum）。旧 `pipelines/latex` **不动**（并行建设，MS3 切换）。单测吃冻结产物（由新 runner 对 fixture 实跑冻结；`/tmp/texToHTML` 各 fixture 的 `dist/facts/` 也有现成 `.aux`/`.bbl` 可参考）；真编译用例 `HAVE_LATEXMK` gating。
- **MS2 融合层**：unified-latex 树 + `\input` 合并 + 宏展开层 + 编号/cite/xref 锚定（行号对齐）+ 新 IR 构建（contracts 新 schema：DocIr 同构扩展 + version + source/meta/references）+ golden 两颗重冻 + 人工抽查。AASTeX `deluxetable` 支持移入融合层识别规则，`aastex.ts` 机械重写退役。
- **MS3 存储切换 + 消费侧重接**：server `/api/paper/:id/ir` 落盘即读（旧 raw `/api/paper/:id` 随旧 schema 退役）；CLI render 重指新 IR；library build 的 seed/graph 读新 IR 的 source/meta/references；upload 链路接新管线；**旧代码全删**（walk.ts/aastex.ts/pandoc.ts/mupdf raster/annotate/tokens/Document JSON schema/latex-ports helper/pandoc+mupdf 测试套件）；web 校验零改动（只换 fixture）。
- **MS4 收尾**：`docs/manual-test-stage5.md` smoke 手册 + README/skills 环境前提改写（pandoc → TeX Live）+ memory 同步（product-and-architecture 等落地后状态）+ 依赖清理验证（`npm pack` 无 mupdf、全 repo grep 无 pandoc/mupdf 残留、tsup external 移除）+ 存量迁移执行（Q5/Q12）。

## 推后事项/遗留（本阶段勿做）

- TikZ/pgfplots 渲染（known-issues 已收，Q9 用户拍板）。
- pagedView 全家（Q6）；synctex 解析、`.bib` 结构化层（prototype 设计过未实现，我们 `.bbl` 空时可用 core 已有 `@retorquere/bibtex-parser` 走 `.bib` 备用通道——实现期细节）。
- Stage 4.1（agent 操作计划页面）与 Stage 3.1 旧推后事项不变，见 `2026-09-01-stage3x-roadmap.md` 推后事项节。

## 取证存档（2026-09-04，两路 explore 子代理 + 本机实测，直接采信）

### A. prototype（/tmp/texToHTML，~9.15k 行 TS，npm 零运行时依赖）

- 编译：`latexmk -pdfxe -interaction=nonstopmode -xelatex="xelatex -no-shell-escape -recorder -synctex=1 %O %S"`，XDV 为唯一版面真源；隔离 tmpdir workspace（拒 symlink、2GB/10k 文件护栏）；错误分类 COMPILE_ERROR/TIMEOUT/UNSUPPORTED_BUILD（minted 预扫描）；插桩失败自动换干净编译。
- 插桩（`src/instrumentation/argelander-test.sty`，236 行）：natbib `\@citex`/kernel `\@citex` + `\label`/amsmath `\ltx@label` + `\@sect`（section/subsection）→ `\protected@write` 写 `<jobname>.argelander.jsonl`，事件带稳定 id（`cite-000001` 零 padding 6 位）、**源码行号**、页码；cite 另发 dvisvgm bbox special（bbox 名须纯字母数字）。`\ref` 族未插桩（v1 范围外）。
- facts（`src/facts/`，367 行）：`.aux \newlabel`→labels{number,page,title?}；`.toc \contentsline`→toc[]；`.fls INPUT`→inputs[]；`.bbl \bibitem`→references{key,raw,doi?,arxiv?,url?}（**title/authors 刻意不猜 = null**；biblatex 式 .bbl 无 thebibliography → 空）。解析失败降级不 fail。
- 其"IR"= 分层产物集（pages/*.svg + manifest.json + semantics.json + facts.json），**无文档树**——段落文本/公式源码/表格体/图注全无，数学只剩 SVG 字形。我们的 IR 规则是新设计，prototype 只证明"编译器产物通道"可行（真实 17 页 AASTeX 论文 2304.04783 端到端过，140 语义元素、27 图降层）。
- pagedView 机制（仅备将来参考）：dviasm dump → lower-xdv.ts（890 行，修 dvisvgm 3.4.3 丢 `pdf:image`/`x:scale`/`pdf:btrans`）→ dvisvgm `--font-format=woff2 -bbox`（原点 -72bp,-72bp）→ pages/*.svg；页尺寸靠 poppler `pdfinfo`。viewer = vanilla TS。
- 依赖：latexmk 4.86a/TeX Live 2025 + dvisvgm 3.4.3 + dviasm + poppler；153 单测 + 25 e2e。

### B. 本机实测（2026-09-04）

- TeX 全家齐：latexmk/xelatex/pdflatex/lualatex/dvisvgm **3.2.1**/dviasm/biber/bibtex + poppler + gs（/usr/bin）。
- `dvisvgm --pdf fig-vector.pdf` 实测出干净矢量 SVG（0.1s）；`ldd` 确认 dvisvgm 链接 `libgs.so.10`（gs = 传递依赖）。**（⚠️ 2026-09-08 smoke R1 证伪：该结论只在无文字的 stub 上成立；真实图丢全部文字+内嵌位图，dvisvgm 路线已退役，见决策 4/8 修订注记。）**

### C. 现 repo 手术面（MS3 删除/重接清单的源头）

- pandoc 面：`packages/infra/src/latex/pandoc.ts`（`PANDOC_MIN_VERSION=[3,9]`、`latexToAst`/`fragmentToBlocks`/`bibtexToCsl`；`mathmlToLatex`/`katexify`/`stripMathDelims` 已只剩测试在用）；AST 消费者 walk.ts/references.ts/pipeline.ts；helper `core/tests/helpers/latex-ports.ts`。
- mupdf 面：`packages/infra/src/pdf/raster.ts`（pdfToPng；epsToPng 走 gs CLI）；`packages/infra/src/latex/assets.ts` 只剩测试在用；manifest：`infra/package.json` + `app/package.json` 各 `"mupdf": "1.28.0"`、`app/tsup.config.ts:20` external（createRequire banner 届时实测再定）。
- 存储/消费：`literatures/output/<doc_id>/<doc_id>.json`（Document JSON）+ `assets/` + `src/`；server `/api/papers` 扫描、`/api/paper/:id`（无 web 消费者）、`/api/paper/:id/ir`（buildDocIr 按需投影、PaperCache mtimeNs+size）、`/images/*`；watch.ts 指纹 `output/*/<doc>.json`；library build 的 `seed.ts:iterDocs/docReferenceIds` 读 `doc.source/meta.title/references`。
- DocIr/`buildDocIr`：`contracts/src/doc-ir.ts` + `core/src/documents/ir.ts`（segments 四型 text/math/cite/xref；七类块；refsManifest/bib/references/citationsByBlock）；web 消费面 segments.tsx/Block.tsx/store.tsx/deeplink.ts/RightPanel/TocPanel/math.tsx(katex)/FigureImage；CLI markdown `documents/render.ts` token 约定。
- golden：`tests/golden/arxiv-{2501.17225,2012.05220}.json` + manifest；源码 fixture 在 `core/tests/fixtures/latex/`；消费方 contracts/golden.test.ts、core/golden-latex.test.ts（真 pandoc）、ir/render 测试、server helpers。
