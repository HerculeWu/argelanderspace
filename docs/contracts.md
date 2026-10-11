# 硬契约与用户数据保护

状态：现行。2026-09-21 从已批准旧契约迁移；没有重新批准产品行为或解除冻结。来源：`46093915ab1c597eb3b1ce0a28ce73aaef99f37a:.pi/memory/contracts-and-decisions.md`，CLI annot 细则来自同提交 `.pi/memory-reference/annotations.md`。历史决定与恢复方法见 [history](history.md)。

## 产品与执行边界

- ArgelanderSpace 是单用户科研工作台；webui 是可独立操作的应用，不只是 agent 看板。note/label 等尚未补齐的写路径不构成永久只读定位。
- 项目级文件存储；dataDir 按 cwd/显式配置解析，不向上查找。全局库复用、SQLite、多用户部署没有实施授权。
- CLI + skills、无 MCP 是现行接入选择，不依赖对 agent 上游能力的永久断言。文献问答必须走 sanctioned CLI/skills，不以内部 JSON、源码或标注 archive 替代文献接口；开发任务可以读源码。
- 正文摄入支持既有 LaTeX 路线与本阶段新增的本地 PDF Doc（条目内上传、arXiv PDF 获取），其不可变原件与独立标注/进度规则见下文。DOI 创建无正文条目不表示恢复 DOI/出版商 PDF、OCR 或 HTML 摄入；这些旧能力仍封存于 `ocr-features`。
- 具体条目、主正文、cite key、上传/arXiv 场景规则见 [library](library.md)；技术文档不能把“已有能力”扩成“所有输入都兼容”。
- 编译失败硬失败，无无编译全文降级；插桩失败可干净编译回退，图失败可降级无图，三者不能混淆。印刷显示号与结构寻址 id 分离，未编号 display 不自产号；不承诺重摄入前后结构 id 逐位置稳定。
- 新阶段和开放问题由用户决定。已关闭阶段的实施、审查、自行 commit/push 授权不永久继承；常规回归与用户 smoke 是不同证据。
- 用户数据迁移先备份、说明回滚并获授权；不直接在真实文献库上做破坏性探针。跨进程并发能力只按明确支持范围承诺。
- 全局数据（[ADR 0007](adr/0007-global-data-scope.md)）与项目数据分开，不因此迁移项目数据或授权全局 Library。Mail（[ADR 0008](adr/0008-mail-remote-authority.md)；账户管理、收信/阅读〔票 05〕、管理操作与服务端搜索〔票 06〕、写信与发送〔票 07，含下述发送并发/缓存互斥的如实表述〕与 INBOX 实时更新〔票 08：每进程每账户一条只读 INBOX 连接，登录被拒不自动重试，退出时全部清理〕均已实施）的明确支持范围：多个工作台进程可同时使用同一组邮箱账户；账户配置原子替换并带 rev 乐观检查（实现为跨进程文件锁内“读—比对 rev—写”，rev 不符返回 409 且不覆盖；账户文件损坏时报 500 且不覆盖）；删除账户同时删凭据与该账户全局缓存，绝不触碰远端邮件；邮件缓存是可丢弃派生数据，不加锁，最坏重新拉取（读信写缓存前会确认账户仍存在，同进程内删除账户时抓取中的结果不会重建缓存；但另一进程恰在“确认账户存在”与“写文件”之间删除该账户的极小窗口仍可能留下孤儿缓存目录，它只是可丢弃的残留，不含用户数据，可手动删除）；凭据回退文件（仅经用户同意才存在）读-改-写不加锁，两进程同刻写不同账户时后写者胜、可能丢一次写，用户重输一个密码即可；远端并发由 IMAP 服务器处理。这一例外不扩展到项目数据的 I013。Copilot 的发送/回复/转发/删除/移动必须经真人确认卡（票 09 已实施；模型不能自批、卡片内容即实际发送内容、邮件内容为不可信数据，机制见 [architecture](architecture.md)“Mail 的 Copilot 工具与页面上下文”）；凭据不写入日志、文档或票据，钥匙串不可用时仅经用户明确同意才落受限文件。发送：8 秒撤销窗口由唯一属主进程的内存计时器持有，进入窗口前最终邮件已存入服务器 Drafts；窗口内进程退出（含优雅关停，关停第一步同步 dispose）的邮件留在 Drafts、重启后绝不自动补发并如实报告（`interrupted`/`unknown`），SMTP 不自动重试，同一草稿同时只能有一次发送（进程内守卫＋缓存中的 O_EXCL claim），窗口内的草稿被冻结；SMTP 已接受的 Message-ID 在 7 天内再发送或存回草稿一律拒绝（`already_sent`，sent 守卫同在缓存与进程内，用来挡住应答丢失后的再次发送）；SMTP 结果模糊（`outcome_unknown`）时不写 sent 守卫；服务器以 `unknown` 状态报告，web 不自动重发，由用户决定；claim 与 sent 守卫都按“账户＋Message-ID”，只在同一发件账户内成立；sent 守卫的磁盘写入是尽力而为（邮件已发出，不因写失败而改判），写失败时只有本进程看得见，其它进程与重启后的进程看不到。窗口标记与暂存附件在全局缓存：缓存丢失**不会丢邮件**（邮件在远端 Drafts），但会丢“未发出”提示，并且**会失去跨进程互斥（含 sent 守卫）**——缓存目录被整体删除时，若另一个 server 进程恰在此时对同一草稿发起发送，可能出现重复发送（已知剩余窗口，未加额外锁）；删除账户清掉其标记，暂存附件不属于账户、由 7 天清扫处理。机制见 [architecture](architecture.md)“Mail 写信与发送”。

## Agent 输出冻结与回归策略必须分开

**2026-09-01 已退出 Python→TS 重构期**：bug-for-bug、Python 逐字段 parity 作为项目通用验收基线退役。普通 golden 可按行为变更从 TS 管线自洽重冻并人工抽查，不能因此恢复旧行为。

**但 Stage 6/7/8 的明确 agent 接口冻结继续有效**（Stage 6 Q7；Stage 7 硬约束；Stage 8 硬约束）：

- 既有 search/read/show/ref/note/label/list 命令面、markdown token、bib/ref JSON、深链接格式不擅改；golden `.md` 不重冻，继续作冻结守卫。
- 新命令 **annot 自诞生起入冻结面**。字段、顺序、排序、stdout/stderr、错误形态等详见本文件“CLI annot 冻结契约”。新增能力不等于可以顺手改旧接口。
- JSON fixture 的 agent 不可见 meta/图尺寸等增量可以走普通回归更新；已验证的每篇具体内容修正、原结构 id 位移，不等于获得无限输出变更授权。影响冻结面时先明确新决定，不借“普通 golden 可重冻”绕开。
- `search` 空 note 提示刻意走 stderr，stdout JSONL 可 pipe；`annot` mismatch 不能返回旧标注，也不能为了修文案偷偷改冻结输出。

冻结是在项目脱离重构后单独成立的契约，不能随旧重构细录一起删掉。

## 文档标注：独立用户数据

来源：2026-09-10 Stage 8 产品定位、Q1–Q20 与用户终稿四修正；2026-09-12 关闭。实施细节见 [annotations](annotations.md)。

- 标注属于 **doc 而非 work**，数据在 annotations sidecar，不进 render IR。
- 标注 = 目标位置 + 内容，高亮只是显示。target 三型 document / structure / text；文本任意重叠。
- body Markdown+数学，校验 trim 非空但保存原始字节；target/snapshot/created_at 创建后不可变，移动位置必须删旧建新。updated_at 仅 body 字节变化时 bump。
- 只保证所属 doc 的当前内容成立；**不同内容原位替换 → 整批失效归档**，同指纹重摄入保留。不做逐条 salvage、置信度、自动 re-anchor、隐式 migration 或跨 doc 自动迁移。
- 想保留旧标注就保留独立旧 doc；quote/snapshot 是显示与未来显式迁移的参考，不作为本阶段自动定位/逐条有效性检查。
- canonical text 使用 UTF-16 offsets，math/cite/xref 原子段；选到内部则创建时扩到完整段。跨容器/跨块拒绝并提示；正文 DOM 不嵌套 span，CSS Custom Highlight 负责重叠。
- 无 author/status/thread/color/kind 等提前扩展，无纯无 body highlight、reference target、右键菜单。结构 target 的 `kind` 判别字段不等于引入上述 annotation 分类字段。

### 内容指纹三态硬规则（保留原规则与异常分支）

指纹是 annotation-addressable rendering 的 SHA-256 canonical projection，包含 id↔内容绑定与资产内容 hash，非论文语义版本。完整投影在专题中，以下规则为数据保护权威。

1. **fingerprint 成功且相同** → annotations 正常有效；
2. **成功但不同** → 确定的文档替换：归档 current、建绑定新指纹的空 current；
3. **无法计算** → 系统错误，**绝不当 mismatch**：保留全部用户 annotation 原状，不归档/不删除/不重写 current/不广播 invalidate。
   - doc 不存在 → 404，不碰 annotations；
   - IR JSON 损坏/schema 无效 → 500 / CLI exit 1，不碰 annotations；
   - current.json 损坏/schema 无效 → 500 / CLI exit 1，**绝不静默 reset**；
   - IR 无 `imgPath` → 正常“无资产”，canonical 中写明确 null/absence，不算失败；
   - IR 声称有 `imgPath` 但 asset 丢失/不可读/hash 失败 → fingerprint 失败 → 500，不碰；
   - archive 写入/rename 失败 → 原 current 必须保持，返回 500；
   - **特殊中间态**：旧 current 已成功入 archive、但新空 current 创建失败 → 用户数据已安全在 archive，返回 500；下一次访问允许重建新 current。**只有新 current 完整建立后才广播 `invalidate`**。

不能把这段压成一句 fail-closed，不能把系统错误当正文替换。

**文本 Doc 的生成同样受此三态约束**（Copilot 票 25、28）：生成器是发布边界而不是归档者，**永不归档、永不广播 `annotation.changed`**，归档只发生在标注 GET/PUT 访问路径（`ensure` 仍是唯一归档者）。候选内容指纹与已发布内容相同则发布并保留标注；不同且当前标注为空（或不存在、或已因更早的未归档发布而过期）也直接发布；**不同且当前标注非空 → 返回 409 `confirmation_required` 及影响（将被归档的标注条数、标注 rev、旧/新指纹、源 rev/已发布源 rev），零写入**，只有真人在页面确认卡上点击后，才把这些值原样随 `confirm` 回传；服务端在与写入同一临界区内重新读取并逐项比对，任何一项变化（源已保存新版本→`stale`；其余任何一项——Doc id、标注数、标注 rev、新旧指纹、已发布源 rev——不再相符→409 `confirmation_changed`，**即使此时已无风险（标注已清空、指纹已相同、首次生成）也照样拒绝而不发布**，仍有风险时附最新影响，已无风险时不附，用户重新生成即可）都不发布；确认绑定 Doc id，A 的确认不能用于 B。成功结果的 `replacedAnnotations` 如实报告这次发布留给下次标注访问去归档的条数（保留或无标注为 0）。等待确认期间不持有业务锁或 writer pin。标注/已发布正文/指纹无法读取或计算 → 500（`annotations_unreadable`/`reading_unreadable`/`fingerprint_failed`/`asset_unreadable`），不触碰 IR、current 与 archive 的任何字节，也不能用确认绕过。发布前失败（含 `publish_failed`）保留旧 IR 与标注；发布后随后的标注访问若在归档/新 current 阶段失败，沿上文中间态规则如实报 500（旧批次已安全在 archive、下次访问重建），正文**不回滚**。机制见 [library](library.md#文本-doccopilot-票-25)；模型与 agent 的文本工具（票 29）只能请求：工具参数里没有 `confirm`，遇 409 `confirmation_required` 只生成绑定该 Doc 与全部 impact 值的真人确认卡；仅在真人点击批准（点击时已按生成自身代码只读重验，系统错误如实报错而非当作「已变化」）之后，宿主才把卡上的 impact 作为 `confirm` 回传，服务端在发布临界区内再次逐项比对；该次生成写入前先记入操作日志，重启后如实报告结果未知而非「已过期」。

### 归档权限与 PUT

- **归档权威仅 server GET/PUT annotations 访问路径**，共享幂等 ensureCurrentAnnotations；watcher 只通知，不承担归档写操作。未来若 eager，只可在确定性 ingest/job 完成边界另行设计。
- **CLI annot 真只读**：自行算 fingerprint，match 输出，mismatch 空 stdout+固定 stderr note，零写盘零归档。冻结文案含“archived”也不表示 CLI 实际归档。
- archive 字节原样保全外部未知键，不经 zod round-trip 重写；归档前仍做合法性 gate。UTC 毫秒名+旧指纹前8，碰撞加 -N，绝不覆盖已有档案；archive 对正常 reader/agent 不开放。
- 新 fingerprint epoch rev 从 0 开始，**PUT 必须双校验**：请求 fingerprint 不同 → ensure 后 409 document changed；相同而 rev 不同 → 409 rev mismatch；基础设施错误 → 500，不得假装 reload 成功。
- 文本创建目标遇 epoch 改变不能静默转为结构标注；应关闭并要求重新选。编辑草稿在 document-changed 后保留但禁存。
- Copilot 的标注写入（`reader` 工具）经同一 `annotations-access` 的 `commit`（原 `commitAnnotations`）处理（与 PUT 同锁、同 ensure、同指纹+rev 双检查、同三态）；工具层不自行 ensure/归档/写文件，不读 archive；机制见 [annotations](annotations.md#copilot-写入-latex-标注票-19)。PDF 工作台标注的 Copilot 写入同样不走 LaTeX ensure/归档：在 `annotationLock` 内经 core `commitPdfAnnotationChange`，对原件不可变 SHA-256 与 sidecar rev 双检、保留未知键、原子替换，PDF 字节永不改，见 [annotations](annotations.md#copilot-写入-pdf-标注票-21)。

### 删除生命周期

`DELETE /api/paper/:doc_id` 是 **全局物理删除**：output + annotations（含 archive）一起删，扫描全部 works 摘除 doc_id，剩余 doc_ids[0] 自然递补为主，立即广播 library.changed。不是只从当前 work 解除关联。

- server 已知同 doc queued/running mutation → DELETE busy 409；反向删除中 upload 不得写入。DocMutationRegistry 生命周期互斥，不仅是 libraryLock。
- workspace 显式三态：删非 current 不变；删 current 且该 work 有剩则切新主；无剩则 currentDoc=null，并主动更新 paper list，不能等 watcher 碰巧修好。
- CLI 与 server 跨进程同时 mutate 同 doc 不支持，不做 filesystem lock；CLI 文档删除命令未提供。
- Copilot `library.delete_doc` 复用同一全局删除处理，永远要真人确认卡（与对话框同范围文案，列出所有持有该 Doc 的 Work 与标注计数；模型不能自批）；库步骤为窄写入、只写 library.json，见 [library](library.md) 的“Doc 删除（Copilot 票 16）”。
- **文本 Doc 的删除**（Copilot 票 25）复用同一全局物理删除：`output/<id>/` 内的文本源（含尚未生成的文字）、图片、已生成的阅读正文，加当前/归档标注，并摘除所有 Work 关联；来源 PDF 只是文件关系，**不级联删除**。从未生成的草稿没有阅读正文，无标注可绑定，删除确认里的标注数仅当 `annotations/<id>` 确实不存在时才为已知 0，目录存在则是未知（不推断为 0）；页面对话框与 Copilot 确认卡用同一服务端判断。详见 [library](library.md#文本-doccopilot-票-25)。
- 绕过入口手动 rm output 后 orphan annotations 不自动清理，**无访问保证**，不能写成已有 migration 输入渠道。

### 本地 PDF Doc（Web 上传与只读基础阅读）

本段只增加新 PDF 分支；既有 LaTeX IR、三态归档、CLI annot 冻结和 Writer 契约不变。

- 一个 PDF Doc 恰好属于一个现存 Work，owner 仅由 Library 的 Work–Doc `doc_ids` 关联推导。同一 Work 内同 SHA-256 且逐字节相同的**用户上传**复用已关联 PDF；跨 Work 必须是新的 Doc、新物理文件、新 sidecar。用户主动 arXiv PDF 重新获取每次成功均为新 Doc，即使 bytes 相同；同一次在途请求重复提交才复用 Job。不是全局共享内容存储。
- PDF metadata 记录来源、UTC acquisition time、原件 byte length 与 SHA-256、页信息。arXiv PDF 来源记录规范 arXiv ID，不要求也不伪称已核实官方 `vN`；本功能不查询额外 arXiv version API。原 PDF bytes 不可变。
- PDF 是不可变原文件；无 PDF 原位替换。单文件硬上限 50 MiB，25 MiB 起显示资源警告，可信解析最多 100 页；PDFium 探测串行，低于 512 MiB 进程外空闲内存则拒绝启动。超过 100 页需先完成虚拟化及复杂样本实证。
- 完整原始 bytes 成功通过固定 EmbedPDF 2.15.1/PDFium 可信解析后，Server 才创建版本化 PDF metadata、空工作台标注 sidecar、null 阅读位置 sidecar 并挂载 Work。失败的临时目录不作为 Doc；不按 PDF 标题 seed Work。Library rebuild 保留既有 PDF 关联，不猜测恢复丢失 owner。
- PDF Reader snapshot、原件和 sidecar 每次访问独立验证：metadata `doc_id`/schema、唯一 owner、原件 byte length+SHA-256、标注 sidecar schema 与 `doc_id`/hash 绑定。前端再 hash 校验实际收到的原件 bytes，把同一 buffer 交给 SDK；不让 SDK 按路径另取文件。响应 no-store。
- 可计算且不同的 hash → **409 document changed**；原件/metadata 缺失或不可读、hash 无法算、annotation sidecar 损坏或未来 schema、归属不唯一 → **500（所有权不唯一是数据一致性错误）**，未知/unowned Doc → 404。已知错误不触发清空、迁移、归档、重绑 hash、写空替代 sidecar 或通知成功；旧数据 bytes 原样保留。
- Reading position 是独立 per-PDF-Doc 用户数据：`reading-position.json` 版本 1 的 `position` 为 `null` 或 `{page_index, x, y}`；x/y 是归一化可见页坐标，按 Reader 视口中心记录，缩放和旋转无关。它绑定固定 PDF SHA-256，有独立单调 `rev`，不与 annotations.rev 共享。`GET/PUT /api/paper/:doc_id/pdf/reading-position` 验证 owner、同一份原 PDF bytes/hash、sidecar schema/binding 和页范围；PUT 对独立 expected rev 检查并以同目录临时文件+rename 原子替换。rev 冲突返回 409，不覆盖新值；busy、content-changed、坏/未来/缺失 sidecar、读取/写入/rename 失败分别拒绝且保留原 bytes，不生成空初始 sidecar。PDF snapshot 仍可提供经验证正文/标注，进度异常通过 `reading_position.status="error"` 单独呈现。PDF Reader 合并滚动写入、同 Doc 串行并只接纳当前代；失败后的显式 Retry 先重读绑定正确的 sidecar：expected rev 未变化时重发当前最新位置，新 rev 已保存相同最新位置时确认已保存，否则保留本地最新位置并继续报告冲突，不重放 Retry 开始时的旧 capture。若初次 snapshot 进度读取失败但 Retry 能读到合法现存 sidecar，则在没有 explicit link/当前会话用户接管时恢复其位置；迟到回复受 Doc/用户输入代际保护。深链接优先于恢复，用户 wheel/keyboard 接管取消迟到恢复，`pdf-reading-position.changed` 仅作通知、不驱动其他标签页跳动。
- PDF 初始 annotations 是绑定同一不可变 SHA-256、rev 0 的空集合，reading position 是独立 rev 0/null 文件；Published PDF 意外缺 sidecar 按数据错误，不当作首次打开。Ticket 05/06 提供独立 PDF sidecar 与 `PUT /api/paper/:doc_id/pdf/annotations` optimistic-revision 写入，启用 rectangle/page_comment/document_comment 及从真实文字层选择创建的 highlight/underline/strikeout。跨页文字目标是一条逻辑标注，含不可变 quote 与按页分组的归一化页局部矩形；无文字层时不生成文字 target。`GET /api/paper/:doc_id/pdf/annotations/count` 读取 PDF sidecar 的真实计数，损坏/不可读是未知错误而非零。PDF 内嵌标注始终只读且不进入工作台集合；绝不将工作台标注写回原 PDF，也不走 LaTeX ensure/archive。完整字段、坐标与保留未知字段说明见 [annotations](annotations.md)。
- PDF 发布、去重和物理删除复用 DocMutationRegistry 双向互斥与 libraryLock 发布临界区。删除 PDF 同时移除原件、metadata、工作台 sidecar 和全局 Work 关联，主位递补；跨进程文件事务仍不承诺。

### Reader 与 annotations 共同 epoch（2026-09-13/14）

来源：epoch-review D1–D9、已批准 v2 及最终验收，原文见 [history](history.md)。I001 已修，以下长期取舍不随工程关闭失效：

- 正文/标注/资产由同次一致性读取共同接纳，不能凭相同 docId、Promise.all、mtime 或随机图片 URL 猜 epoch。同 fingerprint 不代表完整 IR 不变，仍接纳新 IR；rev 仅同 epoch 写锁，不是正文版本。
- 更新/失败保留旧文字布局与当前页面会话草稿；图片占位、高亮隐藏，标注写入/创建/定位及旧导航暂停。失败有明确状态和手动重试，不无限自动重试；确定 doc 不存在则 missing。
- 创建草稿文字需新选目标后由用户**显式**使用，不自动绑定/保存；跨 fingerprint 编辑草稿保留但禁存。不保证 F5/关闭浏览器/切 doc 后恢复，不新增持久草稿或迁移。
- 图必须校验实际返回 bytes 与已接纳 manifest 的 hash；不保历史图片、不新增资产 watcher，单独手改资产无通知不承诺即时发现。不借 server 强化校验改变 CLI legacy 行为或冻结错误形态。
- 图片首次失配只给一次追加自动 coherent GET，所有通知/尾随请求共用额度；额度用尽后即使曾短暂 ready，也不能凭后续通知重新开额度。只手动重试或切 doc 重置。可能因重复/自发 invalidate 而要求手动重试，是用户明确接受的保守取舍。
- server 已知 queued/running 内容 mutation 或删除 busy 时不读半成品、不 ensure/归档/广播 invalidate；只做 library rebuild 的全局 refresh 不等于正文 busy。server 同步临界段不等于跨进程文件事务。

完整接纳/草稿/图片规则见 [annotations](annotations.md)，原指纹三态及错误分支全部不变。

## 论证图（已决定，尚未实施）

来源：2026-10-11 至 10-12 论证图设计访谈；归属取舍见 [ADR 0009](adr/0009-argument-graph-work-owned.md)。以下是实施时必须成立的边界，不表示能力已存在。

- 论证图是 **Work 级项目数据**，每个 Work 至多一张，不是 Doc。它不参与内容指纹、标注归档或 Doc 的全局物理删除；出处的跳转目标不受保护，失效时只剩显示文字。
- 存储允许环，自环是结构错误、直接拒绝。同一对论证、同一角色至多一条边。只有论证的短标题必填；缺 Claim/Grounds/Warrant 是审计发现，不是写入失败。审计结果永不落盘。
- 所有写入带版本号：写入方必须基于它读到的最新版本，否则拒绝并要求重读，不覆盖。页面未保存的文字在冲突后保留，但需要用户重新应用。
- **覆盖非空的图**：页面的清空有确认对话框；Copilot 逐条增删改不需确认，整图替换或清空非空的图必须经真人确认卡（写明将被替换的论证数，模型不能自批）；CLI 整图写入覆盖非空的图须带显式的替换标志。
- **Work 合并**：幸存 Work 没有图时接手被并入 Work 的图；两边都有时保留幸存者的，另一张留在磁盘上不删除、不展示，并在结果中如实说明。Copilot 路径对会合并 Work 的导入照旧整条拒绝。
- 跨进程同时写同一张图不支持，不加文件锁（I013 的边界同样适用）；工作台发现磁盘变化后刷新页面。
- 新的 CLI 论证图命令在发布后进入冻结面：读出与写入的 JSON 带 `version: 1`，字段、键序和错误形态的改动需要新的明确决定。实现与原型验收完成之前不算发布。既有冻结命令的输出不因此改动。

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

## 已接受边界的稳定标识

以下保留原问题编号供历史关联，不是待实施队列：

- **I013**：跨进程同时 mutate 同 doc 不支持；只有明确需要这种并发时重议。
- **I014**：手动 rm 绕过入口的 orphan annotations 无自动清理/访问保证；恢复或迁移需另行批准。
- **I015**：CLI docId 沿用本地单用户直读信任模型，无额外穿越防护；corrupt IR 的既有错误形态受冻结保护。安全模型或接口契约明确变更时再议。
- **I017**：结构 id 非印刷号，重摄入可位移，未知深链接静默；section xref 不产右栏 float 卡。新的寻址/卡片语义需明确批准。
- **I019**：标注限一个 logical container、内容变则整批归档、archive 正常不可见；新 target 或显式迁移能力需另行批准。

I016/I018/I020/I032/I033/I034 的具体接受边界分别在 [tex-pipeline](tex-pipeline.md)、[plans](plans.md)、[annotations](annotations.md)、[writer](writer.md) 与 [library](library.md)。完整编号去向在 [迁移审计](migrations/memory-to-domain-modeling.md)。
