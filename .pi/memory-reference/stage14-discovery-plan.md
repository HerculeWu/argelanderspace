# Stage 14 阶段方案：ADS 文献发现（Discovery）

- 状态：**已关闭**（2026-09-17 用户 smoke 通过，含摘要渲染修复；验收证据见 [history](../../memory/history.md) 与归并前 session 原文）
- 来源：用户 ADR 草稿 `/tmp/ADR-Stage14-ADS-Literature-Discovery.md`（2026-09-17，状态 Accepted）+ 同 session grilling 两轮（Q1–Q10）与最终四点补充（D1–D15，见 `.pi/inbox/2026-09-17-01a0aefe-stage14-grilling.md`）
- UI 参考：`/tmp/argelander-discovery-prototype.html`（仅视觉/交互参考，**不复制入 repo/.pi**；语义冲突时本方案优先）
- 授权边界：实施、改代码/测试/本方案、执行验收均已授权；**无 commit/push 授权**；不顺带处理 Stage 14 之外开放问题（I024 star 占位等不碰）
- 本文为自包含工作权威：实施不再依赖 /tmp ADR 原件或聊天记录。

## 1. 目标与问题

现有“推荐”是全库候选池（所有已存 work 的引用并集）按全局被引数排序 + 深度/数量控制：高被引通用文献漂移、全局被引数度量的是影响力而非与当前论文的主题相关性。

Stage 14 用天文原生方案替代：从**一篇选中的论文**出发，发现智能委托 NASA ADS——`similar()` 给主题相关，`useful()` 给该相关集合反复引用的方法/数据/基础文献；图只画**真实引用关系**；结果是临时的，只有用户显式动作才进持久 Library。

## 2. 硬产品不变量

1. **Library Graph ≠ Discovery Graph**：前者 = 已存 works + 真实引用边；后者 = 一个 ADS seed + 临时 related/useful 候选 + 真实引用边。
2. **无深度控制**：无 BFS 深度、无自动多跳；继续探索 = 用户显式 “Explore from here”。
3. **ADS 决定出现哪些论文**：related 来自 `similar()`，useful 来自对实际 related 集合的 `useful()`；V1 不自研排序分。
4. **每条边只有一个含义：引用**。`A → B` = A 引用 B；similar/useful 是节点角色不是边类型；V1 不引入相似边/共引边/推荐边。
5. **Discovery 是只读派生态**：Discovery 请求不写 library.json、不写 graph.json、不隐式导入、不拥有用户数据。（边界澄清见 §11 D11。）
6. **入库只走 Stage 13 bibcode 路径**：`POST /api/library/works {mode:"bibcode", bibcode}`；无第二 mutation 路径。
7. **无服务端 session**：探索历史/选择/pan/zoom/filter/前进后退全为前端状态；刷新允许丢失。
8. **V1 仅 ADS**：无 OpenAlex/Semantic Scholar 发现回退；OpenAlex 仍是 Library 元数据解析链一部分；ADS 缺失/不可用显式报错，不悄悄回退旧推荐模型。

## 3. 架构边界

沿用现有包边界：contracts（wire/domain）/ core（领域逻辑、纯组装）/ infra（外部 provider 与 HTTP/缓存适配）/ server（HTTP 编排、状态映射、依赖组装）/ web（UI 与临时探索状态）。

```
web → GET /api/library/discovery?bibcode=<bibcode>
    → server → core discoverLiterature(...) → AdsDiscoverySource port → infra ADS discovery client → NASA ADS
```

依赖规则：core 不知 ADS URL/Solr 转义/token 存储/缓存路径/HTTP 状态/响应 JSON 形状；infra 不知 Library UI、不改 Library 状态；server 不实现排序或图组装；web 不从 provider 原始数据重建引用边。

## 4. Discovery source port（core）

**不**扩展现有元数据解析链 `AdsSource` 接口（接口隔离），Discovery 用独立 core 端口：

```ts
export interface AdsDiscoveryRecord {
  bibcode: string; title: string;
  authors: string[];            // 保留可显示信息，不退化为只姓
  year: number | null; venue: string | null; abstract: string | null;
  citation_count: number | null; doi: string | null; arxiv_id: string | null;
  references: string[];         // 该 work 引用的 ADS bibcodes
}
export interface AdsDiscoverySource {
  getByBibcode(bibcode: string, signal?: AbortSignal): Promise<AdsDiscoveryRecord | null>;
  similar(bibcode: string, limit: number, signal?: AbortSignal): Promise<AdsDiscoveryRecord[]>;
  useful(bibcodes: readonly string[], limit: number, signal?: AbortSignal): Promise<AdsDiscoveryRecord[]>;
}
```

infra 实现为新 `AdsDiscoveryClient`，可复用 `readAdsToken`/native fetch/`HttpError`/`withQuery`/`SourceCache` 等共享原语；**不得**为迁就 discovery 改动现有 `AdsClient` 既有缓存语义。

## 5. ADS 查询语义

- 固定常量（服务端常量，V1 不暴露用户参数）：`RELATED_LIMIT = 18`、`USEFUL_LIMIT = 6`；无 `?related=`/`?useful=`/depth/beam 等调参。
- 查询序列：seed 精确查询 → `similar(seed)` top 18 → 用**实际返回**的 related bibcodes 构造一阶 OR 查询 → `useful(related-set)` top 6 → 归并去重 → 覆盖 Library 成员 → 推导可见引用边。
- `useful()` **不**直接作用于 seed；**不**在 useful 内嵌套第二个 similar() 并行（保证 useful 基于用户所见的精确 related 集、避免重复相似度计算、易测；图小，串行延迟可接受，未测出延迟问题前不优化成并行重复请求）。
- 查询安全：bibcode 视为标识符而非任意查询串——长度上限（如 64）、拒空/控制字符、嵌入查询前转义/加引号、useful 输入集由逐条转义的 bibcode 显式 OR 构造、绝不把用户原始字符串拼成无限制 ADS 检索式。
- 请求字段至少：`bibcode,title,author,year,pub,abstract,citation_count,doi,identifier,reference`（`identifier` 用于可选 arXiv 抽取；`reference` 为边所必需）。
- 无可用 bibcode 的个别 related/useful 结果可跳过；seed 结果畸形 = provider 失败（seed 身份必需）。

## 6. 契约（contracts）

不复用 `GraphNodeSchema`（其语义属 Library 引用图且字段不足）。新 wire contract：

```ts
DiscoveryRole = "seed" | "related" | "useful";
DiscoveryPaper {
  bibcode: string; title: string; authors: string[];
  year: int|null; venue: string|null; abstract: string|null;
  citationCount: int|null; doi: string|null; arxivId: string|null;
  roles: DiscoveryRole[]; relatedRank?: int>0; usefulRank?: int>0;
  libraryId: string|null;      // 已入库则为持久 Library work id；inLibrary 不重复存，libraryId!==null 即真
}
DiscoveryEdge { from: string; to: string; kind: "citation" }   // from=citing, to=cited
DiscoveryWarning { code: "useful_unavailable" }
DiscoveryGraph { version: 1; provider: "ads"; seed: string;
                 nodes: DiscoveryPaper[]; edges: DiscoveryEdge[]; warnings: DiscoveryWarning[] }
```

HTTP 响应**不暴露** raw `references`（仅服务端推导边用，前端不需要）。

### 6.1 节点归并

- 身份 = ADS bibcode；seed 一个节点；related 按 ADS 返回序 rank 1..N；useful 同 1..M。
- 同现 related+useful → 单节点双角色双 rank；useful 返回 seed → seed 保持 `roles:["seed"]`。
- 输出顺序确定：① seed；② related 按 relatedRank；③ useful-only 按 usefulRank。

### 6.2 引用边推导

可见 bibcode 集 V；对每个可见 A 的 `references` 中 B：B∈V 且 B≠A → 发射 `A → B`；去重；确定性排序。**角色不产生边**；孤立节点合法且必须保留可见，不为连通性造边。

## 7. Library membership overlay

每请求加载 Library 快照只为判定候选是否已存。保守匹配序：① 精确已存 ADS bibcode；② 双方均有 DOI 时规范化 DOI 匹配。**V1 不用模糊标题匹配**（假阴可忍——后续权威 add 路径会返回 exists；假阳会错误阻止收藏 distinct 论文）。持久身份/去重权威仍是 `LibraryStore.upsert()` 及其既有身份规则（doi ▸ arxiv ▸ openalex ▸ title，bibcode 非身份键——勘察 D16）。

## 8. HTTP API

`GET /api/library/discovery?bibcode=<bibcode>`（安全幂等读，保持 GET）；成功响应 `DiscoveryGraph`；`Cache-Control: no-store`（响应含即时 Library 成员态；ADS provider 响应内部另缓存）。

### 8.1 失败语义（`{"detail": string}` 体例不变，status 是稳定机器信号）

| 情形 | status | 行为 |
|---|---:|---|
| bibcode 缺失/非法 | 400 | ADS 调用前拒绝 |
| seed 未找到 | 404 | 无发现图 |
| token 缺失/被拒 | 503 | 显式 ADS 不可用，无回退 |
| ADS 限流 | 429 | 有 Retry-After 时转发响应头 |
| ADS 超时/网络/5xx/顶层响应非法 | 502 | 显式上游失败 |
| similar 查询失败 | 502 | similar 是核心能力 |
| similar 返回 0 | 200 | seed-only 图，不发 useful 请求 |
| useful 失败（similar 已成功） | 200 | related 图 + `useful_unavailable` warning |
| 个别论文无摘要 | 200 | `abstract:null` |

网络/鉴权/限流失败不得缓存为成功数据。

### 8.2 取消

尽量把入请求 `AbortSignal` 经 core 传到 ADS 适配器（similar 可能较贵；用户立刻探索他文或离开时应可中止上游工作）；**aborted 请求不得写缓存**。

## 9. Discovery 缓存

不复用/不改变 `<cacheDir>/ads` 元数据缓存（其键行为是既有兼容契约）。独立命名空间 `<dataDir>/library/cache/ads-discovery/`（勘察：现有 SourceCache 无 TTL，本命名空间自建 TTL，不动旧语义）。

- 缓存 **provider 检索响应**（非组装好的 DiscoveryGraph）；条目 `{fetchedAt, data}`；TTL **24h**。
- 缓存键包含所有影响 provider 响应的输入：查询文本、请求字段、rows/limit、显式 sort。
- 只缓存 provider 数据的理由：ADS 结果远程且贵；Library 成员是本地用户态、Add 后立刻变；重组装 ~25 节点图便宜；故无需 DiscoveryGraph 缓存失效机制。
- V1 无 stale-while-revalidate/缓存数据库/后台刷新/持久发现 session。

## 10. 并发与锁

Discovery 是读路径（D11 边界澄清）：**不拿 `libraryLock`、不进 `JobRunner`、不广播 `library.changed`、不新建 WS discovery 事件、不 pin 文档 mutation**。`LibraryStore.load()` 仅作成员快照；library 保存本就以 tmp+rename 原子替换，同进程无锁读者观察到旧或新的完整版本均可接受。不与 upload/refresh 长 mutation 串行化。

D7 的 graph cache 版本化自愈属**既有 Library 派生缓存维护**（§16），不是 Discovery 副作用。

## 11. Add to Library

候选持久化**只**经现有 `POST /api/library/works {mode:"bibcode", bibcode}`。V1 不用 Discovery 响应里已有元数据优化保存——bibcode 路径是 ADS export/解析/归并/去重/upsert/cite key/acquisition planning/持久化/广播的唯一权威实现；一个业务 mutation 一个权威实现。

前端成功后：该节点就地更新 `libraryId = ref.id`，按已收藏渲染；**不退出探索、不换 seed、不因保存重算/重排图**；正常 Library 重载/广播在别处更新持久 Library。后端返回 `exists` 视为成功并取既有 ref.id。

## 12. LibraryRef 增量

`LibraryRef` 加 `bibcode: z.string().optional()`；`workToRef()` 有 `w.bibcode` 时暴露。“探索相关文献”仅在有可用 ADS bibcode 时可用（D1：无则禁用+双语说明“该文献暂无 ADS bibcode，无法使用 ADS 探索”）。V1 不引入“专为发现而按需把 work 解析到 ADS”的 mutation。Discovery 候选 “Explore from here” 恒用其 ADS bibcode。

勘察确认：CLI `list`/`search` 不经 LibraryRef，本增量**不触碰 CLI 冻结面**（D10）。

## 13. 旧推荐架构退役

整合新 Discovery 后，旧全局 suggested 机制不再是受支持产品路径（删除遵循 D12 dead-code verification）。

### 13.1 buildGraph → saved-only

只发射：已存 work 节点、已存→已存引用边（已存 OpenAlex `referenced_works`）、已存→已存离线 bib 边。不再：并集全局候选池、为推荐取候选元数据、按 `cited_by_count` 排序、`MAX_SUGGEST` 截断、发射空心 suggested 节点。退役后 buildGraph 为纯本地组装（富化后无网络）。

### 13.2 mergeWorkIntoGraph → saved-only

手动建条目增量：插入/更新新 saved 节点 + 当前可算的 saved↔saved 入/出边；**不再**为 suggested 邻居发 OpenAlex 批量请求。仍是尽力而为、不使建条目失败。

### 13.3 移除作废 web/API 面（无调用者后）

- 全局 Recommendations toggle、`showSug` state、数量滑块、深度滑块/hop BFS、suggested 节点选择逻辑、graph-node Add-to-Library 流程、`POST /api/library/refs`、`addNodeToLibrary()`。
- `GraphNodeDetail`、`OpenAlexSource.fetchMany()` 等 symbol：迁移后先查全仓调用点（D12）——无剩余 caller 才删（含 client 实现与测试）；仍承担非旧推荐职责则保留/重构。
- **不迁移**历史 `Work.origin === "graph-node"`；已持久化 works 保持普通已存 work。

## 14. 前端交互契约（D1–D5、D8、D9、D14）

实施前必须查看 prototype（/tmp）。以下行为与组件结构无关地必须成立：

**导航与入口（D1）**：Explore 是文献工作区内临时模式，不进 activity bar；唯一入口 = 已存文献详情“探索相关文献”（RefDetail 内以 prototype 式主按钮呈现，将加页脚动作区）；无 bibcode 禁用+双语说明；V1 无 Reader 入口；Explore 内保留返回文献库/面包屑/历史前进后退；文献工具栏“继续上次探索”仅在当前前端生命周期内确有 session/history 时出现，刷新可消失。

**URL 与历史（D2 + D14）**：`#explore/<url-encoded-bibcode>` 轻量 hash（pushState/replaceState + hashchange/popstate，不引 router）；进入与 “Explore from here” 更新 hash；**只有成功的 seed transition 进入导航历史**——失败/取消不制造 history entry，失败时 URL/current/history 停留在原 session（D8）；浏览器 Back/Forward 与 Explore 箭头指向同一条 seed 历史；内存有 snapshot 完整恢复，F5/直接打开按 hash 重查当前 seed（selection/pan/zoom/filter 回默认允许）；多 pane 不建复杂状态机：hash = 活跃探索，有合适 Library pane 在该 pane 恢复，无则切 active pane 为 Library 进入探索，URL 不编码 pane id；无效 hash/ADS 失败 → 正常错误态 + 可返回文献库，shell 不进坏状态。

**候选详情（D3）**：无 BibTeX tab（不前端拼造、不为此加 ADS export 请求）；至少有标题/作者/年份/venue/摘要(可空)/引用数(可空)/ADS bibcode/DOI/arXiv(可空)/角色与 rank/Add 或 In Library 态；保留“本图引用”tab；点击节点**不**静默变 seed；“Explore from here” 显式发起新探索；保存不重置 pan/zoom/选择/filter/seed；孤立节点保持可见；ADS bibcode 的候选恒可 “Explore from here”。

**图渲染（D4）**：共享增强 renderer（方向箭头、label 避让、缩放控件、tooltip、图例含 A→B 含义、pan/zoom/节点交互、selected/hover）+ `LibraryGraph`/`DiscoveryGraph` 两 adapter——禁一个 `if(discovery)` 大组件；共享 SVG/渲染/pan/zoom/tooltip 设施/label 放置/箭头/选择行为；node 形状/角色/样式、详情面板、工具栏/filter、数据 contract 各域自定；Useful 菱形只属于 Discovery；Library 图本轮允许同步获得上述基础视觉升级，但不顺带改 layout/ranking/其他产品语义；节点角色对用户显示 Related/Useful（或 prototype 双语等价文案），Useful 不得误标为纯“Foundation”。

**加载与取消（D5）**：诚实不确定加载态（spinner + “正在查询 ADS…/正在查找相关文献和常用参考文献” + 取消），可说明在做 similar+useful 但不假装分步完成；取消真 Abort（沿 §8.2 传到 ADS）；取消后无 error toast、回到可重新探索稳定态、已有上一张图时保留不清空；快速连续探索：新请求 Abort 旧请求（token 守卫），被取消请求不写缓存。

**失败/空态（D8）**：useful 失败 = Related 完整 + Useful 区内联 unavailable 提示（沿用 prototype disconnected-note info 样式）+ 无 error toast，重试 = 重发同 seed 完整请求（不新增“只重试 useful”API）；similar=0 = 空态非错误（保留 seed 卡/面包屑/返回/retry，中区“没有找到相关文献”，不渲染孤立 seed 图）；fatal 同骨架按 status 本地化（503 ADS 不可用或未配置 / 429 频率受限请稍后重试 / 502 无法完成查询 / 404 未找到该 bibcode），server `detail` 仅诊断不翻译，429 转发 Retry-After、无倒计时；**新探索失败保留旧 session，失败 session 不进 history**。

**无 fixture（D9）**：Discovery 无 fixture/demo 回退；demo/无后端模式不显示假 Related/Useful、不切 prototype fixture，Explore 按钮禁用+说明（“文献探索需要连接 ArgelanderSpace 后端和 ADS”）；后端在但 ADS 失败走正式错误态；prototype fixture 不得复制为生产 fallback dataset。

**退役 UI（D6 + §13.3）**：删全局 Recommendations 开关/滑块/假 loading 定时器；删 exportBibtex 假占位按钮（不建导出端点，了结合 Stage 13 遗留 Q1）。

**其余**：加载/错误/部分失败态都须在 UI 呈现；深浅色/密度/窄屏按 prototype 所示范围；视觉沿用现有 ArgelanderSpace 设计语言与既有图渲染原语（可行处），但不得为代码复用保留旧 suggested 语义耦合；新文案双语同写，守 no-hardcoded-copy/locale-parity。

## 15. 前端探索历史模型

前端自有 history stack 支持 Back/Forward 恢复先前探索会话及相关 UI 状态（如 prototype 所示：query/filter/selection/display/scroll 按 session 捕获恢复）；**失败 session 不压栈**（D8/D14）；stack 仅内存，刷新丢弃（ADR §2.7 允许）。

## 16. Library Graph cache 版本化（D7 + D11/D13）

`GraphData` contract 加 `version`，定义唯一 `CURRENT_GRAPH_VERSION` 常量（具体整数非产品语义，D13；旧文件无 version 一律 stale）。

读取语义（`GET /api/library` 加载 graph.json）：

```
version === CURRENT_GRAPH_VERSION → 正常使用
missing / 无 version / schema invalid / version mismatch → stale：
    进 libraryLock → 锁内 double-check 版本（等锁期间可能已被修好）
    → 仍 stale：锁内重新 load 最新 LibraryStore → saved-only 纯本地重建（零网络）
    → 原子写 graph.json（tmp+rename）→ 返回新图
```

- 防“GET 基于旧 library 算图写回覆盖刚完成的 mutation”竞态；这是派生缓存自愈，**不广播 `library.changed`**。
- **自愈失败（rebuild/rewrite 失败）→ GET /api/library 500 显式失败**（D13）：不得返回旧 suggested graph、不得把损坏 graph 当空图、不得吞 filesystem error；`library.json` 损坏是 source-of-truth failure，绝不当 cache miss。
- 惰性重建不得触发任何 OpenAlex/ADS 网络调用。

## 17. CLI 冻结面（D10）

Web `LibraryRef` 加 bibcode；CLI `search`/`list` 等冻结面完全不动：不增字段、不动 golden、不以 additive 为由扩大。未来若需 agent 发起探索，单独设计 sanctioned interface（明确 discovery CLI command/skill），不先把 bibcode 塞进旧 search 输出铺路。

## 18. 测试策略

常规自动化测试全部离线/确定；延续 fetchImpl/provider stub 注入模式（web vitest 依赖 contracts/core 已构建 dist，改后先 build）。

- **contracts**：合法图；nullable abstract/year/DOI/arXiv；双角色；非法 edge kind；非法 rank；version/provider literal。
- **core**：seed+related+useful 组装；双角色归并单节点；useful 返回 seed 不改 seed 角色；related 少于限量；related=0 跳过 useful 返回 seed-only；边方向 citing→cited；仅可见↔可见成边；去重/自环去除；孤立节点保留；节点/边确定序；bibcode 精确成员；DOI 回退成员；无模糊标题成员；useful 失败 partial warning；similar 失败致命；discovery 不 mutate 传入 LibraryStore。
- **infra ADS discovery client**（mock fetch）：seed/similar 查询构造；useful 由返回 related bibcode 构造 OR 列表；转义/注入抵抗；字段表含 reference 与摘要/书目字段；适用处 score 排序请求；作者归一化保留可显示信息；DOI/arXiv 抽取；可选字段缺失；个别畸形结果过滤；TTL 内命中/过 TTL 未命中；键随 query/limit/field/sort 变；空结果成功缓存；网络/鉴权/限流错误不缓存为数据；abort 不写缓存。
- **server**：400/404/503/429/502/200 正常/200 seed-only/200 partial warning；`Cache-Control: no-store`；端点不拿锁/不写 Library 状态；不提交 JobRunner job；无 WS mutation 事件。
- **Add 集成回归**：Discovery bibcode 走现有 `POST /api/library/works` 创建/重复 exists/既有 `library.changed` 广播/Stage 13 失败语义不变。
- **Library 图回归**（退役后）：产出图节点全对应已存 work；无 OpenAlex suggested 节点；saved↔saved OpenAlex 边保留；离线解析 bib 边保留；手动单条建条目更新 saved 图且不再取 suggested 邻居；graph 版本自愈（无 version/异 version/corrupt → 锁内重建；library.json 损坏 → 显式失败）。
- **web/浏览器**：mock 确定 Discovery payload + 真实浏览器走 §14 全部交互（发起/加载/选择/摘要/filter/Add 不改视口与 seed/Add 失败可重试/Explore from here/Back 恢复/缺摘要/零 related/fatal/useful 部分失败/深浅色/窄屏）；happy-dom 不足为图布局交互证据，守项目真实浏览器 smoke 纪律。

## 19. 实施顺序（ADR §19 六阶段）

1. **Phase 1** contracts+纯 core：Discovery contracts；`LibraryRef.bibcode`+`workToRef`；`AdsDiscoverySource` 端口；纯组装 helpers+测试。
2. **Phase 2** ADS infra：discovery 适配器 + 专用 TTL 缓存；内部 typed provider 错误；离线 mock 测试。
3. **Phase 3** server 读 API：`GET /api/library/discovery`；失败→HTTP 语义映射；验证无锁/job/写/WS mutation 副作用。（此时后端可独立于 UI 测试。）
4. **Phase 4** 前端 Discovery：看 prototype；生产 design tokens 实现 Discovery 模式/组件（§14/§15）；复用 `POST /api/library/works` 入库；前端探索历史。
5. **Phase 5** 退役：buildGraph saved-only；mergeWorkIntoGraph saved-only；删 Recommendations/depth/count UI 与 exportBibtex 假按钮；无调用者后删 graph-node add 端点/路径；D12 核实后删死 suggested 代码与可能闲置的 OpenAlex 批量 API；GraphData version + 锁内自愈（§16）。
6. **Phase 6** 验收：包/单测回归；四门 `corepack pnpm -r build|test|typecheck` + `corepack pnpm lint`；mock 数据真实浏览器交互 smoke；一次显式真实 ADS smoke；用户 smoke。

## 20. 验收标准

全部成立才算完成：有 bibcode 的已存文献可打开新 Discovery UI；返回一个 seed + ADS related/useful；useful 基于实际 related 集；边全部是可见节点间真实引用；候选详情含摘要+书目足以判断相关性；Add 走现有 bibcode 路径；保存不重置/退出当前探索；“Explore from here” 只经显式动作换 seed；无深度控制；Library 图无全局推荐扩展、只含已存 works；Discovery 无 Library mutation/长 job；ADS 失败/部分失败诚实呈现；常规测试离线确定；四门通过；真实浏览器 smoke 符合 §14；一次真实 ADS smoke 验证端到端；无新 CLI 面。

## 21. 非目标（V1 明确不做）

自定义相似度/相关性算法；embeddings/向量库；自研文献耦合/共引评分；Connected Papers 算法复刻；深度/多跳自动扩展；项目级自动推荐；超出本窄端口的跨域 provider 抽象；OpenAlex/Semantic Scholar 发现回退；`reviews()`/Follow-ups；多起点/交集发现；批量 Add；持久发现 session/历史；服务端图布局；discovery 专用数据库；discovery job/后台刷新；新 CLI/agent discovery 命令；改动既有冻结 CLI 文献接口；Web BibTeX 导出端点（D6）。有具体产品需求后再议。

## 22. 已接受取舍

ADS token/网络成为 Discovery 硬依赖；Discovery 排序随 ADS 变化；无 ADS bibcode 的论文不能播种 V1 发现；ADS reference 元数据缺失时引用边可能不全；探索历史不跨刷新持久；跨域支持有意推后。这些是接受的 V1 边界，不是实施中要“修”的缺陷。

## 23. 真实 ADS smoke（Phase 6 显式执行）

用一个真实天文 bibcode 验证：seed 可解析；related 有返回；useful 有返回或部分行为诚实呈现；ADS references 提供时至少一些可见引用边可推导；节点元数据含摘要/书目；经现有 bibcode 路径 Add 一个候选成功；重复 Add 解析为既有 work 而非重复。此 smoke 不证明每篇 ADS 论文都有摘要/引用数据。

## 24. README 同步

README 只做最小能力描述同步（推荐→探索）；不把本阶段设计细节写入 README。
