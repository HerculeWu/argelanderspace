# ADS 文献探索与 saved-only 库图

状态：现行，Stage 14 于 2026-09-17 关闭并通过用户 smoke。来源：`46093915:.pi/memory-reference/stage14-discovery-plan.md`、旧 contracts-and-decisions 与 product-and-architecture 的最终记录。原方案实施时序留 Git；本页维护当前语义，不重新开启阶段。背景取舍见 [ADR-0004](adr/0004-discovery-library-separation.md)。

## 两张图与副作用边界

- **Library Graph**：已存 Work 和真实引用边。旧全局 suggested 候选池、被引排序、MAX_SUGGEST、推荐开关、数量/深度滑块与假 loading 已退役。
- **Discovery Graph**：一个 ADS seed，加临时 related/useful 候选及可见节点间真实引用边。无 BFS 深度、无自动多跳；继续探索只能显式 Explore from here。
- `A → B` 始终是 A 引用 B；similar/useful 是节点角色，不是相似边、共引边或推荐边。不能为连通性补造边，孤立节点合法。
- **Discovery 是只读派生态**：不写 library.json/graph.json，不隐式导入，不拿 libraryLock，不进 JobRunner、不 pin Doc mutation、不广播 library.changed，也无 discovery WS 事件。探索历史、选择、视口、筛选是前端状态，刷新允许丢失。
- provider 检索缓存是独立派生数据；Library 图的版本自愈属于 Library 缓存维护，不是 Discovery 请求的用户数据 mutation。
- V1 仅 ADS；不可用显式报错，不回退 OpenAlex/Semantic Scholar/旧推荐，也不提供 fixture/demo 探索数据。OpenAlex 仍可用于 Library 元数据解析。

## 查询与领域边界

数据流：web GET → server → core 组装 → 独立 AdsDiscoverySource port → infra ADS discovery client。

core 不知 ADS URL/Solr/token/HTTP/cache 路径；infra 不改 Library/UI 状态；server 不实现排序或图组装；web 不从 raw provider references 重建边。Discovery port 不扩张旧元数据 AdsSource 的接口和缓存语义。

查询次序固定：

1. seed bibcode 精确查询。
2. `similar(seed)` top **18**。
3. 对**实际返回 related bibcodes 集**构造一阶 OR 查询，`useful(related-set)` top **6**。
4. 归并节点、覆盖 Library 成员态、推导可见引用边。

常量不暴露为 related/useful/depth/beam 参数。useful 不直接作用于 seed，不嵌套第二个 similar 来并行重复查询；小图串行延迟是已接受取舍，未有实证前不改变精确 related 集合语义。

bibcode 是标识符，不是任意检索表达式：长度有界、拒空/控制字符，嵌入查询前转义/加引号；useful 每个 bibcode 分别转义再 OR。seed 身份缺失属 provider 失败，个别 related/useful 无合法 bibcode 可跳过。

provider 请求字段含 bibcode/title/author/year/pub/abstract/citation_count/doi/identifier/reference；identifier 用于可选 arXiv 抽取，reference 用于边。作者保留可显示信息，不退化为只姓。精确类型/schema 以 contracts 与 port 为实现入口，不承诺旧方案行号。

## 响应、归并与成员态

`DiscoveryGraph` 包含 version:1、provider:"ads"、seed、nodes、edges、warnings；节点以 ADS bibcode 为身份，有 title/authors/year/venue/abstract/citationCount/doi/arxivId、roles、可选 relatedRank/usefulRank、libraryId。可缺字段用 nullable 表达，不假造摘要。

- `libraryId !== null` 即已存，不重复存 inLibrary。
- 同时 related+useful 合成一个双角色、双 rank 节点；useful 返回 seed 时仍只给 seed 角色。
- 输出顺序确定：seed → related 按 relatedRank → useful-only 按 usefulRank。
- 对可见 A 的 references，只保留可见 B 且 B≠A 的 A→B；去重、确定性排序；kind 固定 citation。raw references 不传前端。

每请求读 Library 快照只作成员覆盖：精确 bibcode 优先，然后双方均有 DOI 时规范化 DOI 匹配；**不用模糊标题**。假阴可由权威 add 返回 exists 弥补，假阳会错误阻止收藏 distinct 文献。持久身份归并仍由 LibraryStore.upsert 的 doi/arxiv/openalex/title 规则负责，bibcode 不是新增身份键。

library 原子保存允许无锁读取观察到完整旧版或新版；不与 upload/refresh 的长 mutation 串行。

## HTTP 与失败语义

`GET /api/library/discovery?bibcode=<bibcode>`；响应 `Cache-Control: no-store`，因为含即时 Library 成员态。错误体保留 `{detail:string}`，status 是机器信号。

| 情形 | status / 结果 |
|---|---|
| 缺失/非法 bibcode | 400，调用 ADS 前拒绝 |
| seed 未找到 | 404 |
| token 缺失/被拒 | 503，无回退 |
| ADS 限流 | 429，有 Retry-After 则转发 |
| ADS 超时/网络/5xx/顶层响应非法 | 502 |
| similar 查询失败 | 核心能力失败，502；鉴权/限流按对应分类 |
| similar 返回 0 | 200 seed-only，不发 useful |
| useful 失败，similar 已成功 | 200，保留 related，warning `useful_unavailable` |
| 个别论文无摘要 | 正常节点，abstract:null |

AbortSignal 从入请求经 core 传到 ADS；取消尽量停止上游工作。aborted 请求不写缓存，前端还需代际/token 接纳门，不能只依赖 abort。

## ADS discovery 缓存

独立 `<dataDir>/library/cache/ads-discovery/`；不复用或改变旧 metadata ads 缓存键。条目 `{fetchedAt,data}`，TTL **24h**。

- 只缓存 provider 检索响应，不缓存组装好的 DiscoveryGraph。
- key 包含 query、fields、rows/limit、sort 等全部影响 provider 响应的输入。
- 空结果可作为成功数据缓存；网络、鉴权、限流失败不能缓存为成功数据；abort 不写。
- Library 成员是即时本地用户态，Add 后立即变化；重新组装小图便宜，因此不建立 DiscoveryGraph 的复杂失效机制。
- 无 stale-while-revalidate、缓存数据库、后台刷新或持久 discovery session。

## 入库：唯一权威 mutation

候选只走既有 `POST /api/library/works {mode:"bibcode", bibcode}`。不以 Discovery 已有元数据绕过 ADS export/解析/归并/去重/cite key/acquisition/持久化路径；一个业务 mutation 一个权威实现。

成功或 exists 后只就地更新 libraryId，不退出探索、不换 seed、不重排图、不重置 pan/zoom/选择/filter；正常 Library 重载在别处更新持久库。Stage 15 的自动 arXiv 获取由此创建路径继承，**没有改变 Discovery GET 的只读边界**，见 [library](library.md)。

候选详情没有 BibTeX tab，不前端拼造 BibTeX，也不专为候选加 export 请求。权威 BibTeX 在入库路径生成。

## 导航与交互

### 入口与历史

唯一入口为已有文献详情“探索相关文献”；有 bibcode 才可用，无则禁用并双语说明。无 Reader 入口、无独立 activity bar 项；demo/无后端禁用，不切换到 prototype fixture。

Explore 是文献工作区内临时模式，有返回库、面包屑、前进/后退。“继续上次探索”只在当前前端生命周期确有 session/history 时出现。

`#explore/<url-encoded-bibcode>` 使用轻量 hash，pushState/replaceState + hashchange/popstate。**只有成功的 seed transition 进入历史**；失败/取消不制造 entry，不改变原 URL/current/history。浏览器 Back/Forward 和探索箭头共享 seed 历史。

内存 snapshot 恢复选择/视口/filter/滚动等；F5 或深链打开按 hash 重查当前 seed，UI 状态可回默认。hash 指向活跃探索，不编码 pane id；优先合适的 Library pane，无则切 active pane 为 Library。坏 hash/ADS 失败是可返回 Library 的正常错误态，不能让 shell 损坏。

### 候选与图

详情提供标题、作者、年份、venue、可空摘要/引用数、标识符、角色/rank、Add/In Library，以及本图引用 tab。点击节点只选中，不静默换 seed；Explore from here 才发起下一探索。

共享 graph renderer 提供方向箭头、label 避让、zoom、tooltip、图例、pan/zoom/选择；LibraryGraph 与 DiscoveryGraph 各自 adapter，不退化为一个到处 `if(discovery)` 的大组件。节点角色/形状、详情、工具栏和筛选由各域负责；Useful 菱形仅属 Discovery，不把 Useful 一律译成 Foundation。Library 可共享视觉能力，但不因此改其布局/排序等产品语义。

### 加载、取消与失败

- 诚实不确定加载：spinner＋查询 ADS 的文案，不假装分步完成。取消是真 Abort；不 error toast；有旧图则保留，没有则回可重新探索状态。
- 快速探索时新请求取消旧请求，token 守卫阻止迟到响应覆盖。
- useful 失败保完整 Related，在 Useful 区内联 unavailable 提示，不 error toast；retry 是同 seed 完整请求，不另造只重试 useful API。
- similar=0 时 API 是 seed-only，UI 显示没有相关文献的空态，保留 seed 信息/导航/retry，**不画孤立 seed 图**。
- fatal 保同一骨架，按 503/429/502/404 双语说明；server detail 仅诊断，不强制翻译。429 转发 Retry-After，不做倒计时。
- 新探索失败保留旧 session，不进历史。深浅色、密度、窄屏沿既有设计语言，新文案双语。

摘要统一 `abstractHtml`：provider HTML 白名单 SUB/SUP/I/B/EM/STRONG/BR/P，剥属性、剔除活性内容；只在文本节点做 KaTeX，沿 texmath 边界规则。它不是 Markdown，也不能回归纯文本直渲；Library 与 Discovery 共用。

## Library 图：派生缓存自愈

`buildGraph` 只产已存节点及 saved↔saved 边（已存 referenced_works＋离线 bib）。增量 `mergeWorkIntoGraph` 也只补本地可算的 saved 边，不发 suggested 邻居请求；即时尽力，全量 build/refresh 才是全局收敛权威。

`graph.json` 有 `CURRENT_GRAPH_VERSION`（当前 2）：

- 当前版本有效 → 使用。
- missing / 无 version / schema invalid / version mismatch → 进入 libraryLock，锁内 double-check；仍 stale 则**重读最新 LibraryStore**，纯本地重建、原子写回。
- 自愈不广播 library.changed，不触发 ADS/OpenAlex 网络。
- 重建/写回失败 → 500 显式失败，不返回旧 suggested 图、不伪装空图、不吞 filesystem 错误。`library.json` 损坏是 source-of-truth failure，绝不当 cache miss。

旧 `POST /api/library/refs`、addNodeToLibrary、GraphNodeDetail、OpenAlex fetchMany 等推荐专用面已退役；历史 `origin:"graph-node"` 的 Work 不迁移，仍是普通已存 Work。源码删除遵循先核 caller 的工程规则，不把旧删除清单当本次执行指令。

## 范围、冻结与验证边界

- `LibraryRef.bibcode` 是 web/API 可选增量；CLI list/search 不经 LibraryRef，未改变其冻结输出。不为未来探索 CLI 往 search 偷加字段或重冻 golden；新 sanctioned 接口需另行设计。
- exportBibtex 假占位按钮已删除（Stage 13 旧 Q1 已了结）；没有因此批准 Web BibTeX 导出端点。
- 无自研相似算法/embedding/共引评分、无多起点/多跳、无批量 Add、无持久历史、无发现专用数据库或后台 job、无服务端布局。缺少 ADS bibcode 不能播种；ADS 排序会变化、reference 缺失可使边不全，这些是接受的 V1 边界。
- 持久回归面：contracts 图合法性、core 归并/边义/部分失败、infra 查询转义/缓存/abort、server 状态与零 mutation、Add 复用、库图自愈、web 历史/取消/保存不重置。
- 常规测试离线确定，真实 Chrome 用于布局/交互，真实 ADS smoke 只证明受测样本。历史验收在 [history](history.md)，不把 mock/happy-dom 当像素真值。
