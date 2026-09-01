# 下一阶段计划：Stage 3.1（已合并 3.2）+ Stage 4/5 远期（2026-09-01 用户拍板）

> **恢复指南**：本文件自足。开工前再读 `product-and-architecture.md`（产品/架构现状）与 `pitfalls.md`（环境坑）。当前 main 顶部 = `021ddde`（Stage 3 + 旧 memory 最后版）之后还有一个 memory 整理 commit（本批文件）。

## Stage 3.1（下一个；原 3.1 OCR 隔离 + 原 3.2 公式修复，用户拍板合并）

### 背景决策（不再重议）

- **OCR 降级"开发中"**（用户 2026-09-01）：当前阶段只接受 LaTeX 源摄入。论据：~9 成文章 arXiv 有与出版版一致内容；剩余 1 成中过半有出版商 PDF；扫描件极少；出版商反爬越来越强；MinerU 配额/鉴权（401）拖慢发布。例外论文用户自行转 LaTeX。
- **bug-for-bug / golden 逐字段 diff 基线退役**（用户 2026-09-01）：项目脱离重构期。golden 夹具转为普通回归测试，行为变更由 TS 管线自洽重冻 + 人工抽查。
- **webui 上传按钮保留**（用户纠正，勿删）：它是"用户自行获取论文 LaTeX 源码并入库"功能的入口，3.1 里把上传对象从 PDF 改为 **LaTeX 源码包**（具体计划届时制定；CLI 已支持本地 .tex/目录/tarball 走 latex 管线，见 `packages/cli/src/detect.ts`，改造有现成基础）。

### 范围清单

1. **OCR/非 LaTeX 摄入代码隔离**：移出 main，整体保存到 `ocr-features` 分支（git 历史双保险），main 保持干净。
   - 删除/隔离面：`packages/core/src/pipelines/{pdf,html}`、`packages/infra/src/{mineru,html}` 与 `infra/pdf` 的 links/text-provider、`packages/infra/src/acquire/pdf-downloader.ts`、cli 的 pdf/html 摄入路由（`detect.ts`/`program.ts` 收窄）、server upload 端点的 PDF 路径、golden-pdf/golden-html 测试与 infra 的 mineru/html/mupdf-text/mupdf-links/pdf-downloader 套件随分支走。
   - ⚠️ **必须留在 main**：`infra/src/pdf/raster.ts` 与 mupdf 依赖本体（LaTeX 管线用它栅格化矢量图）；`core/src/documents/`（textfix/citations 等是 Document 构建层，PDF 管线的纯逻辑一半在这——剥离时逐文件判断，textfix 的 PdfTextProvider 端口随 PDF 走，但 buildDocument 的编排要保住 LaTeX 路径）；acquire 的 upload.ts 改造成 LaTeX 包上传（见 3）。
   - acquire planner 的 HTML 适配器注册表/plan 输出降级或裁剪（出版物全墙，见 known-issues）。
   - README 摄入节同步收窄（arXiv/LaTeX only + "开发中"说明）。
2. **webui 空 stub pane 移除**：`Shell.tsx` NAV 的 `终端`(terminal)/`浏览器`(browser) 两项 + `CommandPalette.tsx` 对应两条 + StubPane 对应清理；**保留「计划」(plan) stub**（Stage 4 做）与「扩展」(ext) stub。
3. **上传入口改造为 LaTeX 源码包**：webui 上传按钮保留，对象改 zip/tarball（或 .tex）；server upload 端点改走 latex 管线；attach→seed→rebuild 链路复用。具体设计届时定（zip 内结构约定、doc id 命名、work 匹配）。
4. **公式编号保留**（用户决策：编号是人-agent/人-人交流的"坐标"，未被交叉引用的公式也要编号）：查 core latex walk/structure 的 number 产出逻辑（疑似只给被引用公式编号），改为全部编号（顺序或 \tag 优先的方案届时定）；LaTeX golden fixture 自洽重冻 + 人工抽查。
5. **公式丢失修复**：2607.17040 §2.2 首 "To study…" 段后的公式在 pandoc AST→walk 阶段丢失（疑似未编号环境 `equation*`/`\[...\]` 的提取间隙）；先复现定位再修。
6. **已读标识可见性复查**：Stage 3 验收时用户未注意到 `· 已读`/标题灰化（只发现未读蓝点）——确认 `.side-ref.read` 渲染真实生效，必要时增强。

### 取证存档（开工直接采信）

- 公式证据（Stage 3 验收实测，/tmp 库可能已清——重新 `ingest 2607.17040` 即可复现）：doc 里 5 个 equation block 全无 `number`；§2.2（sec-5）"To study…" 首段的下一块是 `p-11` 普通段落、段文本无 `$…$`（公式整个不在 doc 里）；stats：n_equations=5、n_crossrefs 49 仅 29 resolved。
- 参考实现位置：latex walk = `packages/core/src/pipelines/latex/walk.ts`；number/structure = `packages/core/src/documents/structure.ts`；golden 回归 = `packages/core/tests/golden-latex.test.ts`（fixtures `packages/core/tests/fixtures/latex/`）。
- upload 链路现状（PDF 版）：web `RefDetail.tsx` 上传按钮 → `api/library.ts uploadPdf` → server `POST /api/library/upload`（job 化、进度通道已通）→ core `acquire/upload.ts attachPdf` → `ingestPdf`。3.1 改造时把 ingestPdf 换成 latex 管线即可，进度/失败呈现机制全部复用。

### 流程与验收

- 分支策略：`ocr-features` 分支承载隔离出的代码（从 main 建，先删后挪或反向均可，保证两边各自四道门绿）；main 直接做其余项。milestone commit 逐次问用户；push 逐次问。
- 验收门照旧（`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`）；golden 重冻属预期变更，不算破基线。
- 手动验收：更新 `docs/manual-test-stage3.md` 或新写 3.1 版（摄入面收窄、LaTeX 包上传、公式编号、已读标识、stub pane 消失）。
- 助手预估工作量：合计**中等**——隔离删除是大头（infra 测试套件拆分最碎）；公式两项调查主导；其余小。

## Stage 4（远期，只记录不展开）

把**计划页面**（webui `计划` stub pane）补完 + agent 操作计划页面的相关功能。

## Stage 5（远期，只记录不展开)

论文写作功能。
