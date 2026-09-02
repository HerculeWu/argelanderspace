# Stage 4 定稿计划（2026-09-02 grilling 三轮拍板，用户确认开工）

> **恢复指南**：本文件自足。前置读 `product-and-architecture.md`、`pitfalls.md`。起点 = Stage 3.1 关闭后的 main（`9c7d1f3` 之后）。

## 状态

2026-09-02：设计 grilling 完成（三轮 Q1–Q17 全锁定，用户确认"达成共识"，定稿写入本文件）。**MS1 `eea2c9c`、MS2 `2747197`、MS3 `84ed5ec`、MS4 全部 landed**（MS4 = `docs/manual-test-stage4.md` 429 行 smoke 手册，§0-12，8 项 API/WS 预实测 + 审查 5 处增量；各 MS 审查结论见审查记录节；定稿 memory `5f11101`）。**Stage 4 执行完毕，待用户手动 smoke（手册即清单）；push 待 smoke 通过后确认。**

## 定位前提（2026-09-02 用户明确，覆盖旧表述）

**ArgelanderSpace 不只是文献工具，而是单用户科研工作台，承担用户与 AI agent 协作的 interface。** 文献工具链（摄入→文献库→阅读器）是已落地核心能力；计划页面是工作台化第一步。旧表述"单用户科研文献工具""webui 做图形化看板"作废（memory 各文件已同步清扫）。

**本阶段范围**：webui 计划页面完整可交互（用户直接操作，非只读）。agent 操作 plan = **Stage 4.1**，本阶段只做数据层预留（稳定 id、pretty-print JSON、watcher 覆盖）。遵循 webui 独立应用原则：全部写路径在 webui 闭环，不归 CLI。

## 锁定决策（三轮 Q1–Q17 合并）

### 数据模型（contracts/src/plans.ts，zod）

- 两层 **plans → tasks 内嵌**；tasks 数组下标即显示顺序（无 order 字段，拖拽后重排数组持久化）。
- **Plan**：`id`（`p_<8hex>`，crypto.randomBytes）/ `name` 必填 / `desc?` / `due` **必填 ISO 日期**（deadline 语义）/ `icon`（8 选 1 lucide，默认 `target`）/ `created_at` / `tasks[]`。
- **Task**：`id`（`t_<8hex>`）/ `title` 必填 / `status: todo|doing|blocked|done` / `due` **必填 ISO 日期**（**deadline 语义**，与 plan.due 一致；2026-09-02 smoke 验收从"可选"**改判必填**——唯一创建入口的弹窗强制填写，新建预填 plan.due）/ `note?`（markdown，支持 `$…$`/`$$…$$` 数学）/ `links: [{doc_id}]`（多链接）/ `focused` 布尔 / `created_at`。**迁移**：smoke 前创建的无 due 任务，load 时补父 plan.due（纯内存，不落盘不 bump rev，下次保存自然持久化）。
- **PlansFile**：`{version: 1, rev, plans[]}`——rev 持久化在文件里，server 每次成功 PUT 自增（乐观锁）。
- **明确不要**（用户逐项拍板否决，勿复活）：`due_changes` 延期历史（Q15.2——用户自行 note 记录，"只给用户修改创建时输入的权利，不考虑其具体怎么用"）、tag、blockedBy、"等待延期结果"中间态（Q15.3——用户自建"申请延期"task 走状态机治理）、plan.start 字段、anchor 级链接、任务跨计划移动、时间线拖条改期、今日聚焦冗余拷贝数组（原型坏味道）。

### 存储与同步

- 路径：`statusDir = resolve(生效dataDir, "..", "status")`（默认 `./literatures` → `./status`；`--data-dir` 指别处时与其平级——规则只有一条"永远与生效的 literatures 同级"）。文件 `status/plans.json`。
- 格式：**pretty-print 2 空格**（agent 可读/git diff 友好，4.1 关键）；tmp+rename 原子写（照抄 `core/src/library/store.ts` save 模式）。
- watcher：`watch.ts` 指纹加 `status/plans.json` 的 mtime+size stamp（server 自己写会再触发一次广播——既有行为，前端重取幂等，无害）。
- WS：新消息 `plan.changed`（contracts 加 schema；**不动** `WsLibraryChanged.cause` 封闭枚举）。server 写后立即广播（不等轮询）；web 端 `onPlanChanged` → 全量重取（照 `onLibraryChanged` 模式）。

### REST（粗粒度两端点）

- `GET /api/plans`（全量 payload）；`PUT /api/plans`（整文档替换，body 带 `rev`——server 比对当前 rev，不符返回 409，前端重取合并）。
- CSRF guard（照 app.ts 先例）+ **独立 planLock**（AsyncLock，不与 libraryLock 互堵）。
- 不做细粒度 CRUD 端点（4.1 agent 契约 = CLI 直读 plans.json 文件，不走 HTTP，细粒度无收益）。

### 页面与交互

- **布局**：左次级侧栏（项目头 = library project 名 / 总进度条 / 计划列表+新建计划 / 视图入口：今日聚焦、时间线）+ 主区（计划头：名/desc/due/ProgressRing + 列表·看板切换 + 新建任务）+ 右侧任务抽屉。**默认 landing 改为计划页**；多窗格天然支持（计划页 = per-pane view）。
- **弹窗复用**（Q15.1；2026-09-02 smoke 修订）：**PlanModal**（name+due+desc+icon）与 **TaskModal**（title+status+due，**due 必填**——新建预填 plan.due，编辑预填原值不可清空）均**新建/编辑共用**，编辑 = 预填打开。**任务创建唯一入口 = "新建任务"按钮 → TaskModal**（smoke 改判：行内快速添加与看板列底"添加任务"已移除，QuickAdd 组件删除——快速路径会绕过 due 必填）；抽屉"编辑"按钮开 TaskModal。note/links/focused 不进弹窗（分别在抽屉/行内操作）。
- **列表**：按状态分组（进行中/待办/受阻/已完成，已完成折叠，空组不渲染）；行 = 状态按钮（单击循环 todo→doing→done）+ 标题 + due 徽章（今天 amber/逾期红/其余灰）+ pin 标记 + note 有内容标记 + 链接计数；**组内拖拽调序**（跨组拖拽不做——跨组用状态按钮，语义唯一入口；smoke 修复：sameGroupCollision 碰撞过滤 + dropPoint 命中测试兜底）。
- **看板**：四列 todo/doing/blocked/done；**拖拽 = 跨列改状态 + 列内定位**；任务不跨计划移动。（列底"添加任务"已随 smoke 改判移除，见上。）
- **今日聚焦**（侧栏入口，派生视图无额外存储）：分组 = 已聚焦（pin 的，未 done）→ 已逾期（due<今天，未 done）→ 今天到期 → 明天到期；空组不渲染，全空显示引导文案。pin 入口 = 行内 hover pin 按钮（lucide `pin`，避开 star 语义）+ 抽屉 toggle。
- **时间线**（只读）：plan 条 span = `created_at`→`due`，按 done/total 填进度，`due<今天` 且未全 done → 红色警示；有 due 的 task 画成条上菱形里程碑点（hover 显标题，点击开抽屉，**只显当前 due**）；刻度自适应（<6 周按周，否则按月）+ 今天竖线。
- **任务抽屉**：所属计划标签 + 标题 + 状态四态直选行 + 关联文档区（搜索选择器添加，候选 = 库内有 doc_id 的条目，CommandPalette 式过滤；显示名从 library refs 反查 work title；点击 `useWorkspace().openDoc` 跳文档视图；doc 失效 → 灰化"文档不存在"，**不自动删链接**）+ note（查看/编辑分离，编辑 = textarea，`⌘↵` 保存）+ 删除（6 秒撤销 toast，原位插回）。
- **plan 删除**：二次确认，有未 done 任务时警告带数量。**plans 为空**：引导空态（"新建第一个研究计划"按钮），不预置默认 plan。**api 层无 fixture 兜底**（空态即可）。
- **note 渲染**：`marked` + 自写 ~30 行 `mdWithMath.ts`——先抽 `$...$`/`$$...$$` 为占位符 → `marked.parse` → 回填 `renderMathToString` 输出（复用 `packages/web/src/lib/math.tsx`，阅读器同款容错）。**顺序必须如此**：marked 先跑会咬坏 math 内的 `*`/`_`/`\\`。不 sanitize（单用户本地，note 即用户自输入，同原型裁决）。

### 新依赖（全部 packages/web，实现时锁兼容版本）

`marked`、`@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`（Q11 用户改判引入 dnd-kit，原生手写方案否决）。

### 关键取证（2026-09-02 两路子代理 + 主 agent 补查，可直接采信）

- **"已有相关 code 被 block"不成立**：全 repo 无 plan 域实现/schema/注释模块；`acquire/planner.ts` 是全文获取规划（另一个域）；唯一 stub 本体在 `packages/web/src/argelander/Shell.tsx:439-451`（StubPane）。接入点 = renderView 加 `case "plan"`（`Shell.tsx:204-213`）；活动栏/窗格菜单/CommandPalette 三入口已天然存在；NAV 的 `stub?: boolean` 是死元数据（无读取点）。
- **/tmp/HubbleSpace** = 纯前端高保真原型（非旧 Python 版）：`views/planning.jsx` + `planning-extra.jsx` + `data.js`。可借骨架（三层模型/三视图/抽屉/撤销 toast/聚焦概念）；不可取：`arts[{k,t}]` file/artifact 导向链接（8 种 kind、显示字符串无解析）、时间线硬编码占位、focus 冗余拷贝数组、due 自由文本、实验记录超纲、无持久化。
- **可复用范式**：PATCH `/api/library/refs` 写路径（CSRF guard → AsyncLock → 原子写 → `libraryChanged` 广播，`packages/server/src/app.ts:282-305`）；LibraryView 取数（useState + WS 全量重取，`LibraryView.tsx:63-91`）；web 已有 katex + `lib/math.tsx`（`renderMathToString`、`htmlWithMath`）；`watch.ts` 指纹模式；lucide 按名图标（`lib/icons.tsx`）；CommandPalette/右键菜单/popover UI 范式。
- `patchRef` 客户端类型缺 `note`（server 实际支持）——既有小缺口，非本阶段范围，立此存照。

## 里程碑切分与执行流程

- **MS1 contracts + core**：`contracts/src/plans.ts`（Plan/Task/PlansFile zod schema + WS `plan.changed` 消息）+ `core/src/plans/store.ts`（load/save 原子写/rev 自增/CRUD 辅助/校验）+ 测试。
- **MS2 server**：statusDir 解析 + `GET /api/plans` + `PUT /api/plans`（rev 409）+ planLock + `plan.changed` 广播 + watch 指纹 + 测试。
- **MS3 web**：新依赖 + `api/plans.ts` + PlanView 全家桶（侧栏/列表/看板/时间线/聚焦/抽屉/PlanModal/TaskModal/mdWithMath/链接选择器/撤销 toast）+ Shell 接线 + landing 切换 + 测试。
- **MS4 收尾**：`docs/manual-test-stage4.md`（= 用户 smoke 清单，全交互路径详列：CRUD/弹窗编辑/拖拽/聚焦/时间线/链接跳转/due 修改/多窗格/外部改写刷新/失效链接灰化）+ memory 收尾。README 默认不动。
- **每 MS 流程**（用户 2026-09-02 授权，不再逐次问 commit）：实现 → 四道门（`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`）→ **派 subagent 独立对抗式审查**（新 agent、非实现者、对照本定稿审 diff）→ 测试+审查双过 → **自行 commit**。
- **push 待用户全部 smoke 通过后确认**；smoke 清单 = MS4 手册。

## 推后事项（本阶段勿做）

- **Stage 4.1**：agent 操作 plan（CLI 子命令 / skills / plan API 契约）。数据层已预留：稳定 `p_`/`t_` id、pretty JSON、watcher 覆盖、`plan.changed`。
- anchor 级深链链接（link 加可选 `anchor` 字段即可，深链接机制现成）。
- 时间线拖条改期 / 任务跨计划移动 / plan.start / due 历史建模（均用户明确否决或推后）。
- Stage 3.1 遗留推后事项（全条目 re-upload、README pandoc 说明、CLI 未识别源建条目）见 `2026-09-01-stage3x-roadmap.md` 推后事项节，与本阶段无关。

## 审查记录（每 MS 对抗式审查的结论归档）

- **MS1 审查通过**（2026-09-02）：1 阻断已修——WS union 加 `plan.changed` 打断 web 编译（`web/src/api/ws.ts` else 分支假定非 hello/library.changed 必为 job 事件），修为显式 `plan.changed` 分支（MS3 在此接 listener）；store.ts 头注补"单用户+planLock 串行"前提、删预决 4.1 的一句。非阻断观察两条：① **MS3 注意**——`Plan.icon` schema 层是任意字符串（8 选 1 只是 UI 约束），web 按名查 lucide 图标必须对未知名兜底；② **4.1 前评估**——plans.json 未知键被 zod 默认 strip（load 丢弃、save 抹掉），agent 写的前向兼容字段会被 round-trip 抹掉，届时评估 `.loose()` 或文档化。
- **MS2 审查通过**（2026-09-02）：0 阻断；15 项真实 boot 对抗运行验证全过（10 并发 PUT 恰 1×200+9×409、WS 序列 [put,external] 恰好一次无自激、外部写双侧隔离、40MB body 接受等）。顺手修复：ws.ts 头注补 plan.changed、plans.test.ts 补两个 500 用例（PUT 遇盘上损坏文件锁不楔死、GET 遇 schema 非法）。非阻断存档：PUT body 无大小限制（与 upload 端点先例一致，单用户可接受；要限则 Hono bodyLimit 是挂点）；JSON body 不带 Content-Type 也解析（与既有端点同款）；loadPlans 遇 EISDIR 报错措辞误导但只在 server 日志。
- **MS3 审查通过**（2026-09-02，审查+修复+复核+终修四轮）：阻断 3 项全修——① mdWithMath 无差别抽取腐蚀 code span/货币/`\$`/URL（初修四步管线：code 哨兵+texmath 边界+熵 token；**复核再抓链接目的地哨兵毁 marked 词法**（`%01` href）→ 终修改为 URL dest stash + href 钉断言，主 agent 独立抽查 11 组过）；② 中文 IME 组词 Enter 误提交（4 处 `isComposing` guard，TaskDrawer ⌘↵ 天然免疫）；③ noop 拖拽空涨 rev 的跳过是死代码（patchTasks 改引用传递后真正生效）。非阻断 9 项全修（pendingExternal defer+排空补 reload、loadFailed 显式失败态、"N 项未完成"、月刻度带年、md table CSS、toast 错位、测试补 27+9 例）。web 测试 44→102。**存照**：deferred reload 与链上排队写交织时可能多闪一次 409 flash（结果收敛，单用户可接受）；多反引号 code span/~~~ fence 已覆盖，更怪的 markdown 构造（setext 标题里 `$` 等）未逐一枚举——mdWithMath 管线是启发式不是完整 md parser，遇到新腐蚀按"加保护区/stash"模式扩展。
- **MS4 审查通过**（2026-09-02）：0 阻断。~40 处手册文案/行为断言逐字 grep 源码全中；预实测 8 项复跑 7 过（第 8 项隐含覆盖）；roadmap MS4 十条覆盖全。增量 5 处已补：§0c-7 WS 复触发注释、§4d blocked 行内逃生（点圆钮回 todo）、§2d 计划头逾期红、§11c 多窗格步骤、§12 已知行为 4 条（聚焦卡圆钮不可点/done 列 quick-add 直建 done/写失败文案"保存失败，已重新载入"/撤销 toast 单例替换）。手册终稿 429 行。
- **smoke 第 1 轮修复（2026-09-02，commit `8804470`）**：用户验收 2 阻塞全修——① **task.due 改必填**（设计变更，推翻 grilling 时"可选"：schema 去 optional；创建入口砍到唯一"新建任务"弹窗（due 必填、新建预填 plan.due、编辑不可清空），QuickAdd 组件+看板列底移除；无 due 旧任务 load 迁移补 plan.due）；② 列表跨组拖拽放行（根因 = dnd-kit 多容器碰撞检测使跨组悬停合法化 + 边界落点误判同组行；修 = `sameGroupCollision` 候选过滤 + `dropPoint` 命中测试，回归 3 例）。审查 0 阻断（迁移对抗、PUT 无 due → 400、QuickAdd 零残留全过）；顺手：`.gitignore` 补 `status/`、§12 引用改错（§11d→§11c）、死 CSS/过时注释清理。测试 444→448。非阻断存照：TaskModal 的 `required` 属性因不在 `<form>` 内无效力，真正守门是 `valid` guard；迁移会把非字符串 due（123/null）也补为 plan.due（有意裁决，修复方向非抹除）；`status/plans.json）`（全角括号）是 smoke 时 shell 重定向笔误产物，留用户自处置。
