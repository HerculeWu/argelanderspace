# 契约与决策

整理：2026-09-16。这里保留用户意图与不可擅改的规则，不是下一阶段任务表。关键来源按“日期 + 原文件 + 决策号/节”定位；旧原文在 [history 的 Git 基线](history.md)可恢复。

## 1. 产品定位与范围

- **科研工作台，不只是文献工具；webui 是独立应用，不是 agent 看板。** 用户 2026-09-02 定位升级（旧 product-and-architecture / Stage 3.1 推后事项 / Stage 4 定位前提）。理由：无 agent 也应能操作，用户有亲自读论文的权利。当前 note/label 写路径缺口是未完成能力，不能将现状反推为永久只读定位。
- 当前单用户、项目级文件存储；dataDir 只按 cwd/显式配置解析，不向上查找（Stage 3）。全局库复用、SQLite 等没有实施授权。
- **CLI + skills，无 MCP** 是现行接入决定（Stage 2），不将当时对某 agent 上游能力的评论视为永久事实。文献任务用 sanctioned CLI，不从内部文件猜论文内容。
- 下一阶段由用户决定；阶段关闭不会自动启动候选项。Stage 4.1 仍推后。详见问题清单。

## 2. 摄入、身份与寻址

- main 只走 LaTeX 正文摄入，OCR/HTML 在 `ocr-features` 快照分支（2026-09-01 Stage 3.1 Q2/Q14）。DOI docless work 已于 Stage 7 Q4 开放，**不等于 PDF/HTML 正文摄入恢复**。
- web zip attach-only：先有 work，再挂 doc；同 work 上传 docId 幂等，身份 stamp+直挂+校验，不能重新按失配标题落到另一个 work（Stage 3.1 Q4/Q9/Q10）。
- **多 doc 独立存在，主位是 doc_ids[0]**（Stage 7 Q3）；原 zip doc 重传原位覆盖，上传给非 upload 正文的 work 保留原 doc。Stage 8 明确：系统不判断这些 doc 是发表稿/补充材料/自留稿，也不提供版本管理。
- **编译失败硬失败，无无编译解析降级**（Stage 5 Q4）；插桩失败可干净编译回退，图片失败可无图，这两种不能与编译失败混淆。
- **显示号全面印刷忠实**（2026-09-04 Stage 5 Q2，替代 Stage 3.1 自产 display 号）：未编号公式不显示自产 N。结构 id scheme 保持，但不承诺重摄入前后同一位置仍同号；增删块可级联位移，未知锚点静默兜底。
- 不引入 pagedView/page 字段/XDV 页面系统（Stage 5 Q6，YAGNI；prototype 只是验证参考）。TikZ 等有真实需求再立项，非隐含兼容义务。

## 3. Agent 输出冻结与回归策略必须分开

**2026-09-01 已退出 Python→TS 重构期**：bug-for-bug、Python 逐字段 parity 作为项目通用验收基线退役。普通 golden 可按行为变更从 TS 管线自洽重冻并人工抽查，不能因此恢复旧行为。

**但 Stage 6/7/8 的明确 agent 接口冻结继续有效**（Stage 6 Q7；Stage 7 硬约束；Stage 8 硬约束）：

- 既有 search/read/show/ref/note/label/list 命令面、markdown token、bib/ref JSON、深链接格式不擅改；golden `.md` 不重冻，继续作冻结守卫。
- 新命令 **annot 自诞生起入冻结面**。字段、顺序、排序、stdout/stderr、错误形态等详见 [annotations 专题](../memory-reference/annotations.md)。新增能力不等于可以顺手改旧接口。
- JSON fixture 的 agent 不可见 meta/图尺寸等增量可以走普通回归更新；已验证的每篇具体内容修正、原结构 id 位移，不等于获得无限输出变更授权。影响冻结面时先明确新决定，不借“普通 golden 可重冻”绕开。
- `search` 空 note 提示刻意走 stderr，stdout JSONL 可 pipe；`annot` mismatch 不能返回旧标注，也不能为了修文案偷偷改冻结输出。

冻结是在项目脱离重构后单独成立的契约，不能随旧重构细录一起删掉。

## 4. 文档标注：独立用户数据

来源：2026-09-10 Stage 8 产品定位、Q1–Q20 与用户终稿四修正；2026-09-12 关闭。实施细节见 [annotations](../memory-reference/annotations.md)。

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

### 归档权限与 PUT

- **归档权威仅 server GET/PUT annotations 访问路径**，共享幂等 ensureCurrentAnnotations；watcher 只通知，不承担归档写操作。未来若 eager，只可在确定性 ingest/job 完成边界另行设计。
- **CLI annot 真只读**：自行算 fingerprint，match 输出，mismatch 空 stdout+固定 stderr note，零写盘零归档。冻结文案含“archived”也不表示 CLI 实际归档。
- archive 字节原样保全外部未知键，不经 zod round-trip 重写；归档前仍做合法性 gate。UTC 毫秒名+旧指纹前8，碰撞加 -N，绝不覆盖已有档案；archive 对正常 reader/agent 不开放。
- 新 fingerprint epoch rev 从 0 开始，**PUT 必须双校验**：请求 fingerprint 不同 → ensure 后 409 document changed；相同而 rev 不同 → 409 rev mismatch；基础设施错误 → 500，不得假装 reload 成功。
- 文本创建目标遇 epoch 改变不能静默转为结构标注；应关闭并要求重新选。编辑草稿在 document-changed 后保留但禁存。

### 删除生命周期

`DELETE /api/paper/:doc_id` 是 **全局物理删除**：output + annotations（含 archive）一起删，扫描全部 works 摘除 doc_id，剩余 doc_ids[0] 自然递补为主，立即广播 library.changed。不是只从当前 work 解除关联。

- server 已知同 doc queued/running mutation → DELETE busy 409；反向删除中 upload 不得写入。DocMutationRegistry 生命周期互斥，不仅是 libraryLock。
- workspace 显式三态：删非 current 不变；删 current 且该 work 有剩则切新主；无剩则 currentDoc=null，并主动更新 paper list，不能等 watcher 碰巧修好。
- CLI 与 server 跨进程同时 mutate 同 doc 不支持，不做 filesystem lock；CLI 文档删除命令未提供。
- 绕过入口手动 rm output 后 orphan annotations 不自动清理，**无访问保证**，不能写成已有 migration 输入渠道。

### Reader 与 annotations 共同 epoch（2026-09-13/14）

来源：epoch-review D1–D9、已批准 v2 及最终验收，原文见 [history](history.md)。I001 已修，以下长期取舍不随工程关闭失效：

- 正文/标注/资产由同次一致性读取共同接纳，不能凭相同 docId、Promise.all、mtime 或随机图片 URL 猜 epoch。同 fingerprint 不代表完整 IR 不变，仍接纳新 IR；rev 仅同 epoch 写锁，不是正文版本。
- 更新/失败保留旧文字布局与当前页面会话草稿；图片占位、高亮隐藏，标注写入/创建/定位及旧导航暂停。失败有明确状态和手动重试，不无限自动重试；确定 doc 不存在则 missing。
- 创建草稿文字需新选目标后由用户**显式**使用，不自动绑定/保存；跨 fingerprint 编辑草稿保留但禁存。不保证 F5/关闭浏览器/切 doc 后恢复，不新增持久草稿或迁移。
- 图必须校验实际返回 bytes 与已接纳 manifest 的 hash；不保历史图片、不新增资产 watcher，单独手改资产无通知不承诺即时发现。不借 server 强化校验改变 CLI legacy 行为或冻结错误形态。
- 图片首次失配只给一次追加自动 coherent GET，所有通知/尾随请求共用额度；额度用尽后即使曾短暂 ready，也不能凭后续通知重新开额度。只手动重试或切 doc 重置。可能因重复/自发 invalidate 而要求手动重试，是用户明确接受的保守取舍。
- server 已知 queued/running 内容 mutation 或删除 busy 时不读半成品、不 ensure/归档/广播 invalidate；只做 library rebuild 的全局 refresh 不等于正文 busy。server 同步临界段不等于跨进程文件事务。

完整接纳/草稿/图片规则见 [annotations](../memory-reference/annotations.md)，原指纹三态及错误分支全部不变。

## 5. 计划页面的用户取舍

来源：Stage 4 Q1–Q17 / smoke 修订，Stage 7 Q6。详情权威在 [plans](../memory-reference/plans.md)。

- plans→tasks 两层；plan.due/task.due 都必填 deadline；task 新建预填 plan.due。Stage 4 smoke “必填”覆盖初稿 task 可选。
- task.due > plan.due 合法，只有非阻断软警告（Stage 7）：计划延期是正当场景，schema 不强制子任务早于计划。
- 列表拖拽只调序、不能跨状态组；看板跨列拖拽就是改状态，是故意不对称语义。
- 时间线只读；聚焦是 pin+派生组，不存冗余副本。链接只到 doc_id。
- 用户明确不做或推后：延期历史（用户自行 note）、tag、blockedBy、“等待延期结果”中间态（自建任务即可）、plan.start、跨计划移动、时间线拖期、anchor 链接。不要“完善任务系统”时顺手复活。
- Agent 操作计划 Stage 4.1 尚未立项；稳定 id/pretty JSON/watcher/纯 CRUD 是预留，不是已冻结的未来 CLI/API 设计。未知键 round-trip 与并发需到时评估。

## 6. Web 文案与 Writer 的用户取舍

来源：2026-09-14 Stage 9 D1–D7；2026-09-15 Stage 10 D1–D14；2026-09-15/16 Writer 改进 D1–D17（本次确认编号 Stage 11），原文入口见 [history](history.md)。

### Web 文案

- zh/en 集中 JSON，默认中文、Tweaks 即时切换并持久化、不探测浏览器。新 UI 双语同写；枚举标签在渲染期取值。
- Stage 9 中文**原样搬迁**与既有 12 份测试不改是当轮迁移验收，不把所有 UI 文案永久冻结。后续打磨须有相应任务授权；CLI 冻结另论。
- server detail/job.error 及用户数据未纳入翻译；不把英文模式仍有中文库名当成搬迁失败。不因本阶段选型恢复 server 中文化/错误码化或更多语言任务。

### Writer 边界与共享架构

- 独立 manuscript 数据，不入 library/work/doc，不挂 reader annotations。八型 cell、模板切换、per-cell 纯文本 comments 与源码 zip 导出；不做 template 内容管理 UI、稿件分类/关联/深链/独立 CLI。
- template 声明式 JSON、同 id 用户覆盖，cell 序列化全局固定；manuscript/template/cell 保未知键。用户数据损坏不静默 reset，编译 build 仅派生缓存；删除需停止并 drain 编译，避免复活稿件。
- **成熟编辑器 + 复用现有编译→facts/AST→IR→展示**是用户一直以来的意图，不是后备妥协。CM6/stex 不等于现成完整 LaTeX 补全，不为功能清单自研；不新增 TeX4ht 默认运行依赖。共享改造不得改变 reader 默认输出、CLI 冻结或引入摄入/标注副作用。
- latexmk 可按需多遍和处理 bibliography，替代 Stage 10 单遍限制；仍不交付 PDF 预览。引用语义/编号求真，但 cell 流式布局不还原 PDF 分页/字体；缺依赖/不支持明确暴露，不暗换模板或样式。
- References/Crossrefs 只插裸 key/label，覆盖 Stage 10 完整 cite 命令插入，不猜上下文。导出单 tex + **独立 bib** + 图的 zip；可带 EXPORT-WARNINGS，成功下载不保证已编译通过。
- 旧预览只能在精确源码/目标对应时保留并标陈旧；新/变结构处未解析，不能凭同 label/旧环境序号套旧编号。失败不清稿件、不阻塞写作和保存。
- 许可未核清的模板文件不随 npm 分发；aa.cls/aa.bst 可经授权本机补齐。依赖按各自许可证保留 notices，不全改标 MIT，不把外部进程调用和内联分发混为一谈。

### 最新显式渲染决定（已确认，未实施）

2026-09-16 Writer 改进 D17：**编译/渲染改为用户 Shift+Enter 或点击 Render 后统一显式触发，不再由停止输入/自动保存启动；自动保存继续保留。** 理由是保护连续输入，避免上下跳动、大文档卡顿及频繁重绘。覆盖 D7 和旧共识§5.1，仅改触发方式，不取消共享 IR、latexmk 缓存/多遍与陈旧/失败保护；不能用加长 debounce 替代。当前代码尚自动编译，差距记 I031；Report citation 未通过记 I030。阶段已关闭不授予自动修复权限。

完整当前机制与范围见 [writer](../memory-reference/writer.md)。

## 7. 记忆权威与执行授权

2026-09-13 用户三轮 Q1–Q19 及最终实施授权确立新的记忆制度，替代“每次直接往正式 memory 新增文件”的旧规则。

- 日常 session → inbox，单独授权 → 正式归并；有权的新决定覆盖旧决定，事实按证据更新；详细协议以 [inbox/README](../inbox/README.md) 为准。
- 保存用户关键理由与否决项，活动资料不是全部历史；所有记忆限 `.pi/`。
- **已关闭各阶段的实施、自行 commit、审查流程授权不是今后永久权限。** 工程四门继续有效；新的执行/审查/提交/push 范围按当次用户授权及适用工具治理规则执行。
- 2026-09-16 本次特别授权先核验并提交上一阶段既有代码与记忆原文，再归并 inbox；不修代码、不迁移用户数据、不推进下一阶段、不 push，整理结果不自动提交。当前提交/执行事实只见[本次 inbox](../inbox/2026-09-16-mem-merge-stage11.md)，不把一次性授权继承为未来权限。
