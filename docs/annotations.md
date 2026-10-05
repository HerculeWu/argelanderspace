# 文档标注：现行数据与交互细节

状态：现行专题；Stage 8 于 2026-09-12 关闭，reader epoch 于 2026-09-14 完成并获用户 smoke 确认。2026-09-21 从 `46093915:.pi/memory-reference/annotations.md` 迁移，未改产品语义。来源与持久原文见 [history](history.md)。**三态及错误分支、归档权限、全局删除语义与 CLI 冻结全文权威在 [契约](contracts.md)**，本文件细化 schema/实现，不维护另一版安全规则。

## Target 与 canonical text

annotation：`{id: a_<8hex>, target, body, created_at, updated_at}`。body trim 非空但存原字节；target/snapshot/created_at immutable，body 字节变才 bump updated_at。

- document：`{type:"document"}`。
- structure：`{type:"structure", id, kind, snapshot}`；kind 为 section/paragraph/list/equation/figure/table/code/algorithm，**reference 不支持**。
- text：`{type:"text", block, container, start, end, quote}`；container 为 `{type:"content"}` / `{type:"caption"}` / `{type:"list_item", index}`。start/end 是该 logical container 的 canonical UTF-16 code-unit offsets，quote 是 slice(start,end)。

canonical 纯函数位于 **contracts/src/annotations.ts**，不是旧草案的 core：web runtime 只依赖 contracts，必须共用。

| Segment | canonical text |
|---|---|
| text | 原样 |
| math | `$<latex>$` |
| cite / xref | 与 reader 实际可见文本一致的确定性拼接（含 per-ref chip 最终文本与分隔） |

math/cite/xref 都是原子段，选区进入内部自动扩展到整个 segment，绝不保存 KaTeX glyph/chip 内 DOM offset。

允许 text target：paragraph content、list item、有 captionSegments 的 figure/table/code/algorithm caption。equation/code/algorithm body、tableBody、section heading 只允许 structure。跨 logical container 或 block 明确拒绝。quote/snapshot 用于“当时标了什么”、agent 上下文及未来显式迁移参考，不做当前自动定位/逐条 salvage。

### Structure snapshot（创建时完整、不截断）

- section：number?、heading。
- paragraph：text。
- list：ordered、items 字符串数组。
- equation：number?、label?、latex。
- figure：number?、label?、caption?、footnote?、asset_hash?。
- table：number?、label?、caption?、footnote?、table_body?、asset_hash?。
- code：number?、label?、caption?、lang?、body?。
- algorithm：number?、label?、caption?、body?。

不复制图片字节，不为 migration 保存文档版本。

## 指纹投影

core `annotations/store.ts` 定义按文档序遍历的 canonical projection，asset bytes 由 doc directory helper 读取，SHA-256。目标是 annotation-addressable rendering 的 id↔内容绑定，不是论文语义版本。

| 节点 | 纳入内容 |
|---|---|
| section | id、level、number、heading |
| paragraph | id、canonical segments |
| list | id、ordered、各 item 边界与 canonical segments |
| equation | id、number、label、latex |
| figure | id、number、label、caption、footnote、asset 内容 hash |
| table | id、number、label、caption、footnote、tableBody、fallback image 内容 hash |
| code / algorithm | id、number、label、caption、body；code 另含 lang |

排除 source、顶层 title/author meta、refsManifest/bib/references/citationsByBlock、imgWidth/imgHeight。section heading 在投影内，顶层 meta/title 不在。figure 的 OCR 遗存 chartType/content 不进投影，是非正文 OCR 事实。IR 无 imgPath 是明确 absence；声称有路径但读/hash 失败是系统错误，按三态规则不能归档。

资产 hash 有 containment 防御（Stage 8 MS2 补），server docId 先校验；CLI 继承本地直读信任模型，不能把路由 badId 策略误写成全 CLI 已有。

## 存储、REST 与 watcher

`annotations/<doc>/current.json = {version, rev, content_fingerprint, annotations[]}`，pretty 2 空格、zod 校验、tmp+rename。新 fingerprint epoch rev 从 0 重新开始。

archive：`archive/YYYYMMDDTHHmmssSSSZ-<旧fp前8>.json`，UTC 定长3位毫秒，如 `20260910T084530123Z-a1b2c3d4.json`。冲突 -2/-3，不覆盖；**拷原字节**保未知键，不能经 zod strip 后重写。

- GET/PUT `/api/paper/:doc_id/annotations`：server 访问路径承担 ensure，PUT fingerprint+rev 双校验。CSRF guard、独立 annotationLock，不与 planLock/libraryLock 混堵。reader 使用 GET `?coherent=1`（见下），旧 GET/PUT 形状不变。
- 文档替换 409 document-changed 与同 epoch rev 冲突 409 区分；系统错误 500 保 UI，不冒充重取成功。
- PUT 立即广播 annotation.changed（put），完整新 current 建立后才可 invalidate；watcher 第三指纹只盯 per-doc current mtime/size，archive 不观察，不负责归档。
- I008 的“锁外 GET 可交错双归档”历史结论证据不足：ensure/archive 同步，未找到单 event-loop 交错路径；现在 GET/PUT 共同锁临界段，不把它宣称为已证实旧 bug 的修复。archive 是拷原字节，新 current 失败后旧 current 通常仍在；重试可能再归档，-N 保不覆盖，不保证恰好一份 archive。
- 外部删除 current、删除 doc 也会触发 external；web 按 doc_id 过滤，最新 coherent GET 可合法接纳同 fingerprint 的 rev0。确定 404 转 missing，不拿旧正文当当前文档，但会话草稿保留可复制。

## Reader 共同 epoch：读取、图片、草稿与接纳

来源：2026-09-13/14 epoch-review 用户 Q1–Q13、v2 批准和实施；原方案/过程在 `3e50860151409eac9269f91bbb4967a50216fe81` 的 `.pi/memory-reference/2026-09-13-reader-epoch-plan.md` 与同日期 inbox。I001 已关闭；这里替代 Stage 8“需 F5 才更新”的旧机制。

### Server 同一次读取证明

- `GET annotations?coherent=1` 返回 `{version:1, ir, file, assets:[{imgPath,sha256}]}`，no-store；ir wire 保留实际 TexDocIr 的 meta/source，file.content_fingerprint 绑定该份 IR/资产投影。manifest 不是写入 IR/current 的字段，不新增投影项。
- `ensureCurrentAnnotationsWithDocument` 同步读取并校验 IR，归档前检查 ir.docId 与路由一致；按**相同实际字节读取**形成投影及去重 manifest，而非算完指纹再读一遍图。单次路径 memoization 不改变原 projection/hash。
- server 新入口/受校验图片前置层强化路径与 symlink 防护；共享纯投影及三态逻辑，但 legacy CLI fingerprint/ensure 的路径、symlink、错误行为独立保留。不能以共享重构让 CLI 悄悄获得新拒绝面。
- annotationLock 回调中的 `content-busy check → read/hash → ensure → PUT 校验/保存` 无 await；PUT 在请求 JSON/排锁后重查。queued/running writer 或 deletion busy → 409 document busy、零 ensure/归档/写盘/invalidate。纯 library refresh 不能误判为正文 busy；它仍保守拦 DELETE。
- 缺 current 时继续允许 ephemeral 空 file、首次 PUT 落盘。其余三态/失败原规则见契约；图片端点/watcher/普通 IR GET 不归档。系统错误不是 document changed，500 不假装 reload。
- 同 fingerprint 仍接纳新完整 IR（meta/title/尺寸在投影外）；不能用相同 hash 短路正文更新。同步读取只证明当前支持的单 server 模型，不是跨进程快照。

### 受校验资产与严格恢复额度

本节与 server 同步读取边界共同记录 **I032（已接受）**：无资产 watcher/历史图、有同步 hash 成本、不提供跨进程事务；恢复额度用尽后允许要求手动重试。新的性能/自动恢复需求须获批准后重议，不将这些边界当成 I001 尚未修复。

- 两种 `/images` 路径的 `?sha256=<64hex>` opt-in：containment/realpath/regular-file 等校验后读 Buffer，比较预期 hash，**发送被比较的同一个 Buffer**；不二次 read、无随机 query 替代证明。成功/失败 no-store、不返回 304；无参数 legacy 使用者不因此改行为。
- 非法输入 400、asset changed 409、missing 404、读取失败 500、document busy 409；非成功不返回可展示图片 payload。不能因图片失败启动归档。
- FigureImage 的所有 surface（正文图、table fallback、右栏预览等）按需获取校验 bytes，Blob URL 绑定 doc/session generation/path/hash；只有 ready 当前代可展示。sync/error 当帧占位，不等 effect；abort、revoke、迟到 fetch/decode/onLoad 代际门，不退回原 pathname。暗色分类缓存不能按不断增长的 Blob URL 无界积累。
- 同一次 coherent 接纳可以先恢复文字/标注，懒加载图片仍占位；不要求全文下载。无历史图片快照，更新失败仍占位，尽力保布局。
- 当前代第一次图失配：隐藏图/高亮、转 sync，只允许 **1 次追加 coherent GET**。这一 episode 内 WS/trailing/busy 唤醒/别张图共用额度；恢复请求期间或之后无法证明已被覆盖的通知也不能再发 R2，而转 terminal 等手动重试。
- 即使恢复后短暂 ready，额度不重置；只手动重试/切 doc 重置。ensure 自发 invalidate、watcher external 不例外。用户明确接受由此造成的手动重试成本；别悄悄忽略通知或放宽预算。
- 不监控资产目录，无现有通知的单独改图不承诺立即发现；实际 lazy 请求可能检测 mismatch。hash SVG 主文件也不等于外部资源依赖闭包，现有自包含资产假设不能偷换成任意外链安全保证。

### Web 单一会话与用户文字保护

- `ReaderSession` 集中拥有 coherent read、file/IR/assets 接纳、initial/ready/syncing/error/missing、generation、预算和草稿。DocPane 不再独立 fetch IR，AnnotationProvider 不再独立 GET/setFile/凭409 file重建新 snapshot。
- GET/PUT 协调串行，请求捕获 session/generation/requestId；abort 仅省资源，接纳门才防旧结果污染。通知先暂停交互；PUT settle 后再 GET，不假设 abort 能撤销已落盘 PUT。迟到成功只能确认保存，不能让旧 epoch 变 ready。
- 普通通知合并 active request+dirty bit，必要时一个 trailing read；稳定 ensure 不写盘/发 invalidate，有限通知可收敛。read failure 锁存、手动 retry；busy 普通同步可由后续有效通知唤醒但不轮询，不绕 asset terminal 预算。
- rev 不作为读取版本：最新 coherent 响应同 fingerprint 的 rev0 可合法接纳；旧请求按时序拒绝。document-changed 的409 file不是 IR 证明，不用它恢复 ready/targets。
- 同 doc 更新/失败保最近文字与 `<main>`，清 selection/active/marker/旧 target，隐藏高亮/图，禁创建/写入/定位/旧 jump+undo。确认共同 epoch 才恢复。滚动按最新用户 px 尽力保留，非语义 re-anchor，用户 wheel/touch/key 接管后不延迟回拉。
- 深链接等 ready 再消费；sync/error 撤原生 id 保 data-block-id，避免浏览器 hash 提前跳。旧 ref 延迟 focus、smooth 校正/observer/RAF 全受代际门，未知/归档 ann 不访问 archive。
- 外层 session 草稿受保护：创建仅保 body，重新选位后**显式**使用；编辑跨 fingerprint 保字节但禁存，id 恰好重用也不解锁。相同 epoch 外部 body 冲突不自动覆盖/重发。
- PUT 成功只清仍对应该次提交 draft revision/body 的草稿，迟到成功不能清用户新输入；discard 同时退出局部编辑态。提供复制/明确丢弃，不只把不可见 state 留内存。
- 保证仅当前页面会话自动更新/失败期间；不承诺 F5/关闭页/跨 doc 恢复，不增加存储或迁移。初始无正文可 loading，明确 doc 404 则 missing、草稿仍可复制。

## 文档删除与 server 生命周期

权威规则见契约。机制：DocMutationRegistry 管 queued/running 与删除排他；upload 提交即 pin，refresh 全局 pin 保守拦全部 DELETE，tryBeginDelete 同步抢位；双向 409，不等任务完成。

Stage 8 MS2 已修 submit/spool 失败 pin 泄漏：submit catch 释放，waitFor 钩子在 spool 写前注册，refresh pin 入 try。新改任务生命周期需审异常路径，不能只看正常 job finally。

部分 rm 失败可能留 ghost 条目（I002，见本地 tracker）；**I020（已接受）**：no-op DELETE 仍广播，watcher 对 current 消失可发 external，web 容忍 404；有可观察实害再改，目前不当作数据丢失。前端确认“该文档及其 N 条标注将永久删除，此文档将从所有关联文献条目中移除”。删除后 workspace applyDocDeletion 显式三态并更新 papers，而非依赖仅启动 fetch 一次的 Shell 自动刷新。

## PDF 工作台标注（新增，与 LaTeX 分离）

PDF 标注写入 `<output>/<doc_id>/annotations.json` 独立 sidecar，不进入原始 PDF、LaTeX `annotations/<doc>/current.json` 或其 archive。contract `PdfAnnotationsFileSchema` 固定版本、Doc、SHA-256 与单调 rev；标注类型封闭为 rectangle、page_comment、document_comment、highlight、underline、strikeout。票 05 启用 rectangle/page_comment/document_comment；票 06 已启用真实 PDF 文字层选择的 highlight/underline/strikeout。文字 target 保存不可变 `quote` 与按零基页分组的 normalized visible-page `rectangles`；多页片段属于同一 `id`、body 和 sidecar array entry。SDK page-space 字形矩形先按各页真实尺寸归一化，再由 metadata rotation 转成可见页坐标；绘制时逆变换到 SDK Rotate 包装层的局部 CSS 坐标。CropBox、异构页尺寸、旋转页各自使用本页几何；viewport、缩放像素或临时文字索引不持久化。扫描页无真实文字矩形时不能创建文字 target，区域/页/篇工具仍可用。PDF 工作台右栏的「选择文字」与「框选区域」是互斥工具模式：选择文字后按住鼠标左键拖动、松开固定真实引擎选区，工具栏点击不改变已确认范围；再按下纸面清除旧选区并可直接拖出新选区。SDK 绘制的页面图像不允许触发浏览器原生图片拖动；取消工具或按 Escape 回阅读模式。已有 Shift+方向键跨页扩选仍可用；纯鼠标跨页拖拽未作为已通过能力宣称。

工作台矩形用 `page_index` 与相对可见页的归一化 `x/y/width/height`，必须有限、正面积、完全位于 `[0,1]` 页界；style 只属于 rectangle。page comment 锚定零基页索引，document comment 不造第零页。body trim 非空但保存原字节；创建时的默认内容按当前创建语言写入，后续编辑不翻译。工具种类、Doc、创建时间与页 target 不随更新改变；PDF Server 对 SHA-256 与 expected rev 双检，content-changed/rev-mismatch/busy 分别是 409，坏 sidecar/元数据/文件为 500，未知 Doc/owner 为 404。有效变更通过同目录原子替换，rev 只增不减；PDF 写入路径不调用 LaTeX ensure/archive，未成功保存不发 `annotation.changed`。

sidecar 是用户数据：读取和写入均验证 schema/binding/真实原件；JSON/未来版本损坏不会被重置。写入时保留当前未知 additive 字段，不经 schema strip round-trip；PDF 内容 hash mismatch 不归档、不重绑、不生成空文件。阅读位置使用独立版本化、SHA 绑定的 `reading-position.json` 与自己的 optimistic rev/原子 rename 写入，不复用标注 revision；滚动保存合并节流，深链接优先，外部标签页通知不驱动当前 Reader 跳动。损坏、未来 schema、缺失及写/rename 错误保留 sidecar 原字节，并以独立位置状态显示，不将已验证 PDF 正文误判为失败。Retry 对响应返回时的当前 pending 位置再做比较，不能拿 GET 前 capture 覆盖 Retry 等待期间的新滚动；newer foreign rev 中只有与用户最新 pending 位置完全一致才可作为已提交确认，否则保留 pending 并报冲突。若先前位置加载本身失败而没有本地 pending，读到合法现存 sidecar 后可恢复其位置，但在深链接/user-input 接管时不得回拉。PDF 内嵌标注仍由原 PDF/SDK 只读显示，不进入工作台 sidecar。

### PDF Reader 导航

PDF 的原生 bookmark 树映射进共享 `TocPanel` 的 `OutlineList`；没有可解析 bookmarks 时显示无目录状态，不以 OCR 或伪造章节补齐。搜索使用 PDF 引擎的真实文字层及 Search plugin；无匹配时说明可能没有文字层，不伪称识别扫描文字。选区复制走浏览器 Clipboard API，只有权限下实际成功才显示已复制，失败明确显示。

Reader 沿既有 `/doc/:doc_id#anchor` 路由格式增加 1-based 页 anchor `#page-N`，annotation anchor 仍为 `#ann-<id>`。PDF anchors 要求该 Doc、SHA与sidecar snapshot接纳后消费；annotation anchors 按sidecar逻辑记录首个有效页片段定位，篇评论只打开对应右栏记录。未知/删除/越界 anchor 不跳到其他 Doc/位置，不读 archive，不写数据。点击 PDF internal destination交给SDK导航；外链只接受绝对 HTTP(S)且无用户名/密码，通过 `window.open(...,"_blank","noopener,noreferrer")`；PDF launch/file/JavaScript/其他 action 不创建点击入口。工作台按 SDK link 的页局部几何与各页 rotation绘制链接命中区，缩放后仍随同页坐标；原件不改写。旧 LaTeX `sec`/float/reference/`ann` deep-link消费路径不变。

Web 对每个已打开 PDF Doc 使用单一 `PdfAnnotationSession` 协调页/篇/矩形/文字操作：expected rev 串行 PUT、工作台本地撤销重做（已提交操作用新 PUT）、正文显式保存、几何/样式手势及文字选择完成后保存。跨页标记整体创建、删除、撤销和重做，target 与 quote 创建后不可变；新的不同文字必须重新选择并创建新标注。本标签页广播的 `annotation.changed` 允许触发校验 GET，但不能在自身在途 PUT 尚未回包时把其新 rev 误作外部冲突；外部冲突须显式重试合并或放弃，不盲目重发；若另一标签页修改了同一字段或待删除标注，本地操作不能覆写它，保留草稿提示复制/放弃。读取失败仍是系统错误，不伪装 rev 冲突。失败队列和后续输入在当前会话保留，关闭通知只隐藏横幅、不清失败或解除离开保护。切换 Doc/会话代际后不接纳旧 GET/PUT 的成功或失败；草稿不跨刷新持久化。PDF 页矩形的 pointer 捕获结束由 Reader 统一提交，鼠标在虚拟化页上被引擎取消时以最后有效预览完成一次，触摸取消则丢弃手势；位置仍存页局部归一化矩形，而非屏幕像素。

Web 每次挂载使用一个按 Doc/固定 SHA-256 绑定的临时 annotation session；它协调创建、删除、矩形几何/样式与显式正文保存，PUT 顺序由上一次成功返回的 rev 推进。几何/样式操作仅在指针手势或控件操作完成后入队，正文 textarea 保持草稿直到点击保存。迟到 PUT/GET 在 session unmount/generation 改变后不能更新新 Reader；同值 `annotation.changed` 是当前 revision 回声时忽略，foreign rev 则清除本地 undo/redo 并保留待提交草稿。Rev 冲突需用户显式 retry（重新读同 SHA sidecar 后按变更字段重放）或 discard，不自动盲写；目标 Doc/hash 不匹配时锁定视图与操作，只有重新验证相同原件 hash 才能恢复。已提交操作的 undo/redo 通过新 PUT 表达，rev 永不回退。离开有未提交内容/失败/请求时用应用内确认和 `beforeunload` 提醒；草稿只在当前页面，不写硬盘/浏览器存储，不承诺刷新恢复。

### PDF 高亮颜色（有限修订）

票 06（2026-09-24）原决定是高亮、下划线、删除线均固定样式。票 14 经 2026-09-24 用户明确批准，**仅 PDF 高亮**在此有限范围内修订：可选持久 `color` 取固定九色预设之一；`color` 不适用于下划线、删除线、区域或评论。无 `color` 的旧高亮保持黄色，不迁移、不在读取时补字段或回写；新工具色仅当前高亮模式的临时选择，退出模式复位黄色；仅主动选了非默认色时在创建时附到一条逻辑标注，默认黄色不写 `color`。右栏已有高亮选色是单次 session mutation，跨页记录整体改色；同有效颜色为 no-op，正常 rev/冲突/失败与 undo/redo 规则照旧。该视觉提示不赋予正文、类型或分类语义，不改变固定 PDF 原件。票 06 的原评论保留历史，不应据此把有限修订扩大到其它文字标记。

PDF 删除确认使用 `GET /api/paper/:doc_id/pdf/annotations/count` 直接读取并校验 PDF 的独立工作台 sidecar；损坏、busy 或 hash 不匹配是未知计数，不借用 LaTeX annotations endpoint，也不将失败冒充零标注。

## Copilot 读取 LaTeX Reader（票 18）

Copilot 的 Reader 页面上下文与 `reader` 工具读同一份 coherent epoch，不改任何数据保护规则：

- 表示由 contracts 的 `buildReaderReading` 构造（纯函数，新编码；旧有损 Markdown renderer 与 golden 不变）：全部节/段/列表/公式/图/**完整表体**/代码与算法体、完整参考文献、cite/xref 身份、当前标注原文及其 fingerprint 与 rev、资产 sha256。文本为 canonical annotation text，选区的 UTF-16 offsets 直接索引其中，math/cite/xref 以 `marks` 标出原子段。`format` 为判别字段，未来 text Doc 以新变体接入，不借用 LaTeX 元数据。
- 浏览器端页面从已接纳的 ReaderSession（IR、file、资产 manifest）构造，不抓挂载 DOM；仅 `ready` 才带正文，syncing/error/missing 不带（保留旧文字只是显示）。选区绑定接纳时的 fingerprint，epoch 冻结即丢弃，页面 schema 拒绝与正文 fingerprint 不符的选区。阅读位置只是提示，经 250 ms 合并后发布。
- 后台 `reader.read` 经 core `readDocumentForReading`：与 coherent GET 同样的同步读取与同样的错误码，但**只读**——不 ensure、不归档、不建新 current、永不读取 archive；指纹不同的旧标注不并入（`epoch.annotations: "stale"`，下次正常访问才归档），无法计算（IR/资产/current 损坏）为明确错误而非 mismatch；queued/running 内容变更时拒绝。
- 容量：整页超出模型窗口时发送被 `capacity` 拒绝，`read` 以其大小整体拒绝，都不截断；按结构分批是票 24。后续页面观察不重复正文，只带 epoch 指纹，需要时 `reader.read`。
- 导航动作（`navigate`/`jump_back`/`set_panel`/`set_right_tab`/`retry_sync`）只投递绑定视图，沿用 jumpTo/锚点/撤销/折叠/重试控制器，Reader 同步或出错时回报 `unavailable`，不改变深链接协议。

## Copilot 写入 LaTeX 标注（票 19）

Copilot 的 `reader` 工具有 `create_annotation` / `update_annotation` / `delete_annotation`，是 Reader 面板、选区工具条、块边按钮、编辑器与垃圾桶的同一业务操作；不新增标注类别、线程、作者、颜色或自动 re-anchor，也不改变存储格式。

- **同一 server 访问路径**：`PUT /api/paper/:doc_id/annotations` 与工具共用 app.ts 的 `commitAnnotations`（原 PUT 临界段的提取，HTTP 入口与响应不变）：同一 annotationLock 内 busy 检查（queued/running 内容变更或删除→409/`rejected`，零 ensure/归档）、PDF 拒绝、幂等 ensure（唯一可归档者，成功建立新 current 后才广播 `invalidate`）、**指纹与 rev 双检查**、原子保存、之后广播 `put`。无法计算指纹/读取 current（IR/资产/current 损坏）是 `AnnotationsError`→HTTP 500／工具 `error`，保留全部用户数据，绝不当 mismatch。工具层不自行 ensure、归档、写 sidecar，也没有读 archive 的参数。
- **每次写入绑定 epoch**：调用必须带规划所依据 `reader` 读取的 `epoch.fingerprint` 与 `epoch.annotationsRev`。指纹不同→`conflict(document_changed)`（本次访问路径可能已按三态归档旧批次，与用户打开该 Doc 相同；写入不落到新文本，返回当前 epoch 让 agent 重读）；rev 不同→`conflict(rev_mismatch)`。冲突后 agent 必须重读再形成新请求，不能只换数字重发。未落盘的页面草稿（创建/编辑）不被覆盖：页面既有逻辑在同 epoch 外部 body 变化、跨 fingerprint 或标注消失时把编辑草稿标为 blocked（保留文字、禁存）；页面上下文 `drafts` 只报告存在与 blocked，不含正文。
- **目标由 server 从已接纳 IR 构造**：document；structure 只给 id（kind 与完整 snapshot 由 contracts `buildStructureTarget` 生成，与 UI 同一实现，figure/table 的 `asset_hash` 仅取同一 epoch 的资产 manifest）；text 给 `{block, container, start, end, quote?}`，由 contracts `resolveTextTarget` 校验：单 container、canonical UTF-16、起止严格落在 math/cite/xref 内部时扩到整段（结果 `widened` 告知，保存的 `target`/`quote` 为准）、`quote` 若给出须等于所给范围的 canonical 切片（防数错偏移/过期选区）。equation/code/algorithm body、表体、节标题、reference 只能 structure 或不可标注，跨 container/块拒绝。创建后 target/snapshot/created_at 不变，update 只改 body，且 body 字节相同为 `noop`、不写盘不广播；删除单条无确认（UI 的垃圾桶同样无确认）；移动＝删旧建新。
- **update/delete 绑定标注自身状态（A06）**：`update_annotation`/`delete_annotation` 必带 `expectedUpdatedAt`（该条标注在 agent 最近一次读取/写入结果里的 `updated_at`，仅 body 字节变化时才变）。即使指纹与 rev 都已是当前值，只要存储的标注 `updated_at` 不同，就 `conflict(annotation_changed)` 并带回当前标注，零写入；agent 必须读用户新写的内容后再决定，不能拿冲突结果里的新 rev 配旧期望重发。text 创建的 `quote` 必填，须等于**所给范围（扩展前）**的 canonical 切片：document_changed 后重发旧偏移时 quote 对不上即 `invalid`，不会静默锚到新文本；原子段扩展语义不变。
- **保留未知键**：agent 写入在同一锁内以磁盘原始 JSON 为底（core `saveAnnotationsFile({preserveUnknown})`）：保留顶层与每条标注（含 target 内）的未知键，只改 body/updated_at/增删条目，合并结果仍过 schema 门。**页面 PUT 的整份替换行为不变**（仍按页面发来的内容、经 schema 重写，未知键不保留）——这是既有 I010 类行为，需用户另行决定，本票不改。
- **重复 id**（手工编辑所致）与页面一致：删除移除全部同 id，更新改全部同 id，首条 body 相同则 noop。
- **归档与错误分支**：访问路径在写入时发现正文已被替换会按三态归档旧批次（与打开 Doc 相同），结果带 `archivedOlder`（条数）与提示，agent 应告诉用户；`archive` 码＝旧批次无法归档、current 原样保留、零写入；`new_current` 码＝旧批次**已归档**但新空 current 未建成（契约的特殊中间态，下次访问重建，不广播 invalidate、不写入本次请求），结果 `error`＋`archivedOlder:true`；损坏的 PDF 元数据＝元数据错误；每个码有各自准确文案，不再套用「图片缺失」。
- **操作记录**：写入记录带 `label`（Doc 标题＋结构 id 或引文）与结果 `rev`，沿用既有记录字段与徽标，无新 UI。
- **展示**：标注 body 现可由 agent 写入，气泡里的 Markdown 用 `mdWithMath(..., {safe:true})`：活性 HTML 与图片显示为文本，仅 http(s)/mailto 链接可点，数学/代码/存储字节不变。（PDF 工作台面板的 body 展示同样改用该安全路径，见下节。）
- **局限**：这三个 LaTeX 动作只用于 LaTeX Doc（对 PDF Doc 返回 `unsupported` 并指向下节的 PDF 动作）；跨进程同 Doc 并发写仍不支持；UI 现无标注撤销，工具也无；`reader.read` 对旧指纹文件不并入标注（`stale`），写入时才由访问路径归档。

## Copilot 写入 PDF 标注（票 21）

`reader` 工具的 `create_pdf_annotation` / `update_pdf_annotation` / `delete_pdf_annotation` / `undo_pdf_annotation` / `redo_pdf_annotation` 是 PDF Reader 面板与工具栏的同一批操作（区域/高亮/下划线/删除线工具、页评论与整篇评论按钮、正文编辑、矩形样式与高亮颜色、垃圾桶、撤销与重做）。不新增标注类别、作者、线程或自动 re-anchor；PDF 字节永不改动，也不走 LaTeX 的 ensure/归档。

- **同一把锁与同一套检查**：写入在 app.ts 的 `annotationLock` 内由 core `commitPdfAnnotationChange` 提交，检查与页面 `PUT /pdf/annotations` 相同：content-busy→`rejected`、原件只读一次并核对不可变 SHA-256、sidecar 对 Doc/hash 的绑定与页范围、期望 rev；`sha256` 或 `rev` 不符→`conflict`（`document_changed`/`rev_mismatch`）且零写入；读不到/损坏的 sidecar 是 `error`，原 bytes 原样保留，不重置、不重绑；成功后才广播 `annotation.changed`（cause `put`）。tool 不读写文件，也不读 archive。
- **窄修改，保留未知键**：以磁盘上 sidecar 原样为底，只替换 `annotations` 与 `rev`（顶层与每条标注、target、矩形、样式里的未知键都保留），合并结果过 contracts schema 后同目录临时文件＋rename 原子替换；未成功落盘不发通知。页面 PUT 的整份替换行为不变。
- **每次写入绑定读到的状态**：`sha256`（`reading.sha256`）与 `rev`（`reading.annotationsRev` 或上一次写入结果的 `epoch.annotationsRev`）必带；`update`/`delete` 另带 `expectedUpdatedAt`（该条在最近一次读取或写入结果里的 `updated_at`，body、矩形、样式或颜色变化时才变）。即使 rev 已是当前值，只要该条已被用户改过就 `conflict(annotation_changed)` 并带回当前内容，零写入；冲突后必须重读再形成新请求，不能只换数字重发。用户未保存的面板草稿不被覆盖或代存：页面既有的「标注在别处改变」提示出现，草稿保留。
- **目标**：rectangle `{pageIndex, rectangle}`（可见页分数，≥0.006、在页内，样式默认同区域工具）；page_comment `{pageIndex}`；document_comment；highlight/underline/strikeout 的 `parts` 每页一条 `{pageIndex, quote, occurrence?}`，quote 必须逐字取自该页真实文字层（`reading.pages[].text`，含换行），页内须唯一或由 `occurrence` 指明，矩形由服务端用 PDFium 在同一已验证原件上按与 Reader 选区**同一算法**（`pdfRectsWithinSlice` 与 `buildPdfTextTarget`，在 contracts，由 web 测试逐字符区间与 EmbedPDF 的 `rectsWithinSlice` 对拍）计算，调用方不能给矩形；跨页是一条逻辑标注，quote 以换行连接、矩形按页分组；无文字层页、quote 不存在/歧义、文字与几何无法对应→`invalid`，不造文字 target。Node 的 PDFium 以「观看后」的页面系（已应用 /Rotate）报告几何，所以此处按旋转 0 归一化，不再按页旋转转第二次（`tests/pdf-text-target-rotation.test.ts` 用 0/90/180/270 四页验证）。
- **与 UI 同规则**：kind、页、文字 target、created_at 创建后不可变；高亮默认黄色（`#ffd228`）不写 `color`，选其它预设才写；矩形样式更新只改给出的字段；`updated_at` 仅在 body/矩形/样式/颜色变化时变，相同内容为 `noop`；删除单条立即生效、无确认（垃圾桶同样无确认）。
- **撤销/重做**：服务内存中按 Doc 保存 agent **自己**经此工具所做更改的历史，规则同面板会话：只有历史留下的 rev 仍是当前 rev 且存储内容与历史一致时才可撤销/重做（用户或其他标签页在其后写过、或文件被手改，历史即结束，工具返回 `noop` 与原因，不覆盖）；新更改清空重做；撤销/重做本身是一次带新 rev 的写入，被还原的原有标注保持原 id/时间，被改回内容的标注 `updated_at` 更新；每 Doc 最多 50 步，服务重启即失。agent 的写入对页面来说是外部 rev，会结束该标签页面板自身的撤销历史（与另一标签页写入同）。
- **展示**：PDF 工作台面板的标注 body 现用 `mdWithMath(..., {safe:true})`（活性 HTML 与图片显示为文本、仅 http(s)/mailto 链接可点；之前直接渲染，粘贴的 `<img onerror>` 会执行）。
- **局限**：内嵌 PDF 标注仍只读且不进集合；跨进程同 Doc 并发写仍不支持；已知既有问题——Reader 自己在**旋转 90°/270° 的非方形页**上用鼠标选文字创建的标注矩形位置不对（页面按可见尺寸归一化，而浏览器引擎几何在未旋转页面系），Copilot 的文字标注不受影响；该 UI 缺陷未在本票修复，另记。

## CLI annot

完整输出、顺序、排序、错误与零写盘契约已集中于 [contracts 的 CLI annot 冻结契约](contracts.md#cli-annot-冻结契约)。修改 agent 输出时必须阅读全文，不以本专题的 server 路径代替 CLI 语义。

## Web 交互与 selection primitive

入口：选文本→浮动工具条；八类结构 hover 边钮；面板顶部整篇按钮。右栏引用/标注 tabs，默认引用、计数 badge；创建不自动展开/切 tab，反馈为 marker/highlight、popover 保存态与计数。

列表阅读序，文档级置顶；点击条目 **jump+flash+激活，不自动开 popover**（MS6 真浏览器核实）。正文高亮/结构 marker 点开 popover，右栏另有编辑/删除；深链接 ann 解析后跳 target、激活并打开，unknown/deleted/archived id 静默，不搜 archive。

- textmap.ts：canonical offsets ↔ DOM Range，对齐文本节点；math 以 katex 根、cite/xref 以 chip 作为原子。ContainerMismatch 防御，不勉强按错 DOM 定位。
- 跨 container 拒绝+toast；cap-label 不可映射、拒绝而不是钳到邻正文；ann-edge 尾选区可延到 canonical 末，这是在案设计。
- CSS Custom Highlight 每标注注册，重叠 alpha 叠深，active 52%且提优先级，正文 DOM 零改动；无 API 全降级，不声称所有浏览器都实测同样涂色。
- 点重叠处多命中 → chooser；gutter marker 计数1→popover，>1→chooser。结构标注 marker/outline，不整段涂黄。
- Popover 随滚动重锚，浮动 UI 双轴钳制，IME guard。409 document-changed 时文本创建关闭+“请重新选择文本”，不能静默转结构标注；编辑草稿保留、禁存。
- pending busyRef 防双击，生命周期清计时器；reader 已按上述共同 epoch 自动更新（I001 关闭），创建 snapshot/文本 target 只使用接纳的 IR/manifest，不能用独立 PUT file 与旧 lookup 拼接。

## 测试与历史证据

contracts annotations、core annotations store/fingerprint/资产、server annotations/delete/watch/registry、web textmap/highlights/selection/CRUD/deeplink、CLI annot 为主要证据面。Stage 8 2080组 offset round-trip、500轮排序对拍及真实 Chrome 探针已通过；happy-dom 的 selbar-y 零 rect 限制见工程记忆。

reader epoch 持久测试涵盖实际 IR A→B、legacy CLI symlink/错误、三态失败矩阵、预算/乱序/草稿和多图 surface；真实 Chrome 正常合成 zip 上传链与17个受测用例证据见历史 inbox F6。CDP composition 不等于 OS IME，全 decode/onLoad 时序未穷举；用户另明确 smoke 通过。不把工具探针错误改写成产品缺陷或声称全程零失败。

用户 smoke 手册仍在 [manual-test-stage8](manual-test-stage8.md)（历史用户验收文档，不是另一套现行契约）。历史截图 `/tmp/stage8-smoke`、`/tmp/ms4-probe` 不保证仍可访问。Stage 8 已关闭，旧“待 smoke”不再有效。
