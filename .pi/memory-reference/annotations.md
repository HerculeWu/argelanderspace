# 文档标注：现行数据与交互细节

状态：现行专题；Stage 8 于 2026-09-12 关闭，reader epoch 于 2026-09-14 完成并获用户 smoke 确认，整理于 2026-09-16。来源：Stage 8 定稿/MS landed、epoch-review D1–D9/F6 与已执行 v2，持久原文见 history。**三态及错误分支、归档权限、全局删除语义权威在 [契约](../memory/contracts-and-decisions.md)**，本文件细化 schema/实现，不维护另一版安全规则。

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

部分 rm 失败可能留 ghost 条目（I002）；no-op DELETE 仍广播。前端确认“该文档及其 N 条标注将永久删除，此文档将从所有关联文献条目中移除”。删除后 workspace applyDocDeletion 显式三态并更新 papers，而非依赖仅启动 fetch 一次的 Shell 自动刷新。

## CLI annot 冻结契约

`annot <doc_id>` 直读磁盘、自算 fingerprint，不走 HTTP、不触发 ensure 写归档。match 输出 current JSONL；mismatch 隐藏旧标注，stdout 零行、exit 0、stderr 固定：

```text
note: document content changed since its annotations were written; they are archived and not shown
```

该文案含 archived 是已冻结措辞，不代表 CLI 真的归档；server 下次访问才归档。零 annotations stdout 空且无 hint。unknown doc 复用 error+候选列表；其余 error: <msg>、exit1。corrupt IR 不带路径是已记录既有 helper 形态。

每行键序冻结：

`id, doc_id, target, context, body, created_at, updated_at, link`。

排序：文档阅读序，document 在前，与 web sortAnnotations 同序（500轮对拍）。先物化全部输出行再打印，坏 target 不得先吐半份输出。

- target 直接用存储 contract，不新造 agent target。
- context 按类别提供：document 只有 title；section/float 走 section_id+section_path；text/paragraph/list 另带完整 canonical container_text。不能为所有类型伪造相同字段集。
- equation/figure/table/code/algorithm 完整正文由 show 读取，section/full doc 由 read；annot 只告诉 agent 用户在何处留了什么意见。
- link `/doc/<doc_id>#ann-<annotation_id>`，端口链沿用 env > config >8000。
- archive 不暴露。未来迁移若需访问必须另立 sanctioned CLI surface；skills 不准直接读内部 current/archive JSON 代替接口。

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

用户 smoke 手册仍在 `docs/manual-test-stage8.md`（用户验收文档，不是新记忆目录）。历史截图 `/tmp/stage8-smoke`、`/tmp/ms4-probe` 不保证仍可访问。Stage 8 已关闭，旧“待 smoke”不再有效。
