# Stage 3 设计定稿 + 实施计划（2026-09-01，grilling 3 轮全部拍板）

中断恢复指南：先读本文件与 `2026-08-27-stage2-acceptance.md`，再看下方"进度日志/当前状态"。

## 范围与决策（10 项，用户逐轮确认）

1. **范围**：主线①存储统一 ②渲染 SOT 共用 + C 组 webui 缺口（CLI 写入推 library.changed / note tab 全文 / label 色点 / 已读标识）+ D 组 upload bug（超时 / 进度 / failed 呈现）+ E 组 skills 层（空 note hint、不读源码条款、独立环境验收）。F（MinerU use_cache 死代码等 Python 遗留）不进，单独立项。
2. **存储拓扑**：**项目级库** `$PROJECT_ROOT/literatures/`（用户原话："我是想要每个项目一个库……literatures 应当只在项目根目录下，其余地方应当放其它的东西"）。**仅 cwd 相对，不做向上查找**（用户否决了助手推荐的 git 式向上查找）。解析链不变：flag > env `ARGELANDERSPACE_DATA_DIR` > config.toml `data_dir` > 默认 **`./literatures`**（修订 Stage 1 决策 #3 的 `./data`）。内部布局不变（output/library/jobs/input）。全局库复用摄入过的 paper = 未来方向，**不进 Stage 3**。
3. **渲染 SOT**：完整 IR 共用。core 构造结构化 IR（内联段显式配对 cite/xref occurrence；label/短引用/摘要/图片路径全在 core 算好）；server 加 `GET /api/paper/:id/ir`；web 渲染层改消费 IR（richtext.tsx 退役、types.ts 手写镜像删除）；CLI 从同一 IR 导出 markdown/manifests（导出签名不变）。图片路径三端统一为 `img_path` 原文（含子目录），server images 路由支持子目录。
4. **note tab 只读**（webui 不做编辑器；写路径归 agent/CLI）。
5. **MinerU 上传/下载超时 300s → 1800s**（对齐 poll 总超时 1800s；不重试、不加配置旋钮）。
6. **工程流**：main 直接做；每 MS 一个 commit（commit 前逐次问用户）；验收门 `corepack pnpm -r build|test|typecheck|lint` 全绿 + 专项测试；完成后 `docs/manual-test-stage3.md` 手动验收（含独立环境拓扑）。
7. **stage2 已 push**（2026-09-01，`60d5a26..d4a84e3 main -> main`，gh keyring 凭据一次性 helper 完成，未改 git config）；后续 milestone commit 只在本地，push 逐次问。
8. **`literature-library-skills/` 删除**（untracked，方法论已吸收进 `skills/argelander-*`）。
9. **repo `./data` → `./literatures` 迁移由助手执行**（Q10 按推荐 i）：32 个 tracked 夹具文件随 `mv`（commit 时 git 自动识别 rename）、`.gitignore` 的 `data/output`、`data/library`、`data/jobs` 三条改 `literatures/` 前缀。repo 从此 dogfood 新契约，用户 webui 习惯（repo 里裸跑 serve）不变。
10. 小项方案已定不再单列：外部写入感知用**轮询指纹**（默认 1500ms 间隔，library.json + output/ 各 doc JSON 的 mtimeNs+size；非递归 fs.watch 抓不到既有 doc 目录内 `<docId>.json` 落盘——upload 场景——故弃用 fs.watch）；server 自身写入导致的重复 broadcast 接受（前端 reload 幂等，去抖压频率）；旧 `/api/paper/:id` 端点保留；`search` 的空 note hint 打 **stderr**（stdout 保持纯 JSONL）。

## 关键事实（侦察固化，直接采信）

### upload bug 实锤（`data/jobs/upload-370f0af4-….json`）

- job **failed**，error = "The operation was aborted due to timeout"；07:13:03→07:18:05 共 302s，正好撞 MinerU 上传 POST 的 **300s 硬超时**（`packages/infra/src/mineru/client.ts:221` `AbortSignal.timeout(300_000)`；zip 下载 `:270` 同款 300s）。3.6MB PDF 已拷到 `output/upload-doi-…/`（attachPdf 先拷后 ingest），MinerU 死掉 → doc JSON 未写 → work.doc_ids 空 → webui 永远显示"需上传 PDF"。
- 失败不可见的原因：前端全程只有一条静态 "MinerU OCR" 文本（`packages/server/src/app.ts:361` 唯一 report 点）；`uploadJob` 是 RefDetail 组件内 state，刷新即丢；WS hello 回放被 `cur &&` 守卫挡掉（`RefDetail.tsx:117-121`）；MinerU client poll 有 log 钩子（`client.ts:242-246`）但无通道通向 job report。
- 修法三层：① 超时 1800s；② failed 可靠呈现（ref 持最新 uploadJob 修守卫 + hello 回放恢复 tracking + running 禁重复上传）；③ 进度通道（core `IngestPipelines.ingestPdf` 加可选 `onProgress` → infra MineruClient log 钩子接入 → server upload job report；attachPdf 的 ingest/rebuild 阶段补 report）。

### web 渲染侦察（MS2 事实基座）

- server 对 Document JSON **纯透传**（`app.ts:201-217` + PaperCache mtime+size LRU(16)）；加 IR 端点成本极低。
- web 独立渲染栈 ~1900 行：`richtext.tsx`（自有 token 扫描正则 + citeShort + prettifyXref）、`types.ts` 147 行 contracts 手写镜像、Block/RefCard/TocPanel/Reader/store。
- 重复：token 正则 4 处（contracts `document.ts:24-26`、`render.ts:40-41`、`tokens.ts:20-21`、`richtext.tsx:7-8`）；citeShort 3 份（`render.ts:80-87`、`richtext.tsx:127-136`、`RefCard.tsx:221-241`）fallback 各异；caption 摘要阈值 60(web) vs 80(core)；**occurrence 位置配对**（token 顺序 ↔ doc.citations 顺序）是隐性约定——IR 化时显式配对，是最大回归点，需乱序/缺失防御 + 单测。
- 图片路径分歧（真 bug）：core/CLI 输出 `/images/<docId>/assets/foo.jpg`（img_path 含子目录），server `/images/:doc_id/:filename` 单段路由 + web 取 basename（`api.ts:40-45`）。修法：server 路由吃相对路径（保留防逃逸 guard），web/CLI 用 img_path 原文。
- IR 改造面：api.ts 取 IR、store.tsx buildLookups 缩水、richtext.tsx 退役、Block/Reader/RefCard/TocPanel 消费 IR、math.tsx/FigureImage/tableparse/deeplink 复用不动。
- 回归网现成：`core/tests/render.test.ts`（6 golden，**markdown 输出须逐字节不变**）+ `packages/web/tests/deeplink.test.tsx` 11 例。

## Milestone 计划

### MS0 开工前置
- ✅ push stage2（见决策 7）
- `rm -r literature-library-skills/`（untracked，无 git 影响）

### MS1 存储统一（主线① + C1）
- `packages/cli/src/common.ts` resolveDataDir、`packages/server/src/server.ts` resolveServerConfig：默认 `./data` → `./literatures`（flag/env/config 链不动；代码注释与 CLI help 文本同步改）。
- 新增 `packages/server/src/watch.ts`：`fs.watch` 非递归监听 `<dataDir>/library/`（抓 library.json 原子 rename）与 `<dataDir>/output/`（抓 doc 目录创建/删除），~200ms 去抖 → broadcast `library.changed`；目录缺失容错（延迟重挂）；不监听 jobs/。`server.ts` 的 createServer/startServer 启停接线。
- contracts `jobs.ts`：library.changed 的 cause 联合加 `"external"`。
- 迁移 repo `data` → `literatures` + `.gitignore` 三条改前缀（随 MS1 commit，保持每 commit 自洽）。
- 测试：cli/server 的 config 测试默认断言更新；watch 单测（tmp 目录写文件断言 broadcast）。

### MS2 渲染 IR（主线②，最大件）
- contracts：`DocIr` zod schema——sections 树 + 类型化 blocks + 内联段序列（`text | math | cite{refIds,label,resolved} | xref{target,kind,label,resolved}`）+ floats/refs/bib manifests；occurrence 显式配对落进结构。
- core：新增 `documents/ir.ts`；`render.ts` 改经 IR（对外签名不变；6 golden markdown 逐字节不变为验收锚点）。
- server：`/api/paper/:id/ir`（PaperCache 同款缓存思路）；`/images/:doc_id/...` 子目录相对路径（保留防逃逸）；旧 `/api/paper/:id` 保留。
- web：api.ts 取 IR；types.ts 删除改 import contracts；richtext.tsx 退役换段渲染组件；Block/Reader/RefCard/TocPanel 消费 IR；store.tsx buildLookups 缩水；imageUrl 不取 basename；deeplink/math/FigureImage/tableparse 不动。
- web 测试：deeplink 11 例更新到 IR 供给 + 段渲染新测。

### MS3 webui 缺口 + upload bug（C2–C4 + D）
- note 全文：contracts library payload 的 Work 加 `note`；core `workToRef` 不压布尔；web 笔记 tab 只读渲染全文。
- label 色点：LibraryView 色点读 `label` 字段；已读标识：看板条目渲染 `read`（标题灰化 + 标记，样式验收时用户过目）。
- MinerU 超时：`client.ts:221` 上传、`:270` 下载 300s→1800s。
- 进度通道 + 前端 failed 呈现：见"upload bug 实锤"修法三层。
- 各项配单测。

### MS4 skills + 文档 + 验收（E 组）
- skills 三件套：删掉"每条命令显式 `--data-dir`"条款 → "在项目根目录跑，默认 `./literatures`"；开头加强硬条款（不要读仓库源码回答文献问题，一律 CLI）；query skill 空 note 检查从旁注改 numbered step。
- CLI `search`：stderr 加 `hint: N/M works have empty notes`。
- README / AGENTS.md 同步（目录契约、skills 变化、MinerU 超时）。
- `docs/manual-test-stage3.md`：含独立环境拓扑（非 repo 目录建项目 + `literatures/`，绝对路径 CLI）。
- memory：本文件进度更新 + 完成状态另落一份。

预期测试数 334 → ~370+。顺序理由：MS1 是地基（目录契约先变）；MS2 最大独立件；MS3 小项集合；MS4 收尾。

## 环境/工程事实（MS1 实施中固化）

- **lint 门是根 `corepack pnpm lint`**（= biome check .）；`pnpm -r lint` 不存在（无 per-package lint script）。AGENTS.md 已同步改。
- **pandoc PATH 坑**：golden-latex 测试要 astro env 的 pandoc 3.9.0.2，但 `/usr/bin/pandoc` 是 3.1.3；PATH 追加 astro bin 会让 3.1.3 抢先，前置 astro bin 又让 astro 的 node v20 抢先（pnpm 11 需 node ≥22.13 起不来）。解法：建 shim 目录（如 `/tmp/ms1-bin/pandoc` → astro env 的 pandoc 单独 symlink）前置 PATH，node 仍走系统 v24。
- **commit 坑**：迁移后 `literatures/output/2603.03522/` 那 31 个 tracked 样本文件命中新 `literatures/output/` ignore 规则，`git add -A` 不收；commit 时需 `git add -f literatures/output/2603.03522`（旧布局同理，既有语义）。
- MS1 端到端验证过：真实 server + WS 客户端，进程外写 library.json → 收到 `{"type":"library.changed","cause":"external"}`。

## 进度日志

- 2026-09-01：设计定稿（本文档）；stage2 push 完成；MS0 删旧 skills 目录。
- 2026-09-01：**MS1 完成**（待 commit）：默认目录 `./literatures`（cli/server + 注释 + help + 两处默认断言测试）；`watch.ts` 轮询指纹 + contracts cause 加 `"external"` + server 启停接线 + 4 个 watch 新测；repo `data`→`literatures` 迁移 + `.gitignore` 三条前缀。338 测试绿（+4）。全部改动 unstaged（含 32 个 `D data/…` rename 待 stage）。
- 2026-09-01：**MS2a 完成**（待 commit）：contracts 新增 `doc-ir.ts`（DocIr/IrSegment/IrBlock/IrSection/RefManifestRow/BibManifestRow schema）；core 新增 `ir.ts`（buildDocIr：段化用单一组合扫描器、occurrence 按 RichText 本地数组 zip、防御不 throw；citeShort/FloatBlock 迁入）；render.ts 重写为薄导出层（**6 golden markdown 逐字节不变**：render.test.ts 零改动 + HEAD 对拍差分双重验证）；server `/api/paper/:id/ir` 端点 + `/images/:doc_id/:filepath{.+}` 子路径路由（旧单段保留）。379 测试绿（+41）。注意：DocIr 未内嵌 references 原文数组（web RefCard 需要 authors 数组，MS2b 补 passthrough 字段）。commit 时按路径与 MS1 分开。
- 2026-09-01：**MS2b 完成**（待 commit）：web 全面切到 IR 供给——api.ts 打 `/ir`、types.ts（147 行镜像）与 richtext.tsx 删除、segments.tsx 段渲染器新建、store 瘦身（citationsByBlock 直接用 IR 预算）、Block/Reader/TocPanel/RightPanel/RefCard/DocPane 消费 IR；web devDep 加 core（仅测试用 buildDocIr）。399 测试绿（+20：core 155→161，web 11→25）。**行为变化**：① code/algorithm caption 现渲染段（改善）；② RefCard 作者串 = core citeShort（逐字等价）；③ DocPane 顶栏丢 "N pp"（IR 无 n_pages——**MS3 补 nPages 字段修复**）；④ TOC float tooltip 变干净；⑤ hyperlink-only xref（无 inline token）不再产生 float 卡（IR 数据边界，接受）；⑥ deeplink.ts 被迫一行适配（citationsByBlock 值类型变 string[]）；⑦ 观察：TOC float 预览遇 caption 内 cite/xref 会显示展开记号 `[cite:…]`（cosmetic，暂不修）。
- 2026-09-01：**MS3 完成**（待 commit，详录见代码与 watch/upload 测试）：contracts library payload 的 Work 加 `note` 全文 + IR 补 nPages；web 笔记 tab 全文只读、LibraryView 色点读持久化 `label`、已读标识渲染；MinerU 上传/下载超时 300s→1800s；upload 进度通道（core `ingestPdf`/`attachPdf` 加 onProgress → infra MinerU log 钩子 → server report）+ 前端 failed 可靠呈现（ref 持最新 job + hello 回放恢复 + running 禁重复上传）。424 测试绿。
- 2026-09-01：**MS4 完成**（待 commit）：search 空 note stderr hint（+2 测试）；skills 三件套契约更新（项目根跑 CLI、不传 `--data-dir`、不读源码硬条款、空 note 升 Step 2）；README/AGENTS.md/manual-test-stage2 同步；新建 `docs/manual-test-stage3.md`；RefCard 未使用参数清理（lint 回 0 warning）。**426 测试绿（+2）**。详录见 `2026-09-01-stage3-ms4-skills-docs.md`。

## 当前状态

- Stage 3 代码侧全部完成（MS1–MS4），**已 commit 三个**（本地 main 在 origin 之前 3 个，未 push）：`18d4d58` MS1、`f23e0e1` MS2+MS3、`ace4d9f` MS4。工作区干净。主代理复跑四道门确认：426 测试绿、lint 零 warning。
- **待用户**：按 `docs/manual-test-stage3.md` 手动验收；验收通过后落完成 memory；push 逐次问。
