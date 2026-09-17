# Stage 14 Grilling：ADS 文献发现（Discovery）

- Session：01a0aefe（stage14-grilling）
- 创建：2026-09-17T13:10:00+02:00
- 更新：2026-09-17T14:40:00+02:00
- 工作状态：完成（Stage 14 交付 + 摘要修复；用户 smoke 通过；随阶段关闭归并）
- 归并状态：已归并（去向见文末交接状态）
- 范围与授权：用户指令“现在推进下一个stage”，以 `/tmp/ADR-Stage14-ADS-Literature-Discovery.md`（状态 Accepted/Ready for implementation）与 `/tmp/argelander-discovery-prototype.html` 为需求描述走完整 grilling。ADR 明确：**授权 Stage 14 实施，但不含 Git commit/push 授权**；prototype 仅 UI/交互参考，语义冲突时 ADR 与本轮决策优先。实施授权在 grilling 共识全部确认后生效。

## 需求基线（用户给定，非本轮决策）

- ADR 已定（不再 grilling）：Discovery 独立域、ADS similar/useful 语义、RELATED_LIMIT=18/USEFUL_LIMIT=6、AdsDiscoverySource 端口、契约 DiscoveryGraph、HTTP `GET /api/library/discovery?bibcode=` 与状态映射、`ads-discovery/` 24h provider 缓存、无锁/无 job/无 WS、Add 复用 Stage 13 `POST /api/library/works` bibcode 路径、LibraryRef 增加可选 bibcode、旧全局推荐架构退役（buildGraph/mergeWorkIntoGraph saved-only、删 Recommendations UI 与 `POST /api/library/refs`、graph-node 不迁移）、测试策略与六阶段实施顺序、非目标清单。

## 已确认决策

### D1 — 探索导航形态与入口（Round 1 Q1，用户选 A，2026-09-17）
- Explore 是文献工作区内部临时模式，**不是独立顶级功能域**，不进 activity bar。
- 唯一正式入口：已保存文献详情页“探索相关文献”；work 无 ADS bibcode 时按钮禁用，文案明确“该文献暂无 ADS bibcode，无法使用 ADS 探索”，中英双语。
- V1 不在 Reader 阅读页加入口。
- Explore 内保留“返回文献库”、面包屑、探索历史前进/后退。
- 文献工具栏保留“继续上次探索”，仅在当前前端生命周期内确有 exploration session/history 时出现；刷新后可消失，不持久化。

### D2 — URL 深链接与刷新（Q2，用户选 A）
- 轻量 hash：`#explore/<url-encoded-bibcode>`；进入 Explore 与 “Explore from here” 时更新。
- F5/直接打开该 hash：只恢复/重新查询当前 seed；history stack、选中 candidate、pan/zoom、filter 只在内存，刷新允许丢失。
- hash 中 bibcode 无效或 ADS 查询失败：显示 Explore 正常错误态，可“返回文献库”，shell 不进坏状态。
- 不引入完整 router；无现成设施时用 `history.pushState/replaceState + hashchange/popstate` 轻量实现；浏览器 Back/Forward 与 Explore 自有历史按钮尽量一致，行为正确优先，不建复杂 URL 状态机。

### D3 — 候选详情去掉 BibTeX tab（Q3，用户选 A）
- V1 候选详情只要：摘要、书目元数据、ADS bibcode/DOI/arXiv、citation count、Related/Useful 身份与 rank、本图引用关系（保留 prototype“本图引用”tab）。
- 不由 Discovery 元数据前端拼 BibTeX，不为此增加 ADS export 请求。
- 权威 BibTeX 路径保持：Add to Library → 现有 bibcode import → ADS export → Library；已入库论文的 Library detail BibTeX 能力不受影响。

### D4 — 共享图渲染器、不共享 domain 语义（Q4，用户选 B 收紧）
- Library Graph 与 Discovery Graph 用同一套增强 renderer：方向箭头、label 避让、缩放控件、tooltip、图例、pan/zoom/节点交互、selected/hover 态。Library 边本全是真实引用，箭头与 A→B 图例成立。
- 结构边界：共享 `Graph renderer/canvas`，下挂 `LibraryGraph adapter` 与 `DiscoveryGraph adapter`；**禁止**塞成一个充满 `if (discovery)` 的大组件。共享 SVG/渲染/pan/zoom/tooltip 设施/label 放置/箭头/选择行为；node 形状/角色/样式、详情面板、工具栏/filter、数据 contract 各域自定。
- Useful 菱形只属于 Discovery，不给 Library 人造 Useful 概念。
- 本轮允许同步升级 Library Graph 上述基础视觉能力，但不顺带改变 Library layout/ranking/其他产品语义。

### D5 — 加载态诚实 + 真取消（Q5，用户选 A）
- 去掉 prototype 假阶段进度；不确定加载态：spinner + “正在查询 ADS…/正在查找相关文献和常用参考文献” + 取消。可说明在做 similar+useful，但不得显示某步已完成（除非 API 真暴露进度）。
- 取消真正 Abort 当前 discovery 请求，尽量沿 ADR §8.2 的 AbortSignal 传到 ADS fetch；取消后不显示 error toast，回到可重新探索的稳定态；已有上一张 discovery graph 时保留上一张，不清空再加载。

### D6 — 删除 exportBibtex 假占位，不建导出端点（Q6，用户选 B）
- 删除/隐藏文献工具栏无行为 exportBibtex 占位按钮；**不在** Stage 14 新增 BibTeX 下载 endpoint，不顺带设计下载命名/空库行为/content-disposition。
- 理由（用户）：与 Discovery 无领域关系，本阶段验收面已大；未来 Web 独立导出另立小项（磁盘 library.bib 是基础）。
- 覆盖：Stage 13 遗留待确认 Q1（exportBibtex 占位）→ 本轮决定删除占位，导出功能仍推后。

## 已验证事实

### F1 — 仓库勘察（2026-09-17，scout 只读报告，原文 /tmp/stage14-recon-report.md 为临时证据）
- **CLI 冻结面安全**：`list` stdout 是纯文本行（直读 DocIR，不经 LibraryRef/workToRef），`search` 直读 Work 显式字段表（无 bibcode）。给 LibraryRef/workToRef 加可选 bibcode **不影响 CLI 输出**。证据：cli/src/agent.ts:512-535（list）、:319-337（search 字段表）、contracts/src/library.ts:29-69（LibraryRefSchema 现无 bibcode）、core/src/library/graph.ts:244-284（workToRef）。
- **graph.json 生命周期**：`GraphDataSchema` 无版本字段；suggested 节点 = 无 `ref` 字段（无布尔标记）。server 启动**不重建**图谱，GET /api/library 每次从磁盘读存量；仅 `POST /api/library/refresh`/CLI rebuild 重建。存量 graph.json 含 suggested 节点，退役代码上线后需收敛策略。证据：contracts/src/library.ts:76-101、core/src/library/store.ts:51-58、server/src/server.ts:59-77、app.ts:494、997-1021。
- **退役面定位**：`OpenAlexSource.fetchMany` 生产调用点仅 graph.ts:195（buildGraph 候选池）与 :344（mergeWorkIntoGraph 补邻居），退役后可删；`POST /api/library/refs` 处理器 app.ts:875-899，core `addNodeToLibrary` build.ts:151-183，web `GraphNodeDetail` RefDetail.tsx:626-706 + `addRef()` api/library.ts:37-43。推荐开关假定时器确认属实（LibraryView.tsx:183-198 setTimeout 1100ms）。
- **路由现状**：无 router 库；唯一手写路由是 pathname 型 `/doc/<docId>`（deeplink.ts:19-30）+ history.replaceState + Shell 的 popstate/hashchange 监听（Shell.tsx:145-158）；server SPA fallback 已覆盖非 API 路径（app.ts:1244-1273）。视图切换是纯 React state（Shell panes，最多 3 个 pane）。
- **图组件现状**：CitationGraph 的 `cgTick`/`cgComputeLayout` 为模块私有不导出；边无方向箭头；有缩放控件/图例/条件标签；无 tooltip 组件。suggested 空心节点 + hop BFS + 数量滑块（maxCount 18）+ 深度滑块都在 CitationGraph.tsx 内。
- **RefDetail 现状**：tabs meta/info/bib/notes/files；头部动作 openInDoc（真）、**star（也是无 onClick 占位，属 I024 范围）**、close；无页脚动作区。
- **infra**：现有 `AdsClient`（Solr search/query，FL 含 abstract/reference，rows:1，0.25s sleep，fetchImpl 注入）与 Stage 12 `exportBibtex`（批量 POST，**不走磁盘缓存**）。`SourceCache` **无 TTL**（ads-discovery 24h TTL 需自建，不改旧缓存语义）。全仓库无通用 Solr 查询构造/转义 helper。缓存目录 `<dataDir>/library/cache/{ads,crossref,openalex}`。
- **server 模式**：guardCsrf 手动逐 mutation 调用（GET 无）；GET /api/library 无显式 Cache-Control；POST /api/library/works（app.ts:927-958）与 server/tests/works-create.test.ts 是新端点参照。
- **web 杂项**：LibraryView 后端不可达时有 fixture 回退（api/library.ts:30-33 + library/fixture.ts）+ demo 徽标；i18n 受 no-hardcoded-copy（src 任何 CJK 字符即失败，含注释）与 locale-parity 测试强制；web vitest 依赖 contracts/core 已构建 dist。

### D7 — graph.json 版本化 + 锁内自愈（Round 2 Q7，用户选 A 加并发约束，2026-09-17）
- GraphData contract 加 `version`（新图缓存直接从当前版本号起，如 `2`；新代码只接受当前版本，不纠结历史语义）。
- 读取语义：`GET /api/library` 加载 graph.json → 版本匹配直接用；**missing / 无 version / schema invalid / version mismatch 统按派生缓存 stale 处理** → 进 `libraryLock` → 锁内 double-check 版本（等锁期间可能已被修好）→ 仍 stale 则从**锁内重新 load 的最新 LibraryStore** 重建 saved-only 图并原子写盘 → 返回新图。
- 目的：防“GET 基于旧 library 算图写回、覆盖刚完成的 mutation”竞态。自愈是派生缓存修复，**不广播 `library.changed`**；`library.json` 解析失败不得吞成空库，仍显式失败。
- 退役后 buildGraph 纯本地 saved-only，惰性重建**不得触发任何 OpenAlex/ADS 网络调用**。

### D8 — 失败/空态 UI 与 session 完整性（Q8，用户按提案四态确认 + 补充）
- useful 失败：Related 完整保留；Useful 区内联 unavailable 提示；不发 error toast；重试 = 重发同 seed 完整 Discovery 请求（不新增“只重试 useful”API）。
- similar=0：按空态（非错误）：保留 seed card/面包屑/返回/retry，中区“没有找到相关文献”，不渲染只有 seed 的孤立图。
- ADS fatal（503/429/502/404）同一错误态骨架，前端按 status 本地化主文案（503 不可用或未配置 / 429 频率受限请稍后重试 / 502 无法完成查询 / 404 未找到该 bibcode）；server `detail` 仅作诊断不翻译；429 有 Retry-After 时 server 合理转发响应头，前端提示稍后重试，V1 不做倒计时。
- **新探索失败保留旧图**：`Explore from here` 新请求失败时停留在原成功 session 并显示失败信息；成功才压入 history/切换 session——**失败 session 不进 Back/Forward stack**。

### D9 — Discovery 无 fixture/demo 回退（Q9，用户选 A）
- 伪造“ADS 认为相关/useful”有学术语义风险：demo/无后端模式下不显示假 Related/Useful、不切 prototype fixture；Explore 按钮禁用 + 简短说明（“文献探索需要连接 ArgelanderSpace 后端和 ADS”）。后端在但 ADS 失败走 D8 错误态。prototype 的 fixture 仅为设计验证数据，生产代码不得复制为 fallback dataset。

### D10 — CLI 冻结面完全不动（Q10，用户选 A）
- Web 侧 `LibraryRef` 可加 optional `bibcode`；CLI `search`/`list` 等冻结面**不变**：不增字段、不动 golden、不以 additive 为由扩大。
- 未来若需 agent 发起探索，单独设计 sanctioned interface（明确的 discovery CLI command/skill），不先把 bibcode 塞进旧 search 输出铺路。

### D11 — 最终补充①：Discovery 无副作用边界的澄清（2026-09-17 用户最终审核补充 1）
- “Discovery 不写 graph.json、无锁”专指 Discovery domain / `GET /api/library/discovery`：不拿 libraryLock、不写 library.json、不写 graph.json、不进 JobRunner、不发 mutation WS。
- D7 的 graph cache 版本化自愈属**既有 Library 派生缓存维护**（可在 libraryLock 下重建 graph.json），不是 Discovery 产生副作用。两者不得混淆。

### D12 — 最终补充②：退役删除遵循 dead-code verification（补充 2）
- 目标是移除旧 suggested-node 产品路径（global Recommendations / depth/count / ref-less suggested nodes / graph-node Add / `POST /api/library/refs` / addNodeToLibrary）；具体 symbol（GraphNodeDetail、fetchMany 等）先查全仓调用点：无剩余 caller 才删，仍承担非旧推荐职责则保留/重构。不把“删文件名”当产品要求。

### D13 — 最终补充③：self-heal 失败必须显式失败（补充 3）
- rebuild/rewrite 本身失败 → `GET /api/library` 500；**不得**返回旧 suggested graph、不得把损坏 graph 当空图、不得吞 filesystem error；library.json 损坏是 source-of-truth failure 绝不当 cache miss。
- `GraphData.version` 具体整数非产品语义：定义唯一 `CURRENT_GRAPH_VERSION` 常量，测试“无 version/不同 version → stale”即可。

### D14 — 最终补充④：只有成功的 seed transition 进入导航历史（补充 4）
- `Explore from here → B`：B 成功才写入 URL/session history；失败/取消 → URL/current/history 仍是 A，失败与取消都不制造 history entry。
- 浏览器 Back/Forward 与 Explore 顶部前后箭头指向同一条 seed navigation history；pan/zoom/selection/filter 不编进 URL。
- 恢复规则：内存有 snapshot → 完整恢复；F5/直接打开 hash 无 snapshot → 按 hash bibcode 重新请求当前 seed，selection/pan/zoom/filter 允许回默认。
- 多 pane：`#explore/<bibcode>` 表示当前 URL 指向的活跃探索；有合适 Library pane 在该 pane 恢复，无则切 active pane 为 Library 并进入该 seed 的 Explore；URL 不编码 pane id。

### D15 — 共识确认与实施授权（2026-09-17 用户最终审核）
- 共识 A–D 全部确认；实施授权生效，按 ADR §19 六阶段实施、可改代码/测试/阶段方案并执行验收；**无 commit/push 授权**；不顺带处理 Stage 14 之外开放问题。
- 阶段方案持久化到 `.pi/memory-reference/stage14-discovery-plan.md`（标“已批准/执行中”）：**不直接复制 ADR**，写入 grilling 共识 + ADR 语义凝缩 + D1–D14，使实施不再依赖 /tmp 与聊天记录；prototype 不进 repo/.pi；README 只做最小能力描述同步。

## 待确认事项

- Round 2 待仓库勘察报告（/tmp/stage14-recon-report.md，scout 运行中）：CLI `list` 冻结面与 LibraryRef.bibcode、存量 graph.json 收敛策略、部分失败/空态 UI 形态等。
- 验收协议与 commit/push 边界将在共识汇总确认（预期沿用：四门 + 离线回归 + 真实 Chrome 探针（mock discovery）+ 一次真实 ADS smoke + 用户 smoke；ADR 已明确无 commit/push 授权）。

### F2 — Phase 1–3 实施完成（2026-09-17）
- Phase 1：contracts `discovery.ts`（DiscoveryRole/Paper/Edge/Warning/Graph + version 1/provider ads literal）、LibraryRefSchema 加可选 `bibcode`；core `library/discovery.ts`（AdsDiscoverySource 端口、RELATED_LIMIT=18/USEFUL_LIMIT=6、libraryMembership/matchLibraryId、mergeDiscoveryNodes、discoveryEdges、discoverLiterature：seed null 返回、useful 失败降级 warning、abort 传播、不 mutate store）；workToRef 暴露 bibcode。测试 contracts 112（+11）/core 328（+18）全绿。
- Phase 2：infra `sources/ads-discovery.ts`——AdsDiscoveryClient（seed/similar/useful 查询、quoteBibcode 转义、FL 含 reference+identifier、normalizeDiscoveryDoc 保留完整作者显示、identifier 抽 arXiv、畸形跳过、seed 畸形=invalid-response）、AdsDiscoveryError（kind: no-token/unauthorized/rate-limited/upstream/invalid-response + retryAfter）、独立 `ads-discovery/` TTL 24h 缓存（键含 q/fl/rows/sort；错误与 abort 不写缓存；缓存命中可无 token 服务）。测试 infra 91（+21）全绿。
- Phase 3：`GET /api/library/discovery?bibcode=`（app.ts）——Cache-Control no-store、bibcode 校验（≤64、无空白/引号/控制字符）、400/404/503/429(Retry-After 转发)/502 映射、AbortSignal 透传 c.req.raw.signal、无锁无 job 无 WS 无副作用（测试断言 library.json/graph.json 字节不变、零广播）；AppDeps 加可选 `makeDiscoverySource`（server.ts 接 realDiscoverySource → ads-discovery 缓存命名空间）。测试 server 238+1 skip（+10）全绿。
- 实施顺序调整：Phase 5（退役+graph 版本自愈）提到 Phase 4（前端）之前做——Library adapter 将只面对 saved-only v2 payload，不需兼容 ref-less 节点过渡态。

### F3 — Phase 5 后端完成（退役 + graph 版本自愈，2026-09-17）
- contracts：`GraphDataSchema` 加 `version: z.literal(CURRENT_GRAPH_VERSION)`（常量=2，唯一定义在 contracts）；删 `AddRefRequestSchema`/`AddRefResponseSchema`（无调用者）。
- core：`buildGraph(store, outputDir)` saved-only 纯本地（删候选池/fetchMany/MAX_SUGGEST/suggestedNode/connected 过滤，返回带 version）；`mergeWorkIntoGraph(graph, store, w)` saved-only 同步化（删 oa 参数与补邻居）；删 `addNodeToLibrary`（生产调用点仅 server 一处，D12）；`OpenAlexSource` 端口删 `fetchMany`；build.ts 新增 `loadCurrentGraph`（schema+version 双检，stale→null）与 `healGraph`（锁内重读最新 store→纯本地重建→tmp+rename 原子写；失败显式抛）；`libraryPayload(paths, graph)` 改为注入 graph。
- infra：`OpenAlexClient.fetchMany` 实现删除；config 测试改走 resolve 验证 api key 链。
- server：删 `POST /api/library/refs` 路由；GET /api/library 变 async——锁外 `loadCurrentGraph`，stale 则 `libraryLock.run(锁内 double-check → healGraph)`，heal 失败 500；不广播 library.changed。
- 测试更新：add-manual（3 处改 saved-only 断言）、library.test/api.test/doc-delete/helpers 同步；doc-delete 的 busy-409 gate 从 fetchMany 改到 ads.resolve（rebuild 必经 resolveWork）。
- 四门全绿：build 7 包、test 1144 passed+1 skip、typecheck 7 包、lint 0 error（6 既有 warning）。
- Phase 5 的 web 侧删除（GraphNodeDetail/addRef/Recommendations toggle/滑块/exportBibtex 假按钮/fixture saved-only 化）随 Phase 4 前端一并落地。

### F4 — Phase 4 前端完成（2026-09-17）
- 新文件：`graph/graphPhysics.ts`（prototype 常量的 seeded 确定性布局 + label 避让 + seed 钉住）、`graph/GraphCanvas.tsx`（共享 renderer：方向箭头/标签避让/tooltip/图例/缩放/拖拽/pinch/键盘 Enter 选择；stash 按 session 持久布局与视口）、`library/LibraryGraph.tsx` 与 `library/DiscoveryGraphView.tsx` 两 adapter（D4 边界）；`library/explore-state.ts`（useExploreStack：成功才入栈/写 hash、失败保留旧 session、取消静默、addToLibrary 就地更新 libraryId）；`library/ExploreMode.tsx`（header/seed 卡/三 tab/列表视图/加载覆盖层/四态）；`library/DiscoveryDetail.tsx`（无 BibTeX tab，摘要+书目+本图引用）；`api/discovery.ts`（schema 校验，畸形→502 态，无 fixture 回退）；`lib/explore-route.ts`（#explore hash 解析/pushState/bus）。
- 改动：LibraryView 模式切换 + 删 Recommendations toggle/假定时器/exportBibtex 假按钮/GraphNodeDetail/addRef/nodeToRef；RefDetail 加探索页脚（无 bibcode/演示模式双语禁用理由）+ 滚动区结构；Shell boot/popstate/hashchange 接 explore bus（无 library pane 时切 pane）；fixture.ts saved-only 化；locale 双语新增 graph.*/explore.* 域、删推荐时代死键；argelander.css 追加探索样式，.ref-detail 改 flex+滚动区。
- 顺带防御：GraphCanvas setPointerCapture try/catch（合成/旧指针流不炸）。

### F5 — Phase 6 机器侧验收（2026-09-17）
- 四门：build 7 包、test **1166 passed + 1 skip**（contracts 112/core 328/infra 90/web 354/server 231+1/cli 51）、typecheck 7 包、lint 0 error（6 既有 warning）。
- 真实 Chrome/CDP 探针 `/tmp/stage14-probe.mjs`（临时证据；真 server + composition seam 注入确定性 ADS stub，无网络）**42/42**：库图 saved-only/箭头/图例/无推荐 UI；入口启用/禁用文案；探索图 seed 环/菱形/填充态/hash；候选详情（摘要/来源行/无 BibTeX tab/本图引用）；Add 入库（POST works bibcode）后视口不变/就地填充/持久化/graph.json 自愈 v2；explore-from-here + 历史 2/2 + 往返 hash；filter/列表视图；F5 恢复；seed-only 空态；useful 部分失败内联提示；404 横幅保留旧图 vs 全新页面 fatal 态；取消回库；工具栏“继续上次探索”。
- 真实 ADS smoke `/tmp/stage14-live-ads-smoke.mjs`（临时证据；真 token/真网络，临时 dataDir）**17/17**：seed 解析、related 18、useful 6、129 条真实引用边、23/23 摘要、no-store、缓存二次命中 7ms、Add created→重复 exists、overlay libraryId 生效、404/400 语义。
- README 最小同步（web UI 能力清单加 ADS 发现一句）。
- 改动面：33 文件改动 + 13 新文件（`git status` 未提交）；**未 commit/push**（无授权）。

### F6 — 摘要渲染修复（2026-09-17，用户 smoke 反馈顺手修）
- 问题：库页 RefDetail 摘要与探索 DiscoveryDetail 摘要把 ADS 摘要里的 HTML 标签当纯文本显示、LaTeX 数学完全不渲染。
- 修复：新 `web/src/lib/abstract.tsx` 的 `abstractHtml`/`AbstractHtml`——DOMParser 解析（实体自然解码）→ 剔除活性内容元素（script/style/iframe/…）→ 非白名单元素拆壳保文字、白名单（SUB/SUP/I/B/EM/STRONG/BR/P）剥全部属性 → 文本节点内按 mdWithMath 同款 texmath 边界规则渲染 KaTeX（货币 `$100 to $200` 不误伤、跨标签不配对）。注入沿用 mdWithMath 的 dangerouslySetInnerHTML 单用户惯例。
- 接入：RefDetail info tab 与 DiscoveryDetail 摘要两处。测试 web/tests/abstract-render.test.ts 7 条；浏览器探针新增 1 项端到端断言（无字面 `<SUB>`、KaTeX 存在、`<i>` 保留）→ 探针 43/43。
- 四门：build 7、test **1173 passed + 1 skip**（web 361）、typecheck 7、lint 0 error。
- 用户 smoke：Stage 14 搜索/添加/以此继续探索均正常，摘要问题已修待复验。

## 交接状态

- Stage 14 正式关闭（用户 2026-09-17 确认 smoke 通过）；commit+push 用户已明确授权（本次一次性，不继承）。
- 下一阶段 Stage 15（用户 2026-09-17 拍板原话）：“添加自动在有arxiv时在添加文献时即导入arxiv内容”——下个 session 立项，范围届时 grilling。
- 探针/调试脚本在 /tmp（stage14-probe.mjs、stage14-live-ads-smoke.mjs），临时证据；关键结论已自包含于 F2–F6。
- 归并去向：D1–D15 与四补充 → 契约§2“文献发现” + 阶段方案（memory-reference/stage14-discovery-plan.md，已关闭）；F1 → 工程/架构；F2–F5 → 历史 Stage 14 行 + 工程探针教训 + 架构能力/存储/缓存条目；F6 → 架构摘要渲染 + 工程“摘要显示”；Stage 15 方向 → 索引/契约§1/历史/AGENTS.md；exportBibtex 占位的 Stage 13 遗留 Q1 → 契约§2（已删按钮，了结）。
