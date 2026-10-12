# 论证图：数据、审计与读写接口

状态：数据层与 HTTP 接口已实施（论证图票 02，2026-10-12）；画布（票 03）、只读视图（票 04）与手动编辑（票 05）已实施。CLI、Copilot 工具、Work 合并跟随尚未实施，见 `.scratch/argument-graph/`。归属取舍见 [ADR 0009](adr/0009-argument-graph-work-owned.md)，数据保护与冻结边界以 [contracts](contracts.md)「论证图」一节为准，本文只写技术机制。

## 存储

- 位置：`<dataDir>/argument-graphs/<编码后的 work id>.json`，每个 Work 一个文件；不进 `library.json`，不是 Doc；数据保护与冻结边界（不参与指纹/归档/物理删除等）见 [contracts](contracts.md)「论证图」一节，不在此重述。
- 文件名编码：work id 的 UTF-8 字节逐个编码，`[A-Za-z0-9_-]` 原样，其余（含 `:`、`/`、`.`、`%`）写成 `%XX`（大写十六进制）。单射且可逆，名字里没有 `/`，也不会是 `.` 或 `..`；解码只接受规范形式。含 `.json` 的文件名不超过 240 字节（编码后的主干 ≤ 235 个字符），超出的 id 被拒绝（`unsafe_id`）；空 id 和非良构 Unicode（孤立代理项；否则会都编成 U+FFFD 而撞名）同样 `unsafe_id`。大小写不敏感的文件系统上仅大小写不同的 id 会撞名，Work id 里没有这种情况，不额外处理。
- pretty JSON（2 空格）；`rev` 乐观锁；同目录 `<name>.json.tmp` 写完后 rename，与 plans 同一做法。同进程写入由 server 的论证图锁串行化（不与其他锁互堵）；跨进程并发写的边界见 contracts，不加文件锁。
- 没有文件 = 空图（`rev: 0`，不创建文件）。文件读不出来（是目录、无权限等）、不是合法 JSON、不满足 schema、`work_id` 与文件名不符、或 `version` 大于 1，都是系统错误（`ArgumentGraphFileError`：`corrupt`（含读取失败与非法 JSON，消息区分）/ `wrong_work` / `future_version`），不当作「没有图」，不重置，也不会被后续写入覆盖。
- 代码：contracts `argument-graph.ts`，core `argument-graphs/store.ts`，server `argument-graph-actions.ts` 与 `app.ts` 的路由。

## Schema 要点（`version: 1`）

```
{ version: 1, rev, work_id,
  arguments: [{ id, title, claim, grounds, warrant, backing, qualifier, rebuttal,
                warrant_implicit, kind: native|end|normal,
                sources: [{ text, target?: { doc_id, anchor? | page? } }] }],
  edges: [{ from, to, role: grounds|warrant|backing|rebuttal }] }
```

- 全部对象 strict：未知键是写入失败；读侧同理——磁盘文件里出现未知键即 schema 失败，按系统错误处理（不静默丢弃、不重写），需手工修复文件。六个 Toulmin 字段、`warrant_implicit`、`kind`、`sources` 缺省为 `""` / `false` / `normal` / `[]`。
- `from → to` 表示 `from` 的 Claim 在 `to` 中充当 `role`。出处目标恰好一种跳转：`{doc_id, anchor}`（共享 IR Doc，结构 id）或 `{doc_id, page}`（PDF Doc，页码从 1 起）；只带 `doc_id`、或 `anchor` 与 `page` 都带，是写入失败。目标可整个省略（只剩显示文字）。只作参考，不校验 Doc 是否仍属于该 Work。
- 规模上限（论证 / 边 / 标题 / 字段 / 出处数经用户 2026-10-12 同意）：论证 ≤ 500、边 ≤ 5000、论证 id ≤ 64、短标题 ≤ 80、每个 Toulmin 字段 ≤ 20 000、每个论证出处 ≤ 50（出处文字同 20 000）、出处目标 `doc_id` 与 `anchor` 各 ≤ 512。所有「字符」都按 UTF-16 码元计（`String.length`），超限是写入失败。

## 写入时的结构校验

schema 内（`checkArgumentGraphStructure`，zod `superRefine`）：论证 id 唯一；短标题 trim 后非空；每条边两端都存在；无自环；同一对论证（有向）同一角色至多一条边。**环、缺 Claim/Grounds/Warrant、End 有出边、Native 有入边都不是写入失败**，由审计报告。

## 论证审计

`auditArgumentGraph(graph)`，纯函数，web 与 server 共用，结果永不落盘。返回：

| 字段 | 含义 |
|---|---|
| `cycles` | 强连通分量（≥ 2 个论证）：`{ arguments, edges }`，id 按图中顺序 |
| `noPathToEnd` | 不是 End 且沿边（from→to）到不了任何 End 的论证；图中没有 End 时为空（只报 `noEnd`，不逐个列出） |
| `noEnd` | 图中有论证但没有 End；论证数为 0 的空图不报（审计无发现） |
| `endWithOutEdge` | 有出边的 End |
| `nativeWithInEdge` | 有入边的 Native |
| `incomplete` | `{ id, missing }`：Claim 为空白；Grounds / Warrant 既无文字也无对应角色的**入边**。`warrant_implicit` 不算满足 Warrant（隐含的 Warrant 仍应写出文字） |

## HTTP

`:workId` 是 URL 编码的 Work id（含 `:` 和 `/`）。

- `GET /api/works/:workId/argument-graph`：Work 不在库中 404；没有图返回空图 `rev: 0`（200，不是 404）；文件不可读 500。`Cache-Control: no-store`。
- `PUT /api/works/:workId/argument-graph`：body 是整张图，`rev` 必须等于当前 rev；成功返回 `rev + 1` 的图。Work 不存在 404；body 不是合法 JSON/不满足 schema 或结构规则、或 `work_id` 与 URL 不符 400（`detail` 含前 20 条原因）；`rev` 不符 409 `{ detail: "rev mismatch", rev: <当前> }`，不覆盖；已存在的文件不可读 500，不覆盖。CSRF 守卫同其他写接口。
- 「覆盖非空图须带替换标志」等确认流程属于 CLI/Copilot/页面各自的票，这两个接口只做整图替换。

## WebSocket

`{ type: "argument-graph.changed", work_id, cause?: "put" | "external", at }`。`work_id` 是原始 Work id，不是文件名编码。server 自己的 PUT 成功后立即广播 `put`；watcher 轮询 `argument-graphs/*.json` 的 mtime+size 指纹（按 Work，回调带解码后的 id，已排序；tmp 文件和不是 store 写出的名字被忽略），变化时广播 `external`。server 自写会再触发一次 `external`，与 plans 先例相同，接收方的重取是幂等的。

## 画布（`packages/web/src/graph/`、`argument/`；票 03，只有渲染，页面入口与写入在后续票）

共享图 renderer 有两种布局：`GraphCanvas`（力导向，Library 与 Discovery 两个 adapter）和 `LayeredGraphCanvas`（分层，论证图 adapter）。两者共用缩放控件 `GraphZoomControls`、`cg-*` 样式和视口状态机 `useGraphViewport`（`graph/useGraphViewport.ts`：画布尺寸、视图与 stash、缩放上下限 0.3–3.2、滚轮、平移、双指缩放、拖节点、hover 与 tooltip 锚点、hover 邻域、节点 `g` 的键盘与焦点外壳）；分层 renderer 不认识「论证」，只收到节点（短标题、颜色、双环、置底/置顶、角标）和边（颜色、静止色、虚线/点线、可选文字）。领域语义全部在 `argument/`：`canvasModel.ts`（种类与角色到颜色、线型、置底置顶；审计角标与环上的边取自 contracts 的 `auditArgumentGraph`）和 `ArgumentGraphCanvas.tsx`（图例、tooltip、双语文案 `argument.canvas.*`）。

- **共享视口与各自保留的部分**：`useGraphViewport` 不认识节点怎么画、怎么摆；renderer 以回调接入——`onNodeDrag` / `onNodeRelease`（力导向：钉住并 reheat；分层：直接移动点）、`onUserView`（用户接管视图，分层据此停止自动适应）、`gesture`（在特殊目标上起手的拖拽，分层的连边手柄）、`tooltipAt`（力导向夹取 tooltip）；适应窗口的规则、物理、布局、controller 由各 renderer 自己写，经 `setView` 落回。controller（放大、缩小、适应、重新布局）由 renderer 用 `zoomCenter` 加自己的 fit / relayout 组装，见 `GraphCanvas`；分层 renderer 暂未暴露 controller。
- **布局是纯函数**（`graph/layered/layout.ts`）：Native 在底、End 在顶，其余按最长支撑链；闭合环的边只在分层时忽略、照常绘制，并在 `backEdges` 里报告；跨层的边经不可见路径点；每个论证的列宽 = 它自己短标题的宽度（按最大字号 14 预留）；同输入同输出。短标题（`layered/text.ts`）：拉丁文在空白与连字符处断行，单词超过一行才在词内断，中文逐字断，最多两行、超出以 `…` 截断；宽度按字符类别估算（窄字母、小写、大写、宽大写 W/M/O/Q、数字、全角），偏保守，纯函数、不量 DOM。短标题与边标签的避让也是纯函数（`placement.ts`）：右侧被占时改下、左、上里最空的一侧。
- **结构、置底置顶或短标题变化即重新布局**，拖动只在此之前有效，不保存；视图适应窗口时避开标题和图例（量实际尺寸；缩放控件在右缘，由右留白避开），画布尺寸变化时若未手动平移或缩放则重新适应，选中的论证保持在可见范围内。
- **画布拖拽连边**：选中论证左侧出现手柄，拖到任一论证（含自己）后回调 `onConnect(from, to, 屏幕位置)`；自环拒绝、角色选择与写入由调用方（票 05）负责。手势在松手时用当时最新的 `onConnect` 与节点集合（拖动中父组件重渲染不会使它作废）。键盘选中（Enter）后焦点仍在节点上，整条链路保持点亮；没有选中时焦点才点亮一跳邻域，指针悬停始终是一跳邻域。

## 视图（`packages/web/src/argument/`；票 04）

文献页（Library 页）内的临时模式，与探索模式同级，二者互斥；不是新的页面或活动栏项。

- **入口**：Work 详情底部的「论证图」按钮（与「探索相关文献」并列；`WorkArgumentEntry` 读该 Work 的图，按钮上写论证数，没有图时写 `—`；无后端的示例数据下禁用；没有正文、没有 bibcode 的 Work 同样可进）。Reader 顶部的「论证图」按钮（LaTeX/文本 Doc 的 topbar，PDF Doc 的工具栏）：按下时才用文库 refs 查 Doc 所属 Work（Reader 平时不读文库），经 `Workspace.openArgumentGraph` 切到一个 Library 页并打开该 Work 的图：当前窗格是 Library 页就用它，否则用布局里第一个 Library 页，一个也没有时当前窗格变成 Library 页。要用哪个窗格由 Shell 选定并写进总线请求（`paneId`），总线只投递给这个窗格，多个 Library 页时不会选一个、投另一个。查不到所属 Work 时在按钮旁说明、不跳转：文库读不出来与「没有 Work 持有该 Doc」是两句不同的说明；按下后若 Reader 已切到别的 Doc，迟到的回答作废、不带用户走。
- **深链接**：`#argument/<URL 编码的 work id>`（`lib/argument-route.ts`；与 `explore-route.ts` 共用 `lib/hash-route.ts` 的前缀路由与总线工厂）。从 UI 进入时 pushState 一条历史，浏览器后退回到文献库；从正在探索的窗格进入时也只写这一条（探索被让位而不再写它自己的「回到普通 URL」那条）。Shell 的启动与 hashchange/popstate 把 hash 交给 `argumentBus`，**没有 Library 页时（启动，以及 popstate 回到 `#argument/…` 而 Reader 已占了窗格时）先建一个**（`ensureLibraryPane`；popstate 路径先问离开保护），请求挂起到 Library 页注册。popstate/hashchange 到任何不是 `#argument/…` 的 URL（含 Doc 路由）都先退出视图。F5 或直接打开回到同一视图；选中的论证不进 URL。坏链接、Work 不存在、文件损坏都是可返回文献库的正常错误态，不破坏 shell。
- **读取与刷新**：`api/argument-graph.ts` 的 `fetchArgumentGraph` 走 `apiRequest`，结果为 `ok / not-found（404）/ corrupt（500 且 detail 以固定文案 "argument graph file is unreadable" 开头）/ error`；无图是服务端给的空图（`rev: 0`），显示空图状态，**不与 corrupt 混淆**。`useArgumentGraph` 在收到本 Work 的 `argument-graph.changed`（`put` 与 `external` 一视同仁）后重取；重取期间保留旧图，内容相同的重取不换对象（server 自写会再触发一次 external）。socket 重连（`hello`）也重取一次，事件可能在断线时丢了。重取遇到 404 或文件损坏如实切到对应错误态，文件修好后下一次事件恢复；遇到瞬时错误（无应答、其他 server 失败）则**保留已显示的图**，在标题栏下给出非阻断的提示与「重试」，下一次成功的读取清除它（首次读取没有图可留，失败仍是错误态）。损坏的识别用 contracts 的 `ARGUMENT_GRAPH_UNREADABLE_PREFIX`（server 的固定文案前缀），两端引用同一常量，server 测试绑定它。选中是视图自己的状态：论证仍在则保留，被删除（图读成功但不含它）才清除；错误态不清除。
- **页面上下文（Copilot，ADR 0005）**：视图把 `ArgumentPage`（contracts `argument-ops.ts`，strict）经 Library pane adapter 发布为 `PageContext.argument`，打开期间它代替 `library`（与 Discovery 同样不再把 Library 页当作当前页；`library: null`）。形状：`work {id,title}`、`phase`（loading / ready / empty / not-found / corrupt / error）、`rev`（读到的文件版本，无图时 null）、`counts {arguments,edges}`、`audit`（`total`、环、无通路、无 End、End 有出边、Native 有入边、不完整，均按论证 id）、`selectedId`、`partial`、`reduction`（partial 页才有，null 即整图，见下「容量」），以及三选一的内容：`partial:false` 时 `graph` 是整张图；`partial:true` 时 `graph` 为 null，`outline`（每个论证的 id、短标题、种类、六个字段各自是否有内容、`warrantImplicit`、出处数）、`edges`（全部边）和 `selected`（选中的论证，完整）；`note` 是页面对自己的说明（所有形态都说明这是只读的论证图、Library 页动作此时不可用；partial 页另说明省略了什么）。status：ready 与 empty 是 `complete`，loading 是 `unavailable`，not-found / corrupt / error 是 `error`（coverage 校验在 `PageContext`）。上下文对象标识是 Work id 加图的 `rev`，名字是 Work 标题。
  - **容量**（硬上限 `ARGUMENT_PAGE_MAX` = 150 000 个 UTF-16 码元，整页 JSON，任何图、任何选中下都不超过；整图预算 `ARGUMENT_PAGE_FULL_MAX` = 100 000 指 `graph` 本身）：整张图 JSON 不超过 100 000 且整页不超过 150 000 时发布整图。否则发布 partial 形态，`reduction` 字段说明省略了什么，取**能满足 150 000 的最小级别**，且**不选比整页更长的形态**（整页不超过上限而没有任何级别更短时仍发整页）。级别逐级缩减：① `outline` 列出每个论证的 id、短标题、种类、六个字段各自是否有内容、`warrantImplicit`、出处数，`edges` 列全部边，`selected` 是选中论证全文；② `selected` 的每个字段截到 4000、每条出处文字截到 500 个字符（`reduction.textLimit`，被截的写进 `reduction.truncated`，如 `claim`、`sources.3.text`；出处目标不动）；③ `edges` 只留与选中论证相连的边（至多 300 条，`counts.edges` 仍是总数；没有选中则为空）；④ `outline` 只留 id、短标题、种类，选中论证再截到 1000 / 200，相连的边至多 100 条，审计各清单封顶（每类 30 个 id，环 5 个、每个 20 个 id，`audit.total` 仍是真实发现数，`reduction.auditTruncated`），`outline` 在整页逼近上限时只列放得下的（总含选中那条，其余数量写在 `reduction.outlineOmitted`；选中论证的尾部出处放不下时写在 `reduction.sourcesOmitted`），所以第 4 级无论图多大都不超上限。实测最坏情况（500 个论证、id 64 字符、标题 80 字符、5000 条边、选中论证六个字段各 20 000 加 50 条满长出处，整图约 2.1 MB）：选中时 145 895、不选 97 446；500 个短论证（整图 108 960，超整图预算）发 ③ 级 111 408，比整页短。schema 对各级别做交叉校验（保持 strict）：`reduction` 恰在 partial 页出现，`outline` 与 `reduction.outlineOmitted` 之和等于论证数，第 1–2 级 `edges` 等于边总数，第 3 级起只含选中论证的边，第 4 级条目只有 id / title / kind，`selected` 不长于 `textLimit`；整页另校验 `graph.work_id === work.id`。省略的文字在票 09 的论证图读取工具上线前模型拿不到，页面 `note` 要求如实说「看不到」，不要猜。**每个 phase、每种形态的 `note`（≤ 900 字符）都说明「论证图视图打开期间 Library 页面动作不可用」**，Copilot 看到被拒绝的动作就知道原因；最近一次重取失败而界面仍显示旧图时，`note` 追加「图可能不是最新的」（`ARGUMENT_STALE_NOTE`，沿用 note 而不是改 phase/coverage：图本身仍是完整、可用的读取）。system prompt 只在「可用的页面上下文」那句里加上论证图（该提示词有字节预算测试，说明留在页面里）。消息记录的摘要（`ArgumentContextSummary`）带选中论证的短标题 `selectedTitle`，界面显示短标题而不是 id。
  - **去重与观察**：选中变化、图的重取都经 Shell 的 `revision` 计数重发（`PUT /views/:id`），服务端只在每次模型请求前看一次当前版本，版本与已观察的不同才写一条 page-observation。整张图随任务的消息**或随一条 observation** 发出后（`argumentKey(workId, rev)` 记在 run 的 held 集合里；只有 `ready` 页登记，空图没有可列的内容），后续 observation 用 partial 形态列出图并带选中论证（同样取最小的满足上限的级别，且不长于它替代的整页，否则仍发整页）；`rev` 变了才再整图发一次，随后又是列出的形态，所以任务中途才打开论证图、或 rev 变化后，连续点选也不会产生整图洪流。observation 在写入历史之前用 `CopilotObservationSchema` 校验（`copilot-observation.ts` 的 `recordableObservation`）：校验不过的论证图页面不原样写入（写入后读回失败会让整个会话不可读），降级为一个 `phase: "error"`、不带图的合法页面并记一条不含内容的日志，连这样也不合法则不写这条 observation，下一次模型请求再试。
  - 视图打开期间 Library 页自己的动作（过滤、选中文献、探索入口等）一律 `unavailable`，system prompt 说明这时页面是论证图。打开、选中、退出论证图的 Copilot 视图动作与论证图读写工具属于票 09，这里没有。
- **出处跳转**：有目标且目标 `doc_id` 仍在该 Work 的 `doc_ids` 里才是可点按钮，否则只显示文字，不报错、不校验目标是否存在。点击经 `Workspace.openDoc(doc_id, anchor)`：共享 IR 的 Doc 用结构 id，PDF Doc 用 Reader 已有的 `page-<n>` 锚点；因此在单窗格布局下阅读窗格替换当前窗格（视图随之卸载），有多个窗格时用已有的 Doc 窗格。当前 URL 是 `#argument/…` 时打开 Doc 写**新**历史（`pushDocUrl`，其他情况仍是 replace），浏览器后退回到该图（popstate 回到 `#argument/…`，没有 Library 页就先建一个）；也可用 Reader 顶部入口。
- **没有的东西**：没有触发 Copilot 的按钮。新建、清空、编辑、删除、连边见下一节「编辑」。
- **窄窗格**（用户 2026-10-12 的决定，不是原型内容；规则是 `argument/layout.ts` 的纯函数，与文献库 `library/layout.ts` 同一思路并复用其 `MIN_GRAPH_COLUMN`）：大纲 300、面板 392 在任何宽度下都是原型宽度，不再收窄。度量的宽度是视图自己的宽度（`useElementWidth`，即窗格宽，1440 窗口单窗格 1378、1024 窗口 962、1440 双窗格各约 686）。① 面板打开且大纲与面板并排后画布会少于 `OUTLINE_FOLD_CANVAS`（480，即窗格 < 1172）时，大纲自动折叠成 34 px 的轨道（`lib-rail`，`expand-argument-outline`，图标/文案/键盘与文献库列表的折叠控件同一模式；大纲头部的 `collapse-argument-outline` 可手动折叠）。480 不是用户给的数：文献库只在画布 < 240 才折，但那样 1024 窗口（962）会留下 270 px 画布、适应缩放 30%，比旧的收窄做法还差；折叠后有 536 px。要改只改这一个常量。② 用户手动展开后，本次面板打开期间尊重这个选择（此时画布不足则走③，不再自动折叠）；关闭面板或宽度档变化后恢复自动；用户手动折叠的任何时候都不自动恢复。关闭面板后被自动折叠的大纲自动回来。大纲各行的展开状态由视图持有，折叠再展开不丢。③ 折叠后（或用户展开后）画布仍不足 `MIN_GRAPH_COLUMN`（240）时，面板（`data-placement="overlay"`）盖在画布右侧：绝对定位、不占画布宽度、仍有关闭按钮，Esc 关闭（审计清单开着时第一个 Esc 先关清单）。画布收到 `coverRight`（面板宽，窗格更窄时取窗格宽）：适应窗口与「选中的论证保持可见」只按未被盖住的部分算，缩放栏左移到面板之外（`--cover-r`）。④ 画布的覆盖层在窄列里保持完整：画布标题最窄 180、图例最宽随画布收窄（行内换行）且让出缩放栏，缩放栏不压图例。判定阈值：窗格 ≥ 1172 并排；666–1171 大纲折叠、面板并排；< 666 面板浮层（用户展开大纲时 < 932）。


## 编辑（票 05；`contracts/src/argument-edit.ts`、`web/src/argument/`）

用户不借助 agent，在视图里从空图整理出完整的论证图。批准的界面是原型变体 C（[spec](../.scratch/argument-graph/spec.md)「已批准的界面」），页面功能如下；Copilot 的论证图工具（票 09）将调用同一批纯操作与同一条提交路径，页面与工具不得各写一套。

- **提交路径只有一条**。纯操作在 contracts：`createArgument`、`updateArgument`、`deleteArgument`（返回 `removed`）、`restoreArgument`、`addEdge`、`removeEdge`、`clearArgumentGraph`，输入图与参数，输出新图或拒绝原因（`not_found` / `self_loop` / `duplicate_edge` / `edge_not_found` / `invalid`）。每个结果都过 `ArgumentGraphSchema`，所以「操作拒绝」与「服务端 400」是同一套规则；`checkArgumentGraphForWrite` 把 schema 失败翻成可读的 `ArgumentEditIssue`（短标题为空或超长、字段超长、出处文字为空、出处/论证/边超限、id 重复）。纯操作不碰 `rev`。web 侧 `argument/commit.ts` 的 `commitArgumentEdit(workId, base, edit)` 对调用方读到的图执行操作，再以 `base.rev` 做整图 `PUT`（`api/argument-graph.ts` 的 `putArgumentGraph`，结果 `ok / conflict / invalid / not-found / corrupt / error`）。`useArgumentWrites` 把写入排成串行队列：每次写入作用于页面持有的最新图，服务端对上一次写入的回答立即被采用（`useArgumentGraph.adopt`，不等广播），所以连续两次编辑不会各拿一个过期的 `rev`。
- **冲突（409）不覆盖**。立即生效的写入（连边、移除边、删除、清空、撤销）遇到 409 时，页面重取最新图并说明「这次改动没有写入」，请用户再试一次。表单保存遇到 409，或表单开始后这个论证已在别处被改（与开始时的存档不同）或被删除，则**表单草稿原样保留**，面板底部显示冲突说明，保存停用，直到用户点「重新载入」（读取最新图，把它当作新的起点；论证已被删则之后保存会重新建出它）。别处改了**别的**论证则不算冲突：保存基于最新图。编辑中收到外部更新从不替换草稿，被别处删除的论证在草稿未存时也留在面板里。
- **删除不确认，可撤销**（用户 2026-10-12 的决定，见票 05）。删除经同一条路径写入，随后给 8 秒的「撤销」提示；撤销以**删除之后那张图及其 `rev`** 为基础把论证连同它的边放回原来的位置，所以期间图被别处（或自己后来的写入，此时提示已被收起）改过，写入得到 409，页面如实说「图在此期间被改动过，无法撤销」并重新载入，不覆盖任何东西。清空整张图才弹确认对话框（写明论证数与边数、不能撤销，默认焦点在取消，失败时对话框保持打开并说明）。
- **新建**：标题栏与空图状态的「新建论证」打开面板的编辑态并聚焦短标题；论证不在图里直到第一次保存（id 取最小的未用 `a<n>`），Cancel 即丢弃，保存之前不能连边（连边控件停用）。保存空短标题不可能（按钮停用）。
- **连边**：面板里各 Toulmin 元素的「添加来自其他论证的依据」与「被用于」。选择器默认只列比当前论证低一层（「被用于」方向为高一层）的论证，层取当前画布布局的分层（`argument/layers.ts` 复用 `layeredLayout`，选择器与画面不会不一致）；「显示全部论证」勾选后低一层排在最前一组；低一层为空时自动显示全部。已有同角色边的论证不出现在对应选择器里；「被用于」的角色下拉里，该对已有的角色不可选，四个角色都有时论证不再出现。空的可选元素（Backing、Rebuttal）阅读态隐藏，因此给它们连边要先进入编辑态。画布拖拽连边：松手后在落点弹出角色选择（`RoleChooser`，非模态，Esc 或点外部关闭），松手在自己身上被拒并提示，同角色已存在的选项禁用；不受按层过滤影响。移除边：面板里每条关系的 × 按钮。
- **出处**：每条出处是显示文字加可选跳转目标。目标先选该 Work 的一个 Doc；共享 IR 的 Doc（LaTeX/文本）再从**该 Doc 现有的结构**里选章节、图、表或带编号的公式（`api/doc-structure.ts` 读 `/api/paper/:id/ir`，没有额外计算或存储），PDF Doc 填页码（上限为页数）。选了位置而文字为空时自动填 `Section 3.2`、`Figure 4`、`Table 2`、`Equation 7`、`Page 5`（`autoSourceText`，不用 `§`）；保存时文字仍为空也会补上。只选了 Doc 没选位置的出处存为纯文字。结构读不出来时仍可只写显示文字。不在该 Work 里的旧目标 Doc 也保留并标出。
- **未保存草稿与离开保护**：唯一的未保存状态是面板的草稿（新建的论证，或表单被改过）。切换论证、关闭面板、返回文献、再点「新建论证」、点清空都先问（`window.confirm`，与 PDF/文本 Doc 的离开确认同一做法）；离开页面时登记工作区的离开守卫 `registerWorkspaceLeaveGuard(guard, "library")`——带视图范围的守卫只在离开该视图的窗格时发言，窗格管理器因此对 `library` 窗格的切换视图/关闭也走 `confirmLeave(view)`（此前只有 `doc`）；浏览器的后退/前进离开 `#argument/…` 时 Shell 同样询问，被拒则把 URL 推回该图；关闭标签页走 `beforeunload`。未改动的新论证不算草稿。同时有多个 Library 窗格时守卫是页面级的，关另一个 Library 窗格也会问。页面上下文（Copilot）不标记草稿：`ArgumentPage` 是 strict 且已写进持久化的 Copilot 历史，本票不改它。
