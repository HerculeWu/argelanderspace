# 计划页面：现行模型与用户取舍

状态：现行专题。Stage 4 于 2026-09-02 关闭，Stage 7 于 2026-09-10 补 due 软警告；2026-09-21 从 `46093915:.pi/memory-reference/plans.md` 迁移。来源：Stage 4 Q1–Q17、三轮 smoke，Stage 7 Q6。原始记录见 [history](history.md)。这里的 Plan/Task 是产品用户数据，不是 `.scratch/` 中的开发票据。

## 模型与存储

- plans→tasks 内嵌两层，tasks 数组位置即显示顺序，无 order 字段。
- Plan：p_<8hex>、name 必填、desc?、due 必填 ISO日期/deadline、icon（UI8选1、默认target）、created_at、tasks[]。
- Task：t_<8hex>、title 必填、status todo/doing/blocked/done、due **必填** ISO日期/deadline、note?（Markdown+数学）、links[{doc_id}]、focused 布尔、created_at。
- PlansFile：version:1、rev、plans[]；pretty2空格，tmp+rename，每次成功 PUT rev 自增。
- statusDir=resolve(有效dataDir,"..","status")，文件 plans.json，永远与有效 dataDir 平级。
- 旧无 due 任务 load 时补父 plan.due，内存迁移不立即落盘或 bump rev，下次保存持久化；123/null 等非字符串也补，原验收是有意迁移容忍。
- Plan.icon schema 是任意字符串，8选1仅 UI 限制，未知图标必须兜底。
- task.due > plan.due **合法**；TaskModal 非阻断提示，schema 不阻止，因为计划延期是正当场景。Stage 7 覆盖 Stage 4 “未解决 due 约束”的旧条目。

## REST 与同步

GET/PUT `/api/plans` 全量 payload；PUT body 带 rev，冲突409，前端重取并提示。独立 planLock（不与 libraryLock 互堵）、CSRF guard。server 立即 plan.changed；watcher mtime+size 再发 external，前端重取幂等。

- WsServerMessage union 加成员时 web dispatcher 显式分支，不能 else 都当 job。
- plans.json 未知键默认 zod strip，round-trip 不前向无损（I010）；未来 agent 写入前必须评估。
- 当前 server 单进程 lock 不等于跨进程文件写锁。Stage 4.1 仅留数据条件，旧“未来 CLI 必直写磁盘”只是方案设想，不冻结未来并发/接口设计。
- PUT body 无专门大小限制，未带 Content-Type 也可解析，单用户先例接受；load EISDIR 日志措辞不够准确。要改变信任/部署模型时再评估。
- pendingExternal 在本地写入中 defer 后排空；排队写交织可能多闪一次409，但收敛；失败有显式 loadFailed，不用 fixture 冒充空数据。

**I018（已接受）**：本地单用户 note 不 sanitize、API body 限制宽、排队写与 external reload 可多闪一次 409 但结果收敛。只有信任/部署模型变化或相关新需求获批时重议，不把这些取舍当作已批准的修复队列。

## 页面与交互

默认 landing 计划页；每个 pane 独立视图。左侧项目头/总进度/计划列表/聚焦/时间线，主区计划头与列表·看板，右任务抽屉。

### 创建、编辑与删除

- PlanModal、TaskModal 新建/编辑复用；TaskModal title/status/due，due必填，新建预填plan.due，编辑不可清空。
- **任务创建唯一入口是新建任务按钮→弹窗**。QuickAdd及看板列底添加已在 smoke 删除，不把旧手册中间态恢复成现行入口。
- note/links/focused 不进弹窗，在抽屉或行内操作。中文IME Enter不误提交；真正守门是 valid guard，不只依赖非form下的required属性。
- 抽屉四态直选，Markdown+数学 note 编辑/展示分离、textarea Cmd/Ctrl+Enter保存；删除任务有6秒撤销，原位置插回，toast单例可被替换。
- 删 plan 二次确认，含未done任务时警告数量。空数据引导创建，无默认plan、无API fixture兜底。

### 列表与看板：故意不对称

- 列表状态组：doing/todo/blocked/done，空组不渲染，done折叠。状态圆钮循环todo→doing→done，blocked可点击逃回todo；抽屉可直选全部四态。
- 列表只在同状态组拖拽调序；sameGroupCollision过滤+dropPoint检测。跨组应拒绝，其他组变暗、拖行no-drop、被拒落点nudge，不能仅静默回弹。
- 看板四列todo/doing/blocked/done；跨列拖拽就是改状态+定位，是产品设计，不需要同样拒绝。不能跨计划移动。
- noop调序不空涨rev；patchTasks引用传递需让noop分支真的生效。

### 聚焦、时间线与文档链接

- 今日聚焦派生，不存冗余副本：pin未done→逾期未done→今天到期→明天到期；空组不显示，全空引导。pin入口行hover+抽屉toggle，与star语义分开。聚焦卡状态圆钮当前不可点。
- 时间线只读：plan span created_at→due，done/total进度，逾期未全done红；task菱形当前due，hover标题、点开抽屉。<6周周刻度，否则月刻度（跨年带年），今天竖线。
- links只到doc_id，多链接；候选为有正文的库条目，反查work.title，点openDoc。失效灰化“文档不存在”，**不自动删除任务链接**。
- PlanView固定宽仍是现状，Stage 6宽度修复只针对阅读器，不擅自将其扩成全UI响应式重构。

## Markdown+数学与信任边界

marked + mdWithMath 先保护code/URL等，再抽数学为熵占位符，marked后回填KaTeX。不能先让marked吃math里的星号/下划线/反斜杠；不能无差别抽所有美元符号。

已回归：code span/多反引号/fence（含~~~）、货币、转义美元、链接目的地。URL stash若提前破坏marked词法会出%01 href，曾二次审查修复。更怪setext构造未全枚举，是启发式，遇新腐蚀加保护区与回归。note不sanitize是本地单用户自输入的明确裁决，不适合据此宣称可安全接不可信多用户输入。

## 明确不要与推后

用户原理由要保留，不能统称“尚未实现”：

- due_changes延期历史：用户自行note，“只给用户修改创建时输入的权利，不考虑其具体怎么用”。
- blockedBy、“等待延期结果”中间态：用户自建申请延期task即可，不额外建状态机。
- tag、plan.start、聚焦冗余数组：不提前扩模型，最后一项是原型坏味道。
- 任务跨计划移动、时间线拖条改期、anchor级链接：当前不做；未来明确需求才讨论。
- Stage 4.1 agent 操作计划：仍推后，稳定id/prettyJSON/watcher/plan.changed/CRUD纯函数只是预留；不是已完成命令面或永久细粒度API禁令。

## 证据入口

contracts plans、core plans-store、server plans/watch、web plan组件与mdWithMath测试；`docs/manual-test-stage4.md` 用户验收手册；Stage 7手册补due软警告。旧smoke曾落下全角括号文件名，是用户shell重定向笔误历史，不是需agent现在清理的数据授权。拖拽真实Chrome取证结论见 [engineering](engineering.md)。
