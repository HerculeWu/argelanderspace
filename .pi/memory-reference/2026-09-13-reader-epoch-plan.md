# Reader / annotations 一致性实施方案（v2，已完成，用户 smoke 通过）

- 编制：2026-09-14T00:05:02+02:00；批准记录：2026-09-14T00:10:05+02:00；实施授权记录：2026-09-14T00:12:59+02:00。用户明确批准方案及保守恢复取舍，随后要求“开始实施”；commit/push 未授权，不命名新的产品阶段。
- 决策权威：[本次 inbox D1–D9](../inbox/2026-09-13-epoch-review-reader-coherence.md)。v2 已执行完成；下文“待批准/未实施/未授权提交”等为编制/审查时描述，当前状态以本头部及 D9 为准，执行进度仅记 inbox。
- 收尾状态（2026-09-14T09:23:37+02:00）：实施、独立源码复审、最终四门与受测真实浏览器验收完成；用户明确要求标记smoke通过并提交推送（D9）。证据及验证局限见同 inbox F4–F6；用户确认不改写成全时序/全浏览器实测。不自动开启新产品阶段；提交推送结果以实际Git为准。
- 初稿经独立只读审查发现两项 P1：恢复预算被 trailing GET 绕过、共享路径强化改变 CLI。v2 由父代理修订，2026-09-14 独立复审结论为 OK with notes：可交付待用户批准，两项方案阻塞解除；不是代码验收或实施授权。
- 已接受的主要取舍：严格一次恢复预算下，无法证明已被当前响应覆盖的重复通知也可能导致手动重试（§3.3/§4.4）；额度用尽后即使曾短暂 ready，后续通知也不自动重读，直到手动重试或切 doc。用户批准时已明确接受这一 UX 成本。

## 0. 状态、依据与范围

- 基线：`main@96d392a`，静态源代码核验；完整阅读正式 memory、全部 inbox、annotations 专题及前轮 context。未读用户数据、未改仓库、未运行测试。本文件不是完成报告或代码执行授权。
- 产品权威：`.pi/inbox/2026-09-13-epoch-review-reader-coherence.md` D1–D6（Q1–Q13 及最后整体确认）。下列函数名、错误码、调度细节是待批准的技术方案，不冒充逐项用户决定。
- 只解决当前 doc 的正文、annotations、实际图片展示与异步交互的一致性。保留现有指纹投影、用户 annotation 字节保护、归档权限、CLI 冻结；不做版本管理、历史图片、migration、资产 watcher、跨进程锁或删除事务修复。
- 验收范围已确认：代码四门及真实浏览器。实施、commit、push 均需另获授权。阶段交界可提醒整理记忆；当前 inbox 两份、正文约 13.3 KB，未达体量提醒阈值，不自动归并。

## 1. 已核实的断点与推荐路线

当前两条独立读取链：`DocPane → fetchPaper → /ir`，以及 `AnnotationProvider → GET annotations → ensureCurrentAnnotations`。后者重读 IR 并哈希资产，前者没有关联证明。`Promise.all`、相同 docId、mtime、随机图片 URL 都不能填补这个缺口。

代码证据：

- `server/src/app.ts:278–380`：IR GET / annotations GET 分离；PUT 有双校验但响应只有 annotation file。
- `core/src/annotations/store.ts:238–507`：投影与 ensure 全同步；现有 assetContentHash 只返回 hash；若另遍历资产构建 manifest 会制造二次读取竞态。
- `server/src/doc-mutations.ts`：writer 从提交到终态持 pin；全局 refresh pin 是为阻止 DELETE 与 library rebuild 冲突，注释明确 rebuild 不写 doc 目录。
- `server/src/app.ts:615–687`：upload ingest 横跨 await，目录并非原子替换；仅让 coherent read 同步不能防止读到 writer 暂停期间的部分产物。
- `web/src/annotations/AnnotationStore.tsx`：GET/PUT 直接 setFile，409 用旧 lookups 重建 structure snapshot；必须删除此恢复路线。
- `DocPane.tsx` 加载/失败早返回卸载 reader；`AnnotationPopover`/`AnnotationEditor` 草稿局部存活；`store.tsx` 同 doc 更新保留 refs，也保留了旧 jump 校正/undo。
- `Block.tsx`、`RefCard.tsx` 经 `FigureImage.tsx` 展图；必须覆盖正文、table fallback 和右栏预览，不能只修主图。

**推荐：现有 annotations GET 的 opt-in coherent representation + 同步具体文件系统读取 + web 单一会话协调器。**

不推荐分离 IR/annotation 后客户端猜关联；不推荐缓存历史快照；不推荐先引入异步通用存储 adapter / transaction 框架。同步方案沿用当前 core 实现，只在短临界段读当前文件，最容易证明单 server event-loop 的一致性。其阻塞成本是明确风险，不能宣称跨进程文件快照。

## 2. 服务端最小接口与读取证明

### 2.1 Wire shape

保留旧 `GET /api/paper/:doc_id/annotations` → 原 `AnnotationsFile`，不添加 wrapper，不改变旧 PUT 成功/409 shape。

新 reader 使用：

```ts
GET /api/paper/:doc_id/annotations?coherent=1
// Cache-Control: no-store
interface CoherentAnnotationsRead {
  version: 1;                 // 此 representation 的版本，不是 IR 版本
  ir: DocIr;
  file: AnnotationsFile;      // file.content_fingerprint 即此 IR/资产投影 hash
  assets: Array<{ imgPath: string; sha256: string }>;
}
```

`ir.docId` 必须等于路由 docId。manifest 只列 IR figure/table 声称的资产路径，确定性去重；缺 imgPath 不造资产条目，投影仍明确 null。`assets` 是响应元数据，不写入 current/IR、不纳入新的 hash 项。无需第二个冗余 fingerprint 字段或随机 epoch token。

同 fingerprint 不等于相同完整 IR：title/meta/尺寸等在现有投影外。因此即使 fingerprint 未变也接纳 coherent 响应中的新 IR；`rev` 只用于同 fingerprint 的 annotation 写入排序，不能作为正文版本。

### 2.2 Core 内部 seam

建议保留所有 CLI 正在使用的公开函数签名/行为；增加一个供 server 使用的具体入口：

```ts
ensureCurrentAnnotationsWithDocument(dataDir, docId, opts?): {
  ir: DocIr;
  assets: AssetDigest[];
  file: AnnotationsFile;
  invalidated: boolean;
}
```

该入口内部按下列顺序一次执行，中途无 await：

1. `loadStoredDocIr` 读取/校验一份 IR；server 新读取入口必须在任何 ensure/归档前校验 `ir.docId === route docId`，不匹配按坏 IR 返回 500，current/archive 零变化。不得顺手给 CLI 公共入口添加这一新 gate。
2. 以同一份 IR 遍历**原样投影**；调用私有 filesystem asset reader，按路径 memoize 一次 `readFileSync` 的 hash。
3. 从这些**已经实际参与投影的相同读取结果**形成 manifest，再 hash 原投影 JSON。不是先算 fingerprint 再读资产建 manifest。
4. 基于计算结果执行现有 ensure 三态分支并返回 IR/file/manifest。

公共 `docContentProjection` / `docContentFingerprint` 与新入口共用同一私有纯 projection 算法和底层实际字节读取代码；但 server 新入口的强化路径前置检查必须与 legacy 公共入口分开。legacy 继续保持既有路径规则、symlink 行为、读取次数和错误形态；server 新入口采用强化前置检查和单次读取 memoization。私有闭包可用于传入该差异，不导出可插拔 `StorageAdapter`，也不假造第二个存储 adapter。legacy ensure 不能简单委托强化后的新入口；二者共用三态决策/归档逻辑，但前置读取保留各自兼容性。不导出能接受 HTTP 客户端任意 fingerprint 并归档的 interface。

投影数组顺序、canonicalSegmentsText、null/absence、字段排除规则完全不改。稳定普通文件下，新旧函数输出必须逐字节相同；新 server 入口的 memoization 不改变纯 projection 的 hash 定义。更强的 server 校验不能泄漏到 CLI：新增稳定 symlink、缺图错误文案和正常输出的冻结回归，而非仅断言 CLI 源码未改。asset reader 的 Buffer 只在本次计算生命周期使用，不保留历史图片。

### 2.3 必要的 writer/deletion 安全门

新增 `DocMutationRegistry.isDocumentContentBusy(docId)`，只检查 `writers.has(docId) || deletions.has(docId)`；**不调用现有 isBusy**，因为它把全局 refresh 算进去。

annotations GET（旧形状也一样）、PUT 在真实执行 ensure 的同步临界段入口检查此门：busy 返回 `409 {detail:"document busy"}`，不读 partial IR、不 ensure、不归档、不保存、不广播 invalidate。PUT 的检查必须在 `await req.json()` 和 `await annotationLock` 排队之后，而不是只在请求开头。

建议 GET/PUT 都走已有 annotationLock，回调内保持 `busy check → read/hash → ensure → optional PUT checks/save` 全同步。这明确同步访问顺序，但**不是以修复已证实双归档 bug 为理由**：I008 在该基线未找到单 event-loop 可交错证据，不宣布修复。检查到回调结束无 await，writer pin/DELETE claim 无法中途插入；无需为同步读另造读锁。

为什么 refresh 不拦：rebuild 只读 output、改 library，refresh GET 常发生在重建通知之后；复用全局 refresh pin 会把无正文写入的任务也变成长期读阻塞。writer pin 已覆盖真正 upload，不需放宽它。queued writer 也保守拒绝 coherent access，即使尚未写；这是避免随后任务链半成品误归档的最小安全提案。

busy 是暂不可用而不是 document-changed 或 missing。前端立即停止标注并保留文字/草稿；提示任务进行中，可手动重试；不轮询。可利用现有成功 upload 在 unpin 后发出的 library.changed 做一次唤醒读取。sync upload /失败 job 未必有可靠的 unpin 后通知：不把恢复依赖猜测的事件时序，保留手动重试；如补自动唤醒，只能在实际释放最后 writer pin 后发一次非归档通知，并测试失败/submit/spool/finally，不引入新后台 watcher。这是可选 UX 优化，不是安全门前提。

### 2.4 三态、归档及失败保真

- 算成功且相同：保留 current；不存在 current 时保持现有 ephemeral 空 file、第一次 PUT 才落盘。
- 算成功且不同：合法性 gate 后将 current **原始 bytes** archive，建新空 current，rev 0；只有新 current 完整建立才发 invalidate。
- 无法计算：系统错误，不是 mismatch。doc 真不存在 404；IR JSON/schema 坏 500；current JSON/schema 坏 500；有 imgPath 但缺图/不可读/hash 失败 500；全部不得修改 current 或广播 invalidate。busy 优先，避免把进行中的删除/摄入中间态误判为真 404。
- 无 imgPath 是正常 absence，不是 fingerprint 失败。
- archive 写入/rename 失败：原 current 不动，500；保留 collision `-N`，不覆盖 archive、不经 zod round-trip 重写旧字节。
- archive 已安全建立但新 current 创建失败：500，不 invalidate；下一次访问允许恢复。本基线 archive 是复制原字节，旧 current 通常仍在，重试可能多份 archive；不得把它描述为已经必然移走 current，也不借本任务改删除顺序。
- PUT 保持 fingerprint 优先、rev 次之的双校验；500 不伪装成成功 reload。archive 权威只在 annotations GET/PUT；图片端点、watcher、IR GET 不 ensure。

## 3. 实际图片字节与 display epoch

### 3.1 一个具体 filesystem 验证读取

在现有 `/images` 两种路径增加 opt-in `?sha256=<64hex>`；无参数的 legacy 使用者维持原行为。两个路径共用实际 reader，不能只有其中一个校验。

验证路径：docId/path 合法性 → bare filename 映射 assets/，多段为 doc-relative → containment 校验 → 读取完整 Buffer → SHA-256 比较 expected → **仅返回该次已比较的 Buffer**。不能先 hash 路径再 `readFile()` 发送第二份 bytes。成功和所有错误均 `Cache-Control: no-store`；错误不返回图片 payload，不返回 304；不接受随机 query 作为有效验证。

至少拒绝反斜杠、空段、点段/前导点、路径穿越；验证 resolved realpath 在 doc 根内、目标 regular file，拒绝 symlink 逃逸（可选择逐段拒 symlink，保持实现具体）。同一强化前置校验用于新的 server manifest hash reader 与 opt-in 图片读取；不更改 CLI 公共 fingerprint 的 legacy 校验/错误路径。静态 traversal/symlink 防护要测试；恶意外部进程在检查间换文件不在跨进程保证内。

建议错误分类：非法输入 400；hash mismatch 409 `asset changed`；missing asset 404；读取失败 500；writer/deletion busy 409 `document busy`。该路径不计算整篇指纹、更不归档。若 async read 跨 await，返回前可重查 busy，但正确性的核心仍是返回 Buffer hash 校验，不能靠两次 busy 检查宣称锁定整个读取。

### 3.2 Web 验证展示组件

`FigureImage` 不再从当前路径直接展示；传入 `{imgPath, expectedSha256, displayGeneration}`，通过具体 hook/小组件获取受校验 URL：

1. IntersectionObserver 按需触发 `fetch(...sha256=..., {cache:"no-store", signal})`。
2. 非 200 不生成 img src；成功将响应 bytes（可客户端再验 SHA-256，加强缓存/代理错误防御）转为 Blob URL。
3. 只有请求捕获的 `(docId, displayGeneration, imgPath, hash)` 仍等于当前 **ready** representation，才允许把 Blob URL 接到 `<img>`。
4. 状态进入 syncing/error/missing，**render 当次即改为占位**；不等 effect 才撤旧图。abort 请求、revoke URL；迟到的 fetch/decode/onLoad 无权重新展示。

Blob 是当前展示资产的临时载体，不是历史快照缓存。成功 coherent response 可以先恢复文字/标注，未加载图片保持占位；不要求整篇资产下载。DOM 图片必须总能追溯到接纳 manifest 的 hash。正文图、表格 fallback、引用卡预览、暗色分类/canvas 都走该路径。分类缓存不要用不断增长的 Blob URL 作永久 key，改为 hash 的有界缓存或组件局部状态。

占位保留 IR width/height/aspect ratio；没有尺寸时保留已测 box 或原 CSS fallback。更新失败继续占位并显示不可用，不能退回原 pathname。网络/解码失败同样不得展示未验证图片。

### 3.3 一次自动恢复的预算

首次**当前 generation** 的资产 mismatch：整篇转 syncing，隐藏所有图片/高亮，消耗一次预算，追加一次 coherent GET。多张图同时报错只消费一次；过期 generation 的报错无作用。恢复 GET 失败，或恢复后再遇 mismatch，进入 terminal error，手动重试前不再自动 GET。

**调度优先级：terminal latch > 资产恢复预算 > 普通通知 dirty/trailing 规则。** 首次 mismatch 开启 recovery episode 并消耗唯一追加 GET 额度；在该 episode 中，WS、trailing GET、busy 唤醒、另一张图报错全部共用这一额度，不能从别的入口追加 R2。

若 R1 期间收到通知，现有消息无法证明它已被 R1 覆盖，故不发 trailing GET、不悄悄忽略通知：转 terminal error，保留旧文字/草稿，等待手动重试。R1 后才到达的通知在预算已消耗时同样不能再自动读取。R1 自身 ensure 发出的 invalidate 和随后 watcher external 也不例外；首版不添加通知版本/correlation 协议。

预算跨 fingerprint/generation 和组件重挂载保存；只有显式手动重试或切换 doc 重置。也就是说，首版采用“从首次图片 mismatch 到手动重试/切 doc”为同一保守 episode，不能仅凭短暂 ready/WS 开启新额度。这是待批准的技术取舍，不冒充 Q13 已指定的 episode 定义。

**明确代价：** 典型 A 图变 B 导致 R1 归档并自发 invalidate 时，很可能需要手动重试，无法承诺这类资产变化总能自动恢复成功。安全和严格预算优先；若产品要求更高自动成功率，应先重新设计可验证的通知覆盖信息，不在实施时偷偷忽略通知或放宽预算。

## 4. Web 统一会话、异步接纳与 UI 状态

### 4.1 所有权与最小接口

新增 `web/src/doc/ReaderSession.tsx`（或等价命名）在 DocPane 内、StoreProvider 外，按 docId 建会话。它拥有 coherent read、状态机、GET/PUT 接纳、失效调度、图片恢复预算、草稿。DocPane 不再调用独立 fetchPaper；AnnotationProvider 不再独立 GET/订阅 WS/setFile。

```ts
type Phase = "initial" | "ready" | "syncing" | "error" | "missing";
interface ReaderSessionState {
  phase: Phase;
  accepted: CoherentAnnotationsRead | null; // syncing/error 留最近成功正文
  generation: number;                      // 本地生命周期，不是内容 hash
  reason?: "busy" | "read" | "asset" | "document-changed";
  drafts: SessionDrafts;
}
// 对内部消费者暴露：state, canAnnotate, requestSync(reason), retry(),
// persist(next, capturedGeneration), reportAssetFailure(binding, kind), draft actions
```

`canAnnotate = phase === ready && !writePending && !refreshPending`，同步 ref 守门防同 tick 双击/旧闭包。AnnotationStore 保留 byBlock、active、popover 等 UI API，但 file 与写入交由 session；禁止出现第二套可独立接受 annotation 文件的状态。

Provider 组合改为 `ReaderSession → StoreProvider(accepted.ir) → AnnotationProvider → DocWorkspace`；移出 store.tsx 里隐式嵌入的 AnnotationProvider，避免环依赖。首次无 accepted 才显示空 loading；同 doc 自动更新/失败保持 Reader `<main>` 与旧文字树，不用 fingerprint key 强制卸载。草稿始终在外层，即使内部必须重挂载也不丢。

### 4.2 状态转移

| 事件 | 状态与动作 |
|---|---|
| 进入 doc | initial，GET coherent；无旧正文 |
| GET 成功且可接纳 | 原子接纳 ir/file/assets，ready，重建 lookups 和高亮 |
| library.changed / 本 doc annotation.changed | 合并到一次 sync；旧文字保留，立即冻结交互/隐藏高亮图 |
| PUT document-changed | 不接纳响应 file 为正文证据；保存草稿，清 target，转 sync，GET coherent |
| 同 epoch rev conflict | 保留用户文字，sync 重读；不自动覆盖/重发草稿 |
| coherent GET 500/网络/协议错误 | error，旧文字/草稿保留、图片占位、标注禁用、手动重试 |
| busy | syncing/不可用提示；普通同步可由后续通知唤醒或手动重试，不轮询。若已消耗资产恢复额度则 terminal error，不再自动唤醒 |
| coherent GET 明确 404 | missing，文档不存在，不显示旧正文为当前可读 doc；草稿保留可复制 |
| 当前图第一次 mismatch | 消费预算后一次自动 sync |
| 自动恢复失败/再次 mismatch | terminal error，重复 WS 不解除锁存 |
| doc 切换/unmount | abort reads、废弃迟到响应、释放 URL/timer；不承诺跨 doc 草稿持久化 |

### 4.3 GET/PUT 竞态：单飞行与 generation 双守门

建议不要把复杂并发留给 rev 比大小：**同一会话的 GET 与 PUT 由协调器串行调度**，server 端仍独立防外部客户端冲突。

- 每个请求捕获 doc session token、generation、requestId；切 doc、手动 supersede、terminal 状态使旧 response 无效。AbortController 仅节约资源，接纳门才是正确性保障。
- 稳态准备写入时抓取已接纳 `fingerprint + rev + generation`。创建目标也保存 generation。同步 invalidation 一发生即禁止新的写，不能等下一次 render。
- PUT pending 时收到通知：立即转 syncing 并标 pending refresh，等待 PUT settle 再 GET；不要假设 abort PUT 能撤销服务端已落盘写入。迟到 PUT 成功可以确认其操作已保存，但不能把旧 epoch 页面变 ready；其 file 只在仍属于 ready 的同 fingerprint/generation 且无待刷新时更新 annotations。
- GET pending 不允许 PUT。普通通知同步中，GET 完成时有读取期间通知则保留 syncing，再执行一次合并后的 trailing read；资产恢复 episode 优先执行 §3.3 的严格预算，无额度时进入 terminal 而非 trailing read。不会让旧 GET 覆盖刚完成 PUT。
- rev 只用于绑定写请求及其冲突，不充当读取版本。最新、通过 session/requestId 接纳门的 coherent GET 是权威：即使同 fingerprint 的 current 被外部删除后变为 rev=0，也合法接纳。旧响应凭请求时序拒绝，不能用“同 fingerprint 低 rev 一律拒绝”阻止合法重置。不同 fingerprint 不凭 rev 数字大小排序。
- `PUT 409 document changed` 的 file 只能用于提示冲突，不能用于重建 targets 或恢复高亮；唯一 ready 入口是 coherent GET 或仍与既有 ready IR 绑定的同 epoch PUT 成功。

### 4.4 重复 WS / 自己 GET invalidate 的收敛

无需新增服务器历史 revision/token：现有 watcher/WS 是失效提示，不是 epoch 证明。

**本段仅描述未进入资产恢复 episode 的普通通知同步；§3.3 的预算和 terminal latch 始终优先。** 使用一个 active request 加一个 dirty/pending bit，而不是每条通知增加一次请求或立即 abort 重开：开始 GET 前清 dirty；GET 期间通知只设 dirty；完成后至多排一个 trailing GET。只有内容真实 mismatch 才由 ensure 发 invalidate，后续 stable GET **不写 current、不发 invalidate**。因此 `GET invalidate → 一次 trailing GET → watcher external → 最多再一次 stable GET` 必然静止；多次 put/external 信号同理合并。不得把“每次 GET 成功”再当 invalidation 事件。

这是有限真实通知下的收敛证明，不保证持续外部写入时立刻 ready。请求失败锁存 error，dirty 丢弃，不因为旧 WS 又自动重试。busy 的后续有效通知可唤醒；terminal asset/read failure 只手动重试。测试必须覆盖 `invalidate` 在 GET 响应前到达、external 在响应后到达，不能只模拟一次干净 library.changed。

## 5. 草稿、target、定位与布局

- `SessionDrafts` 最小分离：创建 `{body}` 与可选当前 target binding；编辑 `{annotationId, sourceFingerprint, originalBody, body, blocked}`。只在 React 会话内，不用 localStorage/sessionStorage/IndexedDB。
- 编辑器改 controlled body，输入即时写外层；popover 关闭、旧 annotation 不再存在或内部树卸载不销毁受保护的更新中草稿。提供独立“保留的草稿”区域，可复制/明确丢弃，不能只把 inaccessible state 留在内存。每次提交捕获 draft revision 与 body；PUT 成功只清理仍与本次提交版本相同的草稿，提交后用户继续输入的文字不能被迟到成功清除。
- sync 开始清 selection、chooser、active、marker/flash、pending create target；创建 body 保留，新 ready 后必须重新选目标并由用户显式“使用保留文字”。不得自动恢复 structure/document target，也不得将 text 转 structure。
- document-changed 后编辑草稿标 blocked，即使 annotation id 碰巧重用也不能解锁或自动迁移。相同 epoch 普通刷新若 annotation 仍存在且 body 未被外部修改，可恢复编辑；外部 body 改变则保留冲突草稿并要求显式处理，不自动覆盖。
- 失效前先捕获旧 main 的 scrollTop；替换 DOM 前再次取用户更新期间的最新 px 位置。取消旧 jump timer、flash timer、smooth scroll、undoTop，并使旧 observer/RAF 回调受 generation gate。
- 新 DOM 布局提交后用 layout effect 做一次 clamped px 恢复；保留主容器及图 box，提示位置可能变化。不找“原段落”或 re-anchor；用户 wheel/touch/key 接管后不再延迟拉回。
- 深链接 ordinary/ann 都等 ready 再消费 pendingAnchor；sync/error 不提前 clear。ready 后执行一次；unknown/archived id 静默，不查 archive。新显式深链接优先于默认 px 恢复，防同一布局帧互相拉扯。
- canAnnotate 统一覆盖 selection toolbar、结构边钮、整篇按钮、保存/删除、列表定位、marker、popover chooser、高亮注册及 ann 深链接。Store jump/undo 在更新期也冻结，避免 TOC/xref 触发旧位置校正；普通文本阅读/手滚保持可用。

## 6. 文件级实施顺序与里程碑

### M1 — 服务端关联读取与数据保护（先可独立验收）

- `contracts/src/annotations.ts` 或独立 reader-coherence contract + index export：新增 coherent wire schema/type，不改 AnnotationsFile/Annotation/DocIr 数据 schema。
- `core/src/annotations/store.ts`、core exports：共用原投影，具体 asset reader/memoization/manifest，新增返回同份 IR 的 ensure 入口。
- `server/src/doc-mutations.ts`：content-busy 查询；不改 DELETE 原 isBusy 含 refresh 语义。
- `server/src/app.ts`：GET opt-in shape、GET/PUT 同步临界段 busy check、错误映射、no-store。
- 新 core/server 单测；保留 legacy/CLI golden。出口条件：全失败矩阵无误归档，manifest/hash 相同读取证据，旧 API shape 回归。

### M2 — 受校验图片通路

- core/shared 私有 filesystem asset helper、server 图片路由：同 Buffer 校验后发送，路径 containment，no-store。
- `web/src/api.ts` / 新具体 image fetch helper；`FigureImage.tsx`、`Block.tsx`、`RefCard.tsx`：按 manifest hash 加载、Blob 展示、占位、代际清理。
- `annotations/model.ts`：创建 figure/table snapshot 从当前 manifest 取 asset_hash，移除额外非绑定 fetch/withAssetHash race；不更改既有 annotation 字段。
- 出口条件：A hash 永不显示 B bytes；所有图片 surface 覆盖；不经图片访问归档。

### M3 — 会话协调器及交互整合

- 新 `doc/ReaderSession.tsx` + reducer/controller；`api/annotations.ts` 加 coherent fetch/busy 分支；`DocPane.tsx` 采用统一读链。
- `store.tsx` 调整 provider 组合、取消 navigation/observer 生命周期 API；`AnnotationStore.tsx` 移除独立读链/409 重建。
- `AnnotationPopover.tsx`、`AnnotationEditor.tsx` controlled drafts；`TextAnnotations.tsx`、`AnnotationsPanel.tsx`、结构入口及样式加入统一 gate。
- `lib/deeplink.ts` / DocPane effects 只在 ready 消费；保留当前深链接格式。
- `api/ws.ts` 不必改 wire schema；必要时只调整订阅接入，所有相关通知归 session 单一入口。
- 出口条件：真实 IR A→B 自动切换；旧 targets 永不写入新屏幕；GET/PUT/WS 任意受测乱序收敛，失败草稿可见可复制。

### M4 — 对抗回归、四门、真实浏览器

先跑定向测试，再四门，最后真实 Chrome/Chromium synthetic fixture smoke；报告运行/跳过/失败，不重冻 agent golden。方案批准后才实施，实际用户数据验收另获授权。

## 7. 失败与竞态测试清单

全部新 fixture 使用临时 dataDir 和合成/仓库测试 IR，不扫描真实 literatures。

**Core / server**

1. 旧 projection 固定 golden hash + 新旧函数 parity；各投影内字段改变 hash，各排除字段不变；新 server manifest 与同 Buffer hash 一致，相同路径多 block 使用一次读；可控 mock 在“若再读”时换 bytes，证明没有双读。CLI legacy 单独覆盖正常输出、缺图错误原文、稳定 symlink 到 doc 外文件的既有行为，防 server 强化校验泄漏。
2. match/mismatch/null current、rev reset、PUT 双校验；未知键及空白/换行 raw archive 字节相等；碰撞不覆盖。
3. missing doc、corrupt/schema-invalid IR/current、无 imgPath、有路径缺图/不可读、hash/归档/tmp/rename/new-current 写失败各自断言 HTTP 状态、current/archive 精确变化及 invalidate 次数。故障用稳定 fs mock/file-where-dir，不靠 root 下 chmod。
4. writer queued/running，在 ingest await 间暂停、IR/资产半替换时 GET/PUT 返回 busy，archive/current 零变化；完成释放后正常读；失败/submit/spool/sync finally 不漏 pin。
5. DELETE 已 claim 的读返回 busy，完成后 404；refresh-only pin 不阻塞 coherent read，仍阻止 DELETE。PUT 排队期间新 writer pin 生效，回调处复查生效。
6. GET opt-in 和旧 shape；同投影不同 title/尺寸 coherent 返回新 IR；并发 GET 不宣称历史 I008 已修，只断言在支持模型下幂等。
7. 图 A/B 替换：expected A 返回 A 或拒绝，绝不 B；校验后路径替换仍发送已校验 Buffer。裸路径/多段 route、traversal、编码穿越、symlink 逃逸、缺图、busy、invalid hash、no-store/no-304；图片读取不触碰 annotations。

**Web deterministic async**

8. 用 deferred promises 控制 GET A、通知、trailing GET B、PUT settle 的顺序；旧 doc 响应、旧 generation 图响应和错误全部忽略。fingerprint A rev100 → B rev0 正确；同 fingerprint 删除 current 后最新 coherent GET rev0 正确接纳；迟到旧响应按 requestId 拒绝，不按 rev 大小猜时序。
9. PUT 成功之前/之后通知、PUT 409 新 file 比 IR 快到、rev conflict reload 失败：无一用独立 file 恢复 ready；禁止自动重发保存。
10. 首次 GET invalidate、重复 external、自写 put 和 library.changed 风暴：最终 stable，断言请求数量有界、无持续 effect loop；5xx 后重复通知不越过 terminal。
11. 真正替换 IR 文本/id/figure 内容，不只改 fingerprint mock；新 structure snapshot/text selection 源于 B。
12. 自动 sync/500/409/组件重挂载均保留创建和编辑 body 原字节；旧 target 清除，新选位不自动粘贴，显式使用才带入；编辑跨 fingerprint 禁存，raw body/IME 行为不回归。
13. sync 当帧移除 CSS highlights/markers/图片，保留正文 DOM；lazy 初始不请求全图；同时多图 mismatch 一次恢复，第二次/失败 terminal；旧 decode/onLoad 不复活图片；Blob revoke/classification 清理。必须覆盖完整序列 A→图片 B→mismatch→R1 ensure invalidate（响应前）→watcher external（响应后），断言自动追加 GET 总数恰为 1，无 R2/R3，转手动重试状态；测试 WS、trailing、busy 唤醒均不能绕额度。无通知的 R1 成功路径也单独覆盖。
14. deep link 在 sync/error 保持 pending，ready 一次执行；未知 ann 静默；旧 jump/undo/timer/observer 不再动作。

**真实浏览器（不可用 happy-dom 替代）**

15. 当前 reader 打开合成 doc A，模拟正常 server 上传/受控通知替换 B，验证无需 F5 正文、caption、IR lookup/annotation snapshot 同步。
16. 长文非零滚动、图片延迟加载、正在 smooth jump/undo 时更新：保留旧文字和 box，移除高亮与图；更新后 px 尽力保留，不被旧定时器拉回；用户滚动优先。
17. 实际 CSS Custom Highlight 重叠、选区/弹层、IME、失败草稿恢复、两种深链接；截屏/DOM assertions 和请求记录证明，不用零 rect 测试声称布局通过。
18. HTTP 缓存预热旧 URL、同路径换图、滚到晚加载图、正文/表格/预览图同时显示，核对实际 blob bytes/hash 与 accepted manifest；两次变图停止自动恢复。离线/500/404、删除中 busy 的可见文案和手动恢复。

四门命令保持：`corepack pnpm -r build`、`corepack pnpm -r test`、`corepack pnpm -r typecheck`、`corepack pnpm lint`。冻结 CLI annot/旧 agent 输出必须原样回归，不改 CLI 源码，不重冻其 markdown golden。

## 8. 残余风险与明确不承诺

- 同步全资产 hash 增加每次 coherent GET 的 CPU/I/O 和 event-loop 阻塞；现实现已全量 hash，本次不加 watcher/缓存历史。通知合并缓解重复成本，不以 stat 缓存替代资产内容证明。
- doc writer pin 是 server 已知生命周期门，不是文件系统事务。CLI/外部进程并发改同 doc、恶意检查间替换不提供保证；单独手改资产无通知不承诺立即发现，lazy 请求遇 mismatch 才检测。
- no-history 意味着老图不能在 sync/error 保持展示；旧文字/布局的 best effort 不是像素或语义定位承诺。
- hash 与原投影绑定，不是论文版本号；被排除元数据改变应仍重渲染，不能用 fingerprint 相同跳过 coherent IR 接纳。
- 失败 ingest 留下合法但语义不完整的最终产物，pin 释放后仍可能形成新 fingerprint；本任务不能判断“这次编译产物是否用户期望”，不改摄入事务。
- DELETE 部分失败（I002）、orphan annotations、跨 doc draft 恢复不在本轮范围。busy 恢复遇无终态通知可能需要手动重试，不得隐藏为无限加载。
- SVG 若包含外部资源依赖，hash 主文件不等于依赖闭包 hash；现管线自包含 SVG 假设应以真实 fixture 验证，发现非自包含资源时 fail closed 或另提范围，不能悄悄扩展 fingerprint。
- 自动恢复 episode 采用 §3.3 的保守定义和统一预算；busy 自动唤醒只允许普通同步，不绕过已消耗额度。此取舍须随方案一并批准，不能边实施边悄悄改变。

## 9. 架构与审查交接

- **module / depth**：server 隐藏同份 IR/hash/manifest 与归档读取顺序；web 隐藏会话调度、状态切换和草稿存活。不是把 app.ts 或 AnnotationStore 按行数拆文件。
- **seam / adapter**：一个具体文件系统读取路径，server 专属校验前置层与 legacy 行为明确分开；这不是两个可替换存储 adapter，不以测试名义泛化假想 seam。
- **locality / leverage**：理解一次正文替换有一个状态入口；同组用户行为测试同时约束正文、标注、资产、草稿与定位。
- **deletion test**：删除调用方的独立 IR GET、annotation GET/setFile、旧 lookup snapshot 重建和散落恢复时序后，行为仍由共同 module 保证才算通过。**the interface is the test surface**：保留真实读取/提交/通知/图片展示测试，不能只剩 reducer 单测。
- 独立初审：workflow `c8cf4af7-03b5-44f3-9ffa-cd5e45b53732`；draft child `40a2483c-1678-47a3-84e7-2c4395c20bb4`；review child `3d9ee2e8-30a9-4c24-8f65-6cf66fb5ad5c`。产物位于 harness session 的 `subagent-artifacts/outputs/c8cf4af7-03b5-44f3-9ffa-cd5e45b53732/epoch-plan-{draft,review}.md`，均 completed。
- 初审结论 BLOCK 的两处 P1 已在 v2 由父代理逐条修订，附带三项补强：draft revision 清理、同 fingerprint 合法 rev0、docId 归档前校验。复审 run `b9c61e1e-13f7-4d7e-b908-990c111f0f78` 于 2026-09-14 completed，OK with notes；明确严格预算的持续手动重试取舍仍须用户接受。恢复审查输出写入同一 `epoch-plan-review.md`，当前该产物是复审文本；初审发现与处理链已记录在本方案及 inbox F3。
- 本轮仅产生方案与 inbox，未实现/运行测试、未修改真实用户数据，未 commit/push。后续先批准方案，实施与提交授权分别明确。
