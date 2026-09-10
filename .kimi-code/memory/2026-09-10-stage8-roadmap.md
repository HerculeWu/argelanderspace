# Stage 8 定稿计划：文档标注（annotations）（2026-09-10 grilling 三轮 + 收尾修正 4 点拍板，用户确认"达成共识"）

> **恢复指南**：本文件自足。前置读 `2026-09-01-product-and-architecture.md`、`2026-09-01-pitfalls.md`。起点 = Stage 7 关闭后的 main（`7550bd5` 之后）。

## 状态

**2026-09-10：MS4（文本选区 + 重叠高亮引擎，最高风险面）landed `9546fc0`。** `textmap.ts` offset↔DOM Range 原语（内容对齐文本节点、math=`.katex` 根/cite·xref=`.chip` 原子段、cap-label 不可映射、`ContainerMismatch` 防御）+ `TextAnnotations.tsx`（选区捕获/原子归一/浮动工具条/点击命中/多条选择器/跨容器拒绝 toast）+ `highlights.ts`（CSS Custom Highlight 逐标注注册、重叠 alpha 叠深、active 52%+priority 提级、无 API 全降级、正文 DOM 零改动）+ gutter 计数 marker（1→popover，>1→chooser）。真实 Chrome CDP 探针实证（playwright-core 缺席，Node24 内建 WebSocket 直驱；截图 `/tmp/ms4-probe/shots/` 8 张：重叠叠深/cite 内起选原子扩展/选择器/reload 重建/跨段拒绝）。对抗审查 1 阻断已修——**409 document-changed 把打开中的文本创建目标静默转成结构标注**（target 类型替换，§1 不可变哲学违例）→ 文本目标遇 epoch 翻转直接关闭 + toast"请重新选择文本"；N1 cap-label 钳制改拒绝（pointToOffset null + 捕获层 toast 双层）、N3 浮动 UI 双轴钳制、审查探针上游化。复核 APPROVE（revert 实验证明 pin 有效）。模糊测试：2080 组 offset 对 round-trip 全等。测试 web 190→248（3× 全套零 flake），四门全绿。存照：selbar-y 钳制在 happy-dom 下零 rect 恒过（pin 无牙，真 rect 探针已实证）；`.ann-edge` 尾巴选区延展到 canonical 末（设计内，注释在案）。

**2026-09-10：MS3（web 标注 CRUD shell，不含文本 range）landed `45bbcd4`。** `api/annotations.ts` + `AnnotationStore`（三态 409/500 UX、WS 按 doc_id 过滤、404 容忍）+ 右栏 `引用 | 标注` tab（默认引用/徽标/不抢焦点）+ 结构标注八类 hover 边钮 + 边缘 marker/outline + popover（滚动重锚、IME 守卫）+ 文档级标注 + `#ann-<id>` 深链接 + RefDetail 删除按钮/确认框 + workspace 三态迁移（`applyDocDeletion` 纯函数 + Shell 接线）。对抗审查 **0 阻断 / 8 非阻断全修**（编辑草稿遇 document-changed 归档态保全——editSession 快照 + 禁存；重试快照从当前 IR 重建；busyRef 前置堵双击窗口；ListView 无效嵌套改 wrapper div；DELETE 404 自闭合+reload；审查探针 11 例上游化入套件；计时器清理/delBusy dep）；flake 根治（深层根因 = deeplink 测试 mock 的 clearPendingAnchor 不清致 openView 无限 effect 循环——openView 改幂等 + Harness 语义化，10× 单文件 + 3× 全套零失败）。复核 APPROVE。测试 web 145→190，四门全绿。审查存照：reader 在 library.changed 后不重取 IR（既有缺口，重摄入后屏幕仍是旧 IR——snapshot 重建因此目前只是形式正确）；归档 banner 文案在外部删除场景措辞欠准（cosmetic）；删除确认框句末"。"保留（排版自然）。

**2026-09-10：MS2（server REST + 文档删除）landed `b586d61`。** `GET/PUT /api/paper/:doc_id/annotations`（ensureCurrent 访问路径归档、409×2/500、annotationLock、put/invalidate 广播）+ watcher 第三指纹（per-doc current.json，archive 不观察）+ `DELETE /api/paper/:doc_id`（全局摘除 + 位置递补 + 即广播）+ `DocMutationRegistry` 生命周期互斥（upload 提交即 pin / refresh 全局 pin 保守拦全部 DELETE / DELETE tryBeginDelete 同步抢位 / 双向 409）。顺手修 MS1 存照：assetContentHash 穿越守卫。对抗审查 1 阻断（submit/spool 提交期失败 pin 永久泄漏两处——job 已 terminal 仍 409 永锁）已修（submit try/catch 直释 + waitFor 钩子上移至 spool 写前 + refresh pin 入 try），复核 APPROVE（无双重释放、好路径无回归）。测试 server 94→135、core 263→266，四门全绿。审查存照（后续 MS 注意）：annotations rm 失败的部分删除会留 ghost library 条目至下次 rebuild（手册记一笔）；GET ensure 在锁外可双归档（-N 后缀兜底无数据丢失）；no-op DELETE 也广播；watcher 会对被删 doc 的 current.json 消失发 external（MS3 web 须容忍）；chmod 失败注入以 root 运行时无效（用 file-where-dir 技巧）。

**2026-09-10：MS1（contracts+core）landed `a01e84c`。** contracts `annotations.ts`（target 三型 union + canonical text 纯函数 + AnnotationsFile + WsAnnotationChanged）+ jobs union + web ws.ts 显式分支编译修复（Stage 4 MS1 同类问题如约出现）；core `annotations/store.ts`（plans 范式 store + canonical projection/fingerprint 含 asset 内容 hash + `ensureCurrentAnnotations` 三态幂等归档 + 字节原样 archive）。对抗审查 2 阻断全修：①`literatures/` 并非整体 gitignore（定稿前提有误）→ 补 `literatures/annotations/` 规则；②archive 经 zod round-trip 丢外部编辑器未知键 → 改 `readFileSync` 字节拷贝（schema 校验仍在归档前 gate）。复核 APPROVE。测试 contracts 30→51、core 209→263，四门全绿。审查存照（MS2 注意）：`assetContentHash` 缺 `/images` 式路径穿越守卫（MS2 路由须 `badId(docId)` 类校验后再调 store）；corrupt-store 测试可补 archive 目录不存在断言；canonical text 放 contracts 而非定稿字面的 core（web runtime 只依赖 contracts，MS6 记录）；figure chartType/content 未入投影（MS6 补记）。

**2026-09-10：设计 grilling 完成（三轮 Q1–Q20 全锁定 + 用户终稿修正 4 点）。** commit/执行进度随 milestone 追加在本节。

## 产品定位（用户原话收敛，勿再扩张）

- 标注 = 阅读器中一层**独立用户数据**，属于**具体 doc**（不属 work）。一个 work 可关联多个相互独立的 doc（arXiv 正文/发表稿/补充材料/订正稿/自留稿件），可指定主 doc、可删除 doc；**系统不判断 doc 间关系，不提供版本管理**。
- 标注 = **目标位置 + 标注内容**；高亮只是视觉表现。文本标注允许任意重叠。
- 标注只要求在其所属 doc **当前内容**中成立；不承担跨 doc / 跨重摄入的自动迁移。原位替换 → 整批失效归档；想留旧标注就把旧稿保留为独立 doc。未来可由用户显式触发的 agent migration skill，不属本阶段基础设施。
- 阅读器完整 CRUD 闭环不依赖 agent（webui 独立应用原则）。agent 接口 Stage 8 **只读**，不引入自动问答/编辑执行/评论线程/团队协作。
- 未来论文编辑可复用同一挂靠机制（标注 = 给 agent 的修改意见，完成后删除，操作日志归未来 agent workflow）；协作 comments 未来可在 annotation 上扩展作者/状态/线程。数据模型留扩展余地，**当前一律不提前实现**。

## 硬约束（沿用 Stage 6/7）

- **agent 侧既有输出字节冻结**：`search/read/show/ref/note/label/list` 命令面、markdown token、`bib`/`ref` JSON、深链接格式逐字节不变；golden `.md` 不重冻继续当守卫。**新命令 `annot` 的输出自诞生起进入冻结面，一次设计到位**。
- 不做：跨重摄入自动 re-anchor、逐条失效置信度/隐式 migration、文档版本管理、跨进程 filesystem lock。

## 锁定决策（三轮 Q1–Q20 + 终稿修正 4 点合并）

### 1. 数据模型（contracts `annotations.ts`，zod）

- annotation = `{id: a_<8hex>, target, body, created_at, updated_at}`。**无 kind/color/tag/status/author**（Q4；纯 highlight 若未来高频再后兼容放宽）。
- body：Markdown + LaTeX 数学；保存校验 `body.trim() !== ""`，但**存原始字节不 trim**（保 Markdown/code 空白）。
- 不可变性：target/snapshot/created_at 创建后 immutable（改挂靠位置 = 删旧建新）；`updated_at` 仅在 body 字节实际变化时 bump（打开/关闭/跳转/排序不动）。
- **target 三型**：
  - `{type:"document"}`——整篇自由标注。
  - `{type:"structure", id, kind, snapshot}`——kind ∈ section|paragraph|list|equation|figure|table|code|algorithm（不叫 "block"：section 不是 IrBlock）。**reference 不支持**（Q5：无产品需求，勿因 ref-N 有 id 顺手扩）。
  - `{type:"text", block, container, start, end, quote}`——`container` 结构化 union：`{type:"content"}` | `{type:"caption"}` | `{type:"list_item", index}`；`start/end` = 该 logical container 的 **canonical annotation text 的 UTF-16 code-unit offset**（对齐 JS string 与 DOM Text Range 坐标系）；`quote = canonicalText.slice(start, end)`。
- **canonical annotation text 规则**（core 单测锁死）：text 段原样；math → `$<latex>$`；cite/xref → **reader 实际可见文本的确定性拼接**（与 Stage 6 per-ref chip 最终可见字符串逐字节一致）。math/cite/xref = **atomic segment**：选区进入其内部时创建期自动扩展到完整 segment，绝不保存 KaTeX 内部 glyph/chip 内部 DOM offset。
- 允许文本锚的容器：paragraph content、list item、figure/table/code/algorithm 的 caption（有 segments 时）。equation body、code/algorithm body、tableBody、section heading **仅结构锚**。跨 logical container / 跨 block 选区 **v1 拒绝 + 明确提示**（大范围需求走结构标注）。
- **snapshot**（structure target 内嵌、创建时快照、不截断——未来 migration 的参考输入）：section `{number?, heading}`；paragraph `{text}`；list `{ordered, items: string[]}`；equation `{number?, label?, latex}`；figure `{number?, label?, caption?, footnote?, asset_hash?}`；table `{number?, label?, caption?, footnote?, table_body?, asset_hash?}`；code `{number?, label?, caption?, lang?, body?}`；algorithm `{number?, label?, caption?, body?}`。figure 不复制图片字节只存 hash；不为 migration 建文档版本存档。
- quote/snapshot 职责（Q9 锁定）：UI 显示"当时标了什么"、agent 上下文、archive/未来 migration 输入；**绝不用于 Stage 8 自动重定位/逐条校验**。

### 2. 存储（plans 范式）

- 路径：`literatures/annotations/<doc_id>/current.json` + `literatures/annotations/<doc_id>/archive/<ts>-<fp8>.json`。**不写进 `<doc_id>.json` render IR**（标注是用户数据，与摄入产物分离）。
- current = `{version, rev, content_fingerprint, annotations[]}`；pretty 2 空格；zod 双端校验；tmp+rename 原子写；rev 乐观锁（**新 fingerprint epoch 的 rev 从 0 重启**——故 PUT 必须双校验，见下）。
- archive 文件名：`YYYYMMDDTHHmmssSSSZ-<oldFingerprint8>.json`（如 `20260910T084530123Z-a1b2c3d4.json`；**UTC、3 位定长毫秒**、字典序可排序、文件系统安全；极端碰撞加 `-2`/`-3` 后缀，**绝不覆盖已有 archive**）。archive 内容 = 旧 current 原样。
- `literatures/` 整体在 .gitignore 内，annotations/ 天然覆盖。
- REST 粗粒度 `GET/PUT /api/paper/:doc_id/annotations`（单用户足够；CSRF guard + 专用 annotationLock，不与 libraryLock/planLock 互堵）。

### 3. 内容指纹（fingerprint）

- 目的唯一：判断"annotation-addressable rendering 是否还是创建时那份内容"，不是判断论文语义版本。
- **canonical projection**（core 定义规则；asset bytes 由带 doc directory 的 helper 读取，不强求纯 `fingerprint(ir)`）：按文档序遍历，每节点贡献 id↔内容绑定——
  - section：`id + level + number + heading`
  - paragraph：`id + canonical segments`
  - list：`id + ordered + 各 item 边界 + canonical segments`
  - equation：`id + number + label + latex`
  - figure：`id + number + label + caption + footnote + figure asset 内容 hash`
  - table：`id + number + label + caption + footnote + tableBody + fallback image 内容 hash`
  - code/algorithm：`id + number + label + caption + body`（code 再含 `lang`）
  - **排除**：`source`、顶层 `title`/author metadata、refsManifest、bib、references、citationsByBlock、imgWidth/imgHeight（provenance/显示事实变化 ≠ 正文替换；reference 非 annotation target）。注意 section tree 内 heading **在** fingerprint 内，排除的只是顶层 meta/title。
- 算法 SHA-256。`content_fingerprint` 存 current.json；创建/PUT 时记录当前值；读取时比对。
- **三态硬规则（终稿修正 4：原样保留，勿压缩成一句 fail-closed）**：
  1. **fingerprint 成功且相同** → annotations 正常有效；
  2. **成功但不同** → 确定的文档替换：归档 current、建绑定新指纹的空 current；
  3. **无法计算** → 系统错误，**绝不当 mismatch**：保留全部用户 annotation 原状，不归档/不删除/不重写 current/不广播 invalidate。
  - doc 不存在 → 404，不碰 annotations；
  - IR JSON 损坏/schema 无效 → 500 / CLI exit 1，不碰 annotations；
  - current.json 损坏/schema 无效 → 500 / CLI exit 1，**绝不静默 reset**；
  - IR 无 `imgPath` → 正常"无资产"，canonical 中写明确 null/absence，不算失败；
  - IR 声称有 `imgPath` 但 asset 丢失/不可读/hash 失败 → fingerprint 失败 → 500，不碰；
  - archive 写入/rename 失败 → 原 current 必须保持，返回 500；
  - **特殊中间态**：旧 current 已成功入 archive、但新空 current 创建失败 → 用户数据已安全在 archive，返回 500；下一次访问允许重建新 current。**只有新 current 完整建立后才广播 `invalidate`**。

### 4. 失效归档语义与触发

- mismatch → 该 doc **全部** current annotations 一次性失效，原样移入 archive（不可见），reader 从空 current 开始。**不做逐条 salvage、不判断"这条碰巧还在原位"**。同内容重摄入（指纹不变）→ annotations 保留。
- **authoritative trigger 只在 server 访问路径**（终稿修正 1 收窄）：server `GET`/`PUT` annotations 前调同一个幂等 `ensureCurrentAnnotations(docId)`。**CLI `annot` 不触发归档**（见 §6）。watcher 只做变化通知、不承担归档写操作（IR 写入不是 annotation-aware transaction，避免竞态/半写状态）。未来可在 ingest/job 完成的确定性边界 eager 调同一 helper，Stage 8 非必需。
- archive 对正常 reader 不可见、Stage 8 不对 agent 开放。

### 5. PUT 双校验与冲突语义

- `request.fingerprint != 当前 doc fingerprint` → ensureCurrent 先完成归档 → **409 "document changed"**，前端重取并提示"文档内容已变化，旧标注已归档"；绝不接受旧 payload。
- fingerprint 相同但 rev 不同 → **409 rev mismatch**，前端重取并提示"标注已在其他位置更新，已重新载入"。
- fingerprint 计算失败 → **500**（基础设施错误），前端显示错误并保留当前 UI，不得假装 reload 成功。

### 6. CLI / agent 接口（Stage 8 只读，纯增量）

- 新命令 **`annot <doc_id>`**（commander `registerAgentCommands` 加注册；直读磁盘 `annotations/<doc_id>/current.json`，不走 HTTP）。
- **真只读**（终稿修正 1）：CLI 自算 fingerprint——match 正常输出；**mismatch 时不返回旧 annotations、不改任何文件**，stdout 保持空 JSONL + stderr 一条固定 note（文档已变化、旧标注当前不可用）；正式归档由 server 下次访问完成。不存在 CLI↔server 跨进程 TOCTOU 写面。
- stdout = JSONL，每行一条 current annotation，文档阅读序（document-level 在前），冻结字段：
  `{id, doc_id, target, context:{section_id, section_path, container_text}, body, created_at, updated_at, link}`
  - `target` 用存储 contract 原样，不另发明 agent target；
  - text → `container_text` = 所在 paragraph/list-item/caption 完整 canonical text；paragraph/list 结构标注 → 完整 target text；section → 仅 path/heading（全文走既有 `read --section`）；equation/figure/table/code/algorithm → id/kind + snapshot（完整内容走既有 `show`）；document → context 仅 title（全文走 `read`）。**annot 的职责 = 告诉 agent 用户在哪留了什么意见；论文内容读取继续由已冻结的 read/show 完成。**
- `link` = **`/doc/<doc_id>#ann-<annotation_id>`**（新深链接，指到标注本身而非只到 block）。端口链沿用 `ARGELANDERSPACE_PORT` > config > 8000。
- 零 annotations → stdout 空（零行 JSONL，无 hint）；unknown doc → 既有 `error:` + 候选列表模式；其余错误 = `error: <msg>` + exit 1。
- skills：`argelander-read-paper/SKILL.md` 命令面表格加一行 + `skills/README.md`、根 `README.md` 命令表登记。**skill 不得直读内部 JSON 文件**（"CLI 是唯一 sanctioned interface"原则）；未来 migration 需要 archive 时另增正式 CLI surface（如 `annot --archive`）。

### 7. Web 阅读器

- **三入口**（Q5）：文本选择 → 轻量浮动工具条"添加标注"；结构 → hover 时块边缘 annotation 按钮（paragraph/list/section/equation/figure/table/code/algorithm 全覆盖——`BlockView` 通用分发 + 每块 `data-block-id`，零特殊成本）；整篇 → 标注面板顶部"添加文档标注"。**无右键菜单**。
- **右栏 tab `引用 | 标注`**（Q7/Q17）：三栏骨架不动、不加第四 aside；默认仍"引用"；"标注"带数量徽标；创建后不自动展开/切 tab（反馈 = target highlight/marker + popover 已保存态 + 计数即时更新）。列表按文档序、document-level 置顶；条目 = 目标摘要 + body 预览；点击 jumpTo + flash。
- **编辑**：popover（点正文高亮/结构 marker 打开）与右栏条目双路编辑/删除；body 编辑器复用 `mdWithMath` + `lib/math.tsx`（TaskDrawer NoteBody 模式：textarea ↔ mdWithMath 视图）。
- **重叠可视化**（Q6）：**CSS Custom Highlight API** 做 range painting，**不修改正文 DOM**（不用嵌套 span——`[0,10]` 与 `[5,15]` 真任意重叠 + math/cite/xref 独立 DOM 共存）；重叠处加深 + 正文边缘 marker/数量；点击多命中区弹小选择器列出全部命中；active annotation 提高视觉优先级。结构标注用边缘 marker/outline，**不整段涂黄**。
- **selection 引擎**（Stage 8 最高风险面，MS4 独立里程碑独立审查）：selection 捕获 → logical-container 限制 → canonical UTF-16 offsets → atomic segment 归一 → offset ↔ DOM Range 映射（显式做成测试充分的 selection primitive）→ Custom Highlight 渲染 → reload/deeplink 后重建 ranges → 真浏览器 smoke probe。
- **annotation 深链接** `#ann-<id>`：web 解析 annotation → 跳 target → 激活 highlight/structure marker → 打开 annotation；unknown/deleted/archived id 维持 unknown-anchor 哲学（不跳转、不搜 archive、不自动迁移）。
- **ws.ts dispatch 必须加显式 `annotation.changed` 分支**（Stage 4 MS1 else 分支误发阻断 bug 先例）。

### 8. 文档删除（Stage 8 补建，生命周期配套，不扩成版本系统）

- 新端点 **`DELETE /api/paper/:doc_id`** = **全局物理删除**（终稿修正 2）：删 `output/<doc_id>/` + `annotations/<doc_id>/`（current+archive）→ **扫描 library 全部 works 摘除该 doc_id**（一个 doc 可经 identity merge 出现在多个 work 的 doc_ids；`pruneMissingDocs` 也是全库遍历先例）→ 各 work 剩余 `doc_ids[0]` 自然成主 doc → 立即广播 `library.changed`。
- 确认框文案："该文档及其 N 条标注将永久删除，此文档将从所有关联文献条目中移除"。
- **删除 × 摄入并发**：server 已知同 doc 的 upload/ingest job 处于 queued/running → DELETE 返回 **409 "document busy"**，不等待；反向 DELETE 执行期间同 doc upload 不得写入（实现可用 doc mutation registry / lifecycle lock；**MS2 专门审查此并发面，不得仅靠 libraryLock 假设**）。CLI 另一进程与 server 同时 mutate 同一 doc = **不支持的操作边界**（跨进程 locking 不做，记入手册）。
- **web workspace 显式三态迁移**（不能等刷新：Shell `papers` 仅启动时 `fetchPapers()` 一次）：删非 current doc → currentDoc 不变；删 current 且该 work 有剩 → 切到该 work 删除后的新主 doc；删 current 且无剩 → `currentDoc = null` 显示现有空态；同时主动更新 workspace paper list。`library.changed` 负责其他 library surface 同步，不替代删除动作的本地 transition。
- CLI 删除命令不做。

### 9. 执行流程

沿用 Stage 4–7：每 MS 实现 → 四道门（`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`）→ subagent 独立对抗审查 → 双过自行 commit（不逐次问）；全部完成后用户 smoke（`docs/manual-test-stage8.md`），通过后 push + memory 收尾。

## Milestone 切分（Q14 修订：web 拆两个 MS）

- **MS1 contracts+core**：`contracts/src/annotations.ts`（文件/target schema + `WsAnnotationChangedSchema`，WS schema 同居本文件照 plans 先例；`jobs.ts` union 加成员；`index.ts` re-export）+ `core/src/annotations/store.ts`（load/save 原子写、`a_` id、纯 CRUD、canonical annotation text、canonical projection + fingerprint（含 asset hash helper）、`ensureCurrentAnnotations` 幂等归档纯逻辑）+ 单测（模板：`plans-store.test.ts` / `plans.test.ts` 三件套）。
- **MS2 server + 文档删除**：`GET/PUT /api/paper/:doc_id/annotations`（双校验 409×2/500）+ annotationLock + `annotation.changed` 广播 + watcher 第三指纹（只盯各 doc `current.json`）+ server.ts 接线 + **`DELETE /api/paper/:doc_id`**（全局摘除 + busy 409 + lifecycle 互斥）+ server 测试（模板 `plans.test.ts`/`watch.test.ts`）。**并发面专项审查**。
- **MS3 web annotation CRUD shell**（不含文本 range）：`api/annotations.ts` + ws 接线 + 右栏 `引用 | 标注` tab + Markdown+math 编辑器 + document/structure 标注全闭环（hover marker/popover/编辑/删除/徽标/jumpTo）+ `#ann-<id>` 深链接 + RefDetail 删除按钮与确认框 + workspace 三态迁移 + 测试。
- **MS4 text selection + overlap 引擎**（最高风险，独立 diff 独立审查）：selection 捕获、container 限制、canonical UTF-16 offsets、atomic segment 归一、offset↔DOM Range primitive、CSS Custom Highlight、任意重叠、重叠点击选择器、gutter marker/count、reload/deeplink 重建、专项 web 测试 + 真浏览器 smoke probe。
- **MS5 CLI+skills**：`annot <doc_id>` JSONL contract（诞生即冻结）+ agent 测试（`agent.test.ts` 加 describe）+ read-paper skill 加行 + skills/README + 根 README 登记。既有命令零改动。
- **MS6 收尾**：`docs/manual-test-stage8.md`（关键预期真浏览器预实测）+ memory 四件同步 + known-issues 更新。

## 取证存档（2026-09-10 四路 explore 子代理，直接采信）

- **IR 身份**：`contracts/src/doc-ir.ts`（DocIr zod）+ `tex-ir.ts`（TexDocIr = extend version/source/meta）。7 类 block + 递归 IrSection，**每个 section/block 有持久化 `id`**（`sec-N/p-N/eq-N/fig-N/tab-N/list-N/code-N/alg-N`，`fuse/walk.ts` IdGen 位置计数器——同字节源重摄入可复现，任何增删级联位移）；**segment/list item 无 id 无偏移**；paragraph = `segments[]`（text/math/cite/xref 四型）、caption 有 `captionSegments`、tableBody 不透明 HTML。存储 `literatures/output/<doc_id>/<doc_id>.json`；web 每块带 `id`+`data-block-id`，store 有 blockById/jumpTo/flash。
- **文档生命周期**：无独立 Document 实体，doc = `doc_ids` 成员 + `output/<doc_id>/` 目录（主 doc = `doc_ids[0]` 位置指针）。**删除路径此前不存在**（Stage 7 明示"不做物理删除"）；唯一摘除机制 = rebuild 时 `pruneMissingDocs`（`seed.ts:89-96`，全库遍历）。re-upload 复用同一 `upload-…` docId **原位覆盖**整个 doc 目录（`upload.ts`/`ingestTexZip`）→ 标注键还在锚已漂，失效检测必需。
- **server/CLI/skills**：plans 范式全要素位置——`contracts/src/plans.ts`、`core/src/plans/store.ts`（load/save/CRUD 纯函数签名）、`server/src/app.ts:275-304`（GET/PUT+rev409+planLock）、`watch.ts:69-92`（轮询指纹：library = library.json + 每个 `<doc>.json` mtime+size；**新 sidecar 需加第三指纹**）、`server.ts:95-103`（external 广播接线）。WS = 全双工 `/ws` 非 SSE；新消息进 `jobs.ts` 的 `WsServerMessageSchema` union + web `api/ws.ts` 显式分支。CLI agent.ts 直读磁盘（无 HTTP）；输出约定（JSONL stdout/stderr 分工、`error:`+exit1、unknownMsg 候选、docLink 端口链）。`read --manifest refs` 的 `context_before/after` 是"锚点+上下文"先例。
- **web 阅读器**：`DocPane.tsx`（DocWorkspace 三栏；Shell papers 仅启动 fetch 一次）、`Reader.tsx`/`Block.tsx`（每块 `data-block-id`）、`segments.tsx`（cite/xref chip；**无任何文本选区处理代码**）、`store.tsx`（IntersectionObserver reading band、jumpTo+停稳校正+flash、blockById）、左右 panel 固定宽可收 rail（非 tab）、`mdWithMath.ts`+`plan/TaskDrawer.tsx:262` NoteBody 模式（标注编辑器直接镜像）、CSS = 两份全局样式表（无 tailwind）。

## 推后事项 / 已知边界（本阶段勿做）

- agent 创建/修改/删除 annotation；annotation migration skill（含 `annot --archive` 等 sanctioned surface）；协作 comments/threads/resolved/作者字段；论文编辑工作流。
- 跨块/跨容器文本选区；右键菜单入口；reference 条目挂靠；纯 highlight（无 body）标注；kind/color。
- CLI 文档删除命令；跨进程同时 mutate 同一 doc 的 locking（单用户操作边界，手册明示）。
- **orphan annotations**：用户绕过删除入口手动 `rm -rf output/<doc>` 时其 `annotations/<doc>/` 成为孤儿——不自动清理，保留为潜在恢复或未来显式迁移能力的原始数据；**Stage 8 不提供访问保证**（终稿修正 3：不写成"未来 migration skill 的输入"既成事实）。
- watcher 未来如要 eager archive：只在 ingest/job 完成的确定性边界调同一 `ensureCurrentAnnotations` helper，不让 generic watcher 承担归档写。
