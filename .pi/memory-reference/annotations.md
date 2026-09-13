# 文档标注：现行数据与交互细节

状态：现行专题；Stage 8 于 2026-09-12 关闭，整理于 2026-09-13。来源：Stage 8 定稿终稿四修正及 MS1–MS6 landed。**三态及错误分支、归档权限、全局删除语义权威在 [契约](../memory/contracts-and-decisions.md)**，本文件细化 schema/实现，不维护另一版安全规则。

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

- GET/PUT `/api/paper/:doc_id/annotations`：server 访问前 ensureCurrentAnnotations，PUT fingerprint+rev 双校验。CSRF guard、独立 annotationLock，不与 planLock/libraryLock 混堵。
- 文档替换 409 document-changed 与同 epoch rev 冲突 409 区分；系统错误 500 保 UI，不冒充重取成功。
- PUT 立即广播 annotation.changed（put），完整新 current 建立后才可 invalidate；watcher 第三指纹只盯 per-doc current mtime/size，archive 不观察，不负责归档。
- GET ensure 当前可锁外双归档，文件名兜底无覆盖（I008），不要因此扩写成强事务保证。
- 外部删除 current、删除 doc 也会触发 external；web 按 doc_id 过滤，404 missing 清空容忍，不报假错误。

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
- pending busyRef 防双击，生命周期清计时器；reader 目前 library.changed 不重取 IR（I001），手动刷新才更新正文，不能把 snapshot 重建写成已解决此问题。

## 测试与历史证据

contracts annotations、core annotations store/fingerprint/资产、server annotations/delete/watch/registry、web textmap/highlights/selection/CRUD/deeplink、CLI annot 为主要证据面。Stage 8 2080组 offset round-trip、500轮排序对拍及真实 Chrome 探针已通过；happy-dom 的 selbar-y 零 rect 限制见工程记忆。

用户 smoke 手册仍在 `docs/manual-test-stage8.md`（用户验收文档，不是新记忆目录）。历史截图 `/tmp/stage8-smoke`、`/tmp/ms4-probe` 不保证仍可访问。Stage 8 已关闭，旧“待 smoke”不再有效。
