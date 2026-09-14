# Reader 与 annotations 共同 epoch：探索与用户决定

- Session：epoch-review
- 创建：2026-09-13T23:46:48+02:00
- 更新：2026-09-14T09:23:37+02:00
- 工作状态：完成（工程验收及用户 smoke 通过；已授权提交推送，结果以 Git 为准）
- 归并状态：未归并
- 范围与授权：架构只读探索、临时 HTML 报告、候选一决策讨论；用户后续明确“确认，先形成方案”，授权在 .pi/memory-reference/ 编制方案。用户后续明确“开始实施”，已授权按批准方案修改代码与验收；最终明确“标记为通过，提交并push”，授权本轮代码/测试/方案/inbox提交并正常推送，不强推；不修改正式记忆。

## 已确认决策

### D1 — 目标与范围（Q1–Q4）
- 决策时间与来源：2026-09-13，用户第一轮“全部按推荐”；逐题精确时间未记录。
- 修复 I001 一致性而非仅移动代码；当前打开 doc 的正文自动更新，不要求 F5；允许短暂加载，不要求无缝双份正文切换。
- module 集中承担正文、annotations、targets 与草稿切换规则；具体 interface 尚待取证与讨论。
- 范围仅当前 doc 一致性与必要测试；不包含删除恢复、标注迁移、版本管理、跨进程并发。CLI 冻结与标注三态/归档权威等契约不变。
- 覆盖：I001 当前手动刷新 workaround → 拟实施目标为自动一致更新；不是已修复事实，也不自动授权执行。

### D2 — 切换、失败与位置（Q5–Q7）
- 决策时间与来源：2026-09-13，用户第二轮“全部按推荐”。
- 加载期间保留旧正文供阅读并明确提示更新中；隐藏旧高亮/定位标记，暂停标注创建、保存及定位；确认正文与 annotations 一致后恢复。
- 更新失败保留旧正文与草稿，明确旧正文及失败，提供手动重试，不无限自动重试；标注写入保持禁用。明确 doc 已删除则进入文档不存在状态。
- 更新后尽量保留滚动位置，提示位置可能变化，不承诺语义定位、不 re-anchor；清旧选区、激活状态与待创建 target。
- 编辑草稿在 document-changed 后继续保留但禁存；创建草稿保留正文文字供重新选位后使用，不保留旧 target 的有效性。
- 覆盖：无。细化新候选，保留现有数据契约。

### D3 — 草稿保护范围（Q8–Q9）
- 决策时间与来源：2026-09-13，用户第三轮“全部按推荐”。
- 仅保证当前页面会话内自动更新/更新失败不丢草稿；不新增持久存储，不保证 F5/关闭浏览器后恢复。
- 重新选择 target 后由用户显式选择使用保留的创建草稿文字；不自动绑定、不自动保存、不构成标注迁移。
- 覆盖：无。为 D2 限定范围。

### D4 — 资产发现与旧图保护（Q10–Q11）
- 决策时间与来源：2026-09-13，用户第四轮“全部按推荐”。
- 不新增资产目录监控；自动更新覆盖正常摄入与现有通知。完整 fingerprint 仍包含资产；无任何现有通知的单独手改资产不承诺立即发现。
- 不保留历史图片快照。更新期间保留旧文字及布局，图片用占位；失败继续占位并提示不可用。恢复展示须与接纳的 epoch 对应，不以 URL 随机参数代替一致性证明。
- 覆盖：D2 的“保留旧正文”细化为旧文字/布局，不保证保留旧图片字节。

### D5 — 责任分工与有界恢复（Q12–Q13）
- 决策时间与来源：2026-09-13，用户第五轮“全部按推荐”。
- server module 在现有 annotations 访问路径内提供同一次一致性读取的正文、完整 fingerprint 与 annotations；维持归档权限及三态规则。
- web module 集中接纳异步结果、请求乱序控制、加载/失败状态、草稿及交互启停。
- 图片读取 adapter 校验预期资产内容，不匹配拒绝展示；不新增通用存储抽象。具体字段/函数签名留后续实施方案。
- 图片可按需加载，不必全文下载完成才恢复阅读；每张实际展示图片须通过对应校验。发现图片已变化则拒绝显示并重新进入一致性更新，同一轮自动恢复最多追加一次读取，再变或失败则停在失败状态、等待手动重试。
- 覆盖：无。深化 D1/D4，不改变 CLI 冻结与标注数据契约。

### D6 — 整体共识确认与方案授权
- 决策时间与来源：2026-09-13，用户在 Q1–Q13 总结后明确“确认，先形成方案”。
- 确认前述整体共识及验收重点：真实正文变化、乱序/重复通知、图片变化、失败/草稿/滚动；代码四门及真实浏览器验证。
- 授权先编制具体实施方案，放 .pi/memory-reference/ 标待批准；不自动执行代码修改或 commit/push。
- 覆盖：交接中“待最终确认”已完成；实施授权仍未给予。

### D7 — 批准 v2 方案及保守恢复取舍
- 决策记录时间：2026-09-14T00:10:05+02:00。
- 来源：父代理交付方案并明确询问“是否接受这项取舍并批准方案”，用户回复“批准”。
- 结论：v2 方案已批准；接受一次资产自动恢复额度用尽后，即使短暂 ready，后续通知也不自动重读，直到手动重试或切换 doc。
- 覆盖：方案及 F3/交接的“待批准”→已批准；不追溯改变其历史审查状态。
- 授权范围：本轮问题仅请求方案批准，没有请求开始代码实施；故不将“批准”扩大为实施、commit/push 授权。下一步询问是否开始实施。

### D8 — 开始实施
- 决策记录时间：2026-09-14T00:12:59+02:00。
- 来源：用户明确“开始实施”。
- 授权按已批准 v2 实施 M1–M4，包括必要代码/测试、四门、合成临时库真实浏览器验证及只读审查；不操作真实文献数据，不 commit/push。
- 覆盖：D7 及方案头部未获实施授权 → 已获实施授权；其他约束与 commit/push 限制不变。
- 工程安排：当前 main@96d392a，起点仅本 inbox 与方案两个未跟踪文件；串行单写入者，不为 worktree 要求干净而擅自提交或藏起这两份文件。阶段交界已提醒整理记忆，不自动归并。

### D9 — 用户 smoke 通过与提交推送授权
- 决策记录时间：2026-09-14T09:23:37+02:00。
- 来源：用户在收到8项smoke步骤后明确“标记为通过，提交并push”。
- 将本轮用户smoke标为通过；依据用户确认，不伪造各人工步骤、OS输入法或所有浏览器时序的逐项实测日志。
- 授权提交本轮41个源码/测试文件及方案/inbox两份文档，正常push origin main，不强推；不归并正式记忆或开启新产品阶段。
- 覆盖：D8及后续交接的“用户smoke待进行、commit/push未授权”→用户smoke通过、提交推送已授权。F4–F6过程中的待验/未提交描述保留为当时事实。
- 提交前源码与最终验收快照342/342 SHA256一致，复用该树四门及浏览器证据；本次仅更改收尾文档，无代码变动，不重复跑全四门。commit/push结果以实际Git及最终回复为准，不提前声称成功。

## 已验证事实

### F1 — 架构探索与报告
- 观测日期：2026-09-13，main @ 96d392a；探索启动工作区干净。未读取用户数据，未运行测试。
- 静态证据：DocPane.tsx:22–41 仅按 id 重取 IR；AnnotationStore.tsx:116–179 独立加载 annotations，409 后可用旧 blockById 重建结构 snapshot。web/tests/annotations.test.tsx:936–968 仅变 fingerprint 不变 IR，不能证明新正文一致性。
- I008 历史结论待核实：core annotations/store.ts:444–467、490–507 的 archive/ensure 为同步实现；本次未发现单 server event-loop 中 ensure 可交错的路径。不宣称 I008 已修，也不将锁外直接当成双归档证据。
- 临时报告：/tmp/architecture-review-20260913-233706-746919436.html，已调用 xdg-open。临时文件非持久权威；报告另一个生命周期候选未被用户选中。
- 子代理证据：workflow 2e3e4247-646a-486d-9042-479113acb6c8，child 95e9971f-c6c1-4827-bdbb-eb1b4759cdb7 completed；产物位于 harness session 的 subagent-artifacts/outputs/对应 workflow/architecture-findings.md。

### F2 — 一致性读取与草稿生命周期缺口
- 观测日期：2026-09-13；只读 scout c4246594-28ff-4afd-8999-53400632664a completed，未运行测试。
- web/api.ts:13–24 和 server/app.ts:278–324：IR 返回无 fingerprint，annotation GET 独立读取并 ensure；现有传输不能证明同 epoch，Promise.all 不能补关联证明。
- server/watch.ts 不看资产；paper-cache.ts 仅 JSON stat，不能替代完整 fingerprint。图片路径无 epoch 绑定。
- AnnotationStore.tsx:116–120 等 GET/PUT 直接接纳 file，缺同 doc 请求乱序控制；rev 仅同 fingerprint 内可比较。
- DocPane 加载/失败卸载 reader 子树；AnnotationPopover/Editor 草稿为局部 state，关闭或卸载会丢。创建文字需有独立于 target 的存活位置；同 doc prop 更新本身不必卸载 provider。
- 产物：/home/wwu/.pi/agent/sessions/--home-wwu-project-bibgraph--/subagent-artifacts/outputs/c4246594-28ff-4afd-8999-53400632664a/context.md。结论为静态取证，不冒充动态验证。

### F3 — 方案 v2 与初审
- 观测：2026-09-14T00:05:02+02:00；[方案草案 v2](../memory-reference/2026-09-13-reader-epoch-plan.md)已落盘，待批准。
- 初审发现两项 P1：资产恢复额度可能被 trailing GET/WS 绕过；共用强化资产 reader 会改变冻结 CLI 的 symlink/错误行为。父代理已修订，不能将初审 BLOCK 写成通过。
- v2 选择保守预算：所有自动 GET 共用额度，无通知覆盖证明时停止并请求手动重试；自发 invalidate 也可能导致失败，这是待批准技术取舍，非新增用户决定。server 强化校验前置层与 CLI legacy 行为分开。
- 已追加 draft revision 清理、同 fingerprint 最新 coherent GET 合法 rev0、docId 归档前校验。
- 复审从 retained reviewer 恢复，run b9c61e1e-13f7-4d7e-b908-990c111f0f78 completed，OK with notes；两项方案阻塞解除，具体 UX 取舍仍需用户接受，不是代码验收。产物复用 epoch-plan-review.md，已成为复审文本；初审发现与修订保留于本条和方案。
- 2026-09-14T00:07:37+02:00：方案与本 inbox 为仅有两个未跟踪文件；无代码改动，无 commit/push。

### F4 — M1–M3 已实施，M4 部分验证及代码初审
- 观测：2026-09-14T01:19:14+02:00，main@96d392a 未提交树；31 tracked 修改 + 9 新源码/测试文件，两个原方案/inbox保留，暂存为空，diff --check通过。
- workflow `8544bbdd-6d7d-48dc-88b4-1734fddc46f4` completed：backend `c8fb1d20-0ce2-4363-ad0a-8ffd6785bc7b`、frontend `02d79ad0-930f-47df-84ff-c8e1f4eeae6b`、validation `f6775ede-a756-4987-85c0-c64533e7b01b`、review `ff62624c-5e61-4868-a5bf-dddfbbb7761f`。
- 实施：coherent annotations opt-in读取、同读manifest、内容busy门、验证图片；ReaderSession统一接纳/预算/草稿、Blob图片全surface、导航和标注代际门。stored IR wire用实际TexDocIrSchema保留meta/source。CLI源码/golden未改，symlink及错误冻结回归通过。
- 独立四门均exit0：57 files/894 tests，无skip；这是修复前实施树证据，后续改动需重验。
- Chrome150.0.7871.186/raw CDP/真实server+合成临时库：已观察无F5 A→B、main及scroll650保留、sync图片/高亮清空、A/B实际Blob hash、创建原字节草稿及显式恢复、编辑跨fp禁存、读失败终态和单次late图mismatch预算。非真实上传摄入或用户smoke。
- 探针基础设施失败：attempt1 CDP -32000 Object reference chain is too long，父代理批准仅/tmp boolean修复后同协议attempt2通过；attempt3 Page.navigate+Fetch暂停死等180s，已停止并清理自有进程。未把它们作为产品缺陷。源码快照、四门日志及原始证据保存在报告旁 gates-and-browser-evidence/，不只依赖/tmp。
- 独立代码初审BLOCK：P1 store.focusReference未检查current()，旧ref深链接850ms timer可在B ready后滚动新右栏；P2 丢弃编辑草稿后popover局部editSession不清，留下空白编辑态。父代理接受两项为当前范围修复，随后定向回归与重验。
- M4仍未完成：pending深链接、smooth jump/undo/observer及用户接管、选区弹层/真实composition、table/右栏surface、迟到decode/load、缓存及busy/404/500等需补证，不能用happy-dom替代。
- 产物根：/home/wwu/.pi/agent/sessions/--home-wwu-project-bibgraph--/subagent-artifacts/outputs/8544bbdd-6d7d-48dc-88b4-1734fddc46f4/，实施 implementation/{backend,frontend}.md、验证 validation/gates-and-browser.md、审查 review/epoch-final.md。

### F5 — P1/P2 修复复审通过，浏览器确认 V1
- 观测：2026-09-14T01:39:59+02:00。worker follow-up `a6dceaeb-395b-4983-b9b4-93ec4bf98f98` 在store.focusReference加current()、Popover在draft消失时退出编辑，2个回归先红后绿；web279通过。review follow-up `7167c68e-0df6-4cb9-a171-3a4c597d30b8` SOURCE REVIEW OK，两项关闭。
- validation follow-up `3d9423e2-ddfb-4fad-8e26-649eba3100ec` completed：最新四门57 files/896 tests全通过无skip，342源码hash前后相同。真实Chrome补验去重13用例12通过1失败，含B实际text quote Alpha synthetic B及figure Caption B/hash落盘、CDP真实composition链但非OS输入法、多surface Blob、迟到fetch确证ERR_ABORTED、busy/500/404、严格预算及P1/P2动态验证。
- V1（当前确定产品缺陷）：sync保留旧main时，正常location.hash=#p-50触发浏览器原生锚点滚动0→7007，coherent仍暂停；Shell声明支持manual hash edits，不能当探针错误。父代理接受为本范围修复；ordinary初始无旧main跨error/retry、ann/ref pending已通过，不混同。
- 验证脚本归因：attempt1错误port0导致403为探针配置（实际port重跑正常保存）；直接赋scrollTop不足模拟用户接管，改真实wheel后通过；Invalid InterceptionId只有同networkId canceled ERR_ABORTED证据才视预期取消。均同subagent/raw-CDP协议内获准修正，不改产品安全规则。
- 新证据在原validation报告旁 gates-and-browser-followup-evidence/，旧报告previous-report.md及各attempt保留。当前M4未关闭，除V1还须明确OS IME/迟到decode等验证局限；不把合成controlled WS说成正常upload端到端。

### F6 — V1 修复、最终验收与收尾
- 观测：2026-09-14T02:13:27+02:00，main@96d392a未提交树，32 tracked源码/测试修改 + 9新增源码/测试 + 本inbox/方案两份文档，无暂存。
- V1 worker `71339cb5-8b21-43f1-a290-df46add1b17f`：Block/Reader/RefCard不可导航时声明式撤原生id，保留data-block-id/正文节点，不加scroll锁或修改URL协议；新增3回归，web282。Chrome修前sync 0→7007及history提前滚动红，修后普通/编码/section/unknown/error/history/wheel绿。
- 最终SOURCE REVIEW `59895336-c118-4e31-bb9c-227424a6b880` OK：V1关闭，P1/P2保持关闭，无已知源码阻塞。只读审查不是用户验收。
- 最终validator `64390d49-7a01-4137-9721-dd4f53fe65b1` completed：四门分别exit0，57 files/899 tests，无失败/skip（contracts53/core271/infra60/web282/server182/cli51）。342 packages文件SHA256前后匹配。父代理核对四门状态文件、源码hash清单结果、V1四关键文件实际hash、diff --check和无暂存，并查看真实上传B截图。
- 最终树17个独立Chrome用例均有通过证据：普通/ann/ref pending，旧ref timer、discard恢复、smooth/undo/真实wheel接管，5个图surface Blob及迟到fetch取消，B文本quote/结构snapshot实际PUT，CDP composition链，V1 sync/error/编码/history，双草稿/高亮/图片冻结，严格额度、busy/500/404，真实合成zip上传A→B。
- 真实摄入：正常REST POST202→latexmk→IR→rebuild→job.done→自然library.changed，无手工notify；打开reader sameMain且自动接纳B、coherent+1、无F5。仅临时article zip，不访问真实文献；未测试web上传按钮/file chooser的完整体验。
- 验证非“零过程失败”：初轮DOM赋值returnByValue仍触发-32000（获准/tmp void修复）；ref1600ms淡出后的class断言错误改为真实事件；最终完整轮15/17，最后2定向补证2/2。草稿失败为通用selector命中另一并存编辑器；精确777断言观测797，布局高度+20且原段视口相对位置差0.3125px，真实wheel到1037后6秒无回拉，符合best-effort，不声称像素全称/内部根因已证。全部旧失败保留，不以exit码掩盖。
- 持久证据：F4产物根下 validation/gates-and-browser-final-evidence/（342源码快照、hash、四门日志、逐case JSON/CDP、截图、上传TeX/zip/编译IR/job）；最终 validation/gates-and-browser.md、review/epoch-final.md、implementation/frontend.md为最新正文，旧报告在各evidence/previous-report.md。/tmp只作原始临时副本，自有Chrome/server进程已清理。
- 结论：I001在本次批准范围内已修复并有正常摄入到reader的工程证据；M1–M3及M4受测工程范围完成。用户smoke未进行，不关闭产品阶段、不自动启动下一阶段。
- 剩余验证局限/人工项：OS中文输入法候选（CDP composition不是OS IME）；不同尺寸/边缘弹层、触摸/键盘非穷举体验；decode/onLoad已排队后的全部迟到组合（已验证fetch取消/Blob代际）；web上传file chooser。已批准保守资产预算、同步hash成本、无资产watcher/跨进程保证等不变。无未解决已证实产品阻塞。

## 交接状态

- Q1–Q13、整体共识及 v2 已批准；代码实施、三项修复复审和受测工程验收完成（F6），用户smoke通过（D9）。
- [方案](../memory-reference/2026-09-13-reader-epoch-plan.md)标为已完成、用户smoke通过；执行结果在F4–F6、最终用户确认及Git授权在D9。原文保留，不归并/裁剪。
- 未访问或变更真实literatures/status，未改CLI源码/golden/依赖/.pi/settings；D9现已授权本轮提交推送。完成后不自动开启下一阶段，也不继承本次授权到未来任务。
- 未创建 CONTEXT.md；没有新增已命名领域概念，未找到 domain-modeling/codebase-design skill。使用项目正式记忆领域词与用户给定架构术语。
