# 2026-09-21：旧记忆迁移至领域文档

状态：**完成，已切换入口并退役旧活动目录**。本页记录 2026-09-21 本次迁移的工作区验收快照；验收时尚未 commit/push，用户随后明确授权本次提交推送，实际结果以 Git 提交及本地执行票据为准。本页不是新的 session 日记或现行规则副本。

## 授权与边界

用户在本会话确认：Matt 默认 single-context（CONTEXT＋docs/adr）、本地 Markdown tracker（`.scratch/` 不入公开 Git）、默认五态加 deferred（排除执行队列、用户显式重开）、公开工程文档与私有任务/讨论分离，随后明确“可以开始实施”。

迁移阶段允许文档迁移、忽略规则与两处旧引用注释修复；不改产品行为或用户数据，不 commit/push，不创建 GitHub issue/标签，不修改技能与工具设置，不重写历史。未委派子代理，检查不冒称独立审查。

后续一次性授权：用户在验收后明确“很好，请commit+push”。仅提交并推送本次公开迁移改动，排除预存 `.pi/skills/` 与私有 `.scratch/`；不继承为后续任务的提交权限。

Git 起点：main，HEAD=`46093915ab1c597eb3b1ce0a28ce73aaef99f37a`；只有预存未跟踪 `.pi/skills/`。它不属于本次迁移产物。

## 原文保全

2026-09-21（观测日期，运行环境时区 +02:00）只读核验：以下17份源文件与上述提交各自路径**逐字节相同**，合计 **251,883 UTF-8 bytes**。切换前再次比较全部17份及旧 AGENTS；退役后从 Git 恢复并对照本表，17/17 大小与 SHA-256 一致，不只验证它们曾在历史出现过。

| 原路径 | bytes | SHA-256 |
|---|---:|---|
| `.pi/memory/00-index.md` | 4409 | `07be7c81d42e81dc3194f2080130f064066847d94ceed600bb3f63d6dbf45683` |
| `.pi/memory/product-and-architecture.md` | 17003 | `e2c9278f68fe01809d8fcc77b28f07b09503215f0f4ebc39ce8ff58ad5089a20` |
| `.pi/memory/contracts-and-decisions.md` | 25592 | `7ff8647b57261ac037b7040dad83d02e3d4d761b6094b6fccf2263a824843fda` |
| `.pi/memory/known-issues.md` | 11440 | `01fe9fc960758e882d23d232dfb37b25034a023ec8030870a66f43bbd5877974` |
| `.pi/memory/engineering.md` | 18503 | `58cc47ab662fd2b886baca4bafbce0253af31792f03455996c19949222d56238` |
| `.pi/memory/history.md` | 14701 | `a55546f679115e38f0325905d957744a8b9c6fa61941aa583f57b6eeb1ad4664` |
| `.pi/inbox/README.md` | 8161 | `fee5d25f78bbca80638e674b1409e65918f6bc59192512cb3124349b3318527b` |
| `.pi/inbox/2026-09-16-01a0abdd-stage13-kickoff.md` | 13424 | `6ac52f2208dcdacaa383fd23939f32cb01b14e4d9056bb8564ec7350a77e19a0` |
| `.pi/inbox/2026-09-17-stage15-arxiv-auto-ingest.md` | 19335 | `19da63bda1eb8184d702e220ff71f6c07238d3680afe2833c09d7ac6a0a82e68` |
| `.pi/memory-reference/annotations.md` | 16359 | `7c68623deab3e933df29e313ea4ab9b24ab2df76d1a44660a4b70581851fac03` |
| `.pi/memory-reference/tex-pipeline.md` | 14207 | `93badfec890568fe5a5ed3d9267cc1a61c2c13da804953aadb9d746d6bbb71e3` |
| `.pi/memory-reference/plans.md` | 6448 | `8a3ff10de9936599938c170c8ebe6c6b21714e1b5e14992e87a84a3b8df0af03` |
| `.pi/memory-reference/writer.md` | 13070 | `0d48febfadb65691589c2f1bc14ed4579ba31b9960928dc3b909be2760bce275` |
| `.pi/memory-reference/stage14-discovery-plan.md` | 24994 | `d36f9631c12b86e8058d406b0208fcfdc310e3bdef81ddbdeeee8db02753f599` |
| `.pi/memory-reference/stage15-arxiv-auto-ingest.md` | 10269 | `c2e22c3f3fec34b24ab46dec5b759595d72d2072930161bb7e0747b983d6eeea` |
| `.pi/memory-reference/2026-09-13-memory-restructure-audit.md` | 18736 | `2c2ce10607f4212d29ba99ff6c9a49e359d463867b702fc81d18f99aedafd2b1` |
| `.pi/memory-reference/2026-09-16-inbox-merge-audit.md` | 15232 | `3cb5a844d5b71edc6252a8195a8423dfd4a75407e6a59ff237d5bbf79ba319f1` |

恢复示例：`git show 46093915:.pi/memory/contracts-and-decisions.md`。更早的 `.kimi-code` 与 Stage 10/11/12 原文基线、缺失 D15/F8 说明均保留于 [history](../history.md)。不为清理旧文件追加未经授权的原文提交，也不将旧公开历史伪称已私有化。

## 内容去向

| 旧来源组 | 新权威或历史处理 |
|---|---|
| memory/00-index | AGENTS 与 docs/agents/domain 导航；阶段结果进 history；旧全量启动义务退出 |
| product-and-architecture：领域身份 | CONTEXT 定义；具体标识符/主位/创建/挂载进入 library |
| product-and-architecture：能力、存储、包、同步、agent | architecture；具体规则链接各专题，不复制完整契约 |
| contracts §1/§2 摄入边界、§3 冻结、§4 标注保护 | contracts；Library/Discovery 产品语义分别进入专题；ADR 只解释取舍 |
| contracts §5 计划、§6 Writer/i18n/bib | plans、writer、既有 writer-data-model、engineering、library；保留理由和未实施边界 |
| contracts §7 / inbox README 旧制度 | 用户本次决定替代为 AGENTS＋docs/agents；权威、保全、敏感信息与执行授权边界保留 |
| known-issues 全部35编号 | 下表逐项映射；21份私有票据、11项接受边界、3项历史关闭，零默认 ready 票据 |
| engineering | 通用环境/验收/打包/兼容/数据迁移/研究教训进入 engineering；本机版本/hash/凭据位置/网络结果进入私有 `.scratch/memory-migration/local-environment.md` |
| history | docs/history：阶段结果、替代链、原文基线、来源缺口；旧授权不继承 |
| Stage 13 inbox D1–D18/F1/F2/Q1 | library 的最终创建规则与历史；撤回的 arXiv 限制按 D17；suggested 被 Stage 14 替代；exportBibtex Q1 已关闭，不新建票据 |
| Stage 15 inbox D1–D19/F1–F4 | library 场景表/触发/日志/API/config；I035 私有推后；最终关闭/验收进 history，旧“待 smoke/无授权”只留 Git |
| annotations 专题 | annotations 机制/投影/epoch/草稿/交互；完整 CLI annot 冻结段移 contracts，非双份维护 |
| tex-pipeline 专题 | tex-pipeline，保全部机制盲区与受测边界；I016 接受行为归此 |
| plans 专题 | plans，保否决原因、I018 和未来 Stage 4.1 非冻结设想 |
| writer 专题 | writer 工作流/隔离/兼容、现有 writer-data-model 文件协议、library bib；I033 接受范围保留 |
| Stage 14 已关闭方案 | discovery 的查询/边/缓存/HTTP/UI/只读边界与图自愈；ADR-0004 理由；旧实施时序、临时原型和测试清单全文留 Git |
| Stage 15 已关闭方案 | library 的最终行为，旧 WS cause/reassert 设想按最终记录纠正；完整过程留 Git |
| 两次旧整理审计 | 全文在基线 Git，history 可定位，不另建活动副本 |

ADRs：Work/Doc 分离、编译事实与共享 IR、标注绑定/整批归档、Discovery/Library 分离。不是每个 D 条目都变 ADR，也没有把一般实现笔记塞进 glossary。

## I001–I035 去向索引

本表只保留迁移时的分类与定位，不跟踪私有票据后续进度，不复制私有正文。票据编号位于 `.scratch/legacy-backlog/issues/`，完整路径可按 `Legacy ID:` 查询；不存在私人目录时按 [tracker 规则](../agents/issue-tracker.md) 请求恢复。

| ID | 迁移时分类 | 权威位置 |
|---|---|---|
| I001 | 已关闭 | history 的 I001 |
| I002 | 开放 | 本地票据 01 |
| I003 | 开放 | 本地票据 02 |
| I004 | 开放 | 本地票据 03，完整五篇原因保留 |
| I005 | 开放 | 本地票据 04，机制详见 tex-pipeline |
| I006 | 开放 | 本地票据 05 |
| I007 | 开放 | 本地票据 06 |
| I008 | 待确认 | 本地票据 07，不升级成确定 bug |
| I009 | 开放 | 本地票据 08 |
| I010 | 开放 | 本地票据 09 |
| I011 | 开放 | 本地票据 10 |
| I012 | 开放 | 本地票据 11 |
| I013 | 接受边界 | contracts |
| I014 | 接受边界 | contracts |
| I015 | 接受边界 | contracts |
| I016 | 接受边界 | tex-pipeline |
| I017 | 接受边界 | contracts |
| I018 | 接受边界 | plans |
| I019 | 接受边界 | contracts |
| I020 | 接受边界 | annotations |
| I021 | 推后 | 本地票据 12，deferred |
| I022 | 推后 | 本地票据 13，deferred |
| I023 | 推后 | 本地票据 14，deferred |
| I024 | 推后 | 本地票据 15，deferred |
| I025 | 推后 | 本地票据 16，deferred |
| I026 | 推后 | 本地票据 17，deferred；保留原组合，不擅自拆范围 |
| I027 | 推后 | 本地票据 18，deferred |
| I028 | 推后 | 本地票据 19，deferred；不复活其余否决项 |
| I029 | 待确认 | 本地票据 20，不宣称当前仍有缺陷 |
| I030 | 已关闭 | history 的 I030 |
| I031 | 已关闭 | history 的 I031 |
| I032 | 接受边界 | annotations |
| I033 | 接受边界 | writer |
| I034 | 接受边界 | library |
| I035 | 推后 | 本地票据 21，deferred |

## 规则替代与冲突修正

- 所有记忆限 `.pi/` → 公开领域/技术文档＋私有 `.scratch/`。
- 全读 memory/inbox → 必读 glossary/硬契约，工程与专题按工作面读。
- 日常只写 inbox、再单独归并 → 授权任务内直接维护确认知识，任务过程进各票据；纯只读仍不写。
- 旧阶段方案目录 → 新规格/票据进本地 tracker；8份/40KB inbox 提醒随中央 inbox 退出，不新增自动整理。
- Writer 数据文档旧“保存后自动编译”按 Stage 12 改显式触发；导出依赖补齐已有最终行为，不改代码。
- 旧 history 的“显式触发尚未实施”、Stage 13 的假导出待确认、Stage 15 旧等待交接，均按后续有权决定解释，不机械按文件 mtime 排序。
- Stage 15 旧方案“复用 upload cause”和刷新也 reassert 的文字以最终 ingest cause / 仅 attach reassert 为准。
- Stage 14 旧 history 断链不搬入新文档；现行规则链接改新权威，历史引用明确 commit:path；两处 Writer 头部注释改指现行文档与历史入口。

## 验收结果

- **源文保全与退役**：前后核验17份原文；原 `.pi/memory/`、`.pi/inbox/`、`.pi/memory-reference/` 活动目录已删除；`.pi/settings.json` 字节不变，预存 `.pi/skills/` 未修改。
- **契约保真**：指纹三态（全部异常分支）、归档/PUT、删除生命周期、CLI annot 输出段与原文逐字相同。共同 epoch 段仅专题链接位置变化；agent 冻结段仅将旧专题入口改到 contracts 中的 CLI 全文。其余标注定义与用户取舍作逐组内容核对，未压成 ADR 摘要。
- **问题保真**：I001–I035 在表中各一次；21份旧票据一一保留 Legacy ID，12 needs-triage（含两项待确认）＋9 deferred，全部 not-started，零自动 ready。五篇编译失败逐因表完整留在私有 I004。接受/关闭事项没有伪造新任务。
- **本地权限与状态**：triage 五态＋deferred、普通实施进度与 Wayfinder 生命周期分开；deferred 明确排除执行 frontier。导入不是执行授权，公共 clone 无私人 tracker 不表示没有待办。
- **文档检查**：21份相关公开 Markdown 与25份私人 Markdown 的 UTF-8、末尾换行、行尾空白、相对链接及锚点通过；公开链接不依赖被忽略的私人文件。两处源码引用已改新入口，现行 AGENTS 不再消费旧记忆路径。
- **隐私**：25份 `.scratch/` 文件全部经 git check-ignore 验证，git ls-files 中为零；没有 force-add、公开 tracker 操作或私人正文副本。原已进入 Git 的内容仍可历史恢复，不宣称已变私有。
- **改动范围**：tracked diff 限于17个旧文档删除、AGENTS/.gitignore/既有 Writer 文档、两个 TS 头部注释；两个 TS 文件 `*/` 后的实现/测试主体与基线字节相同。新增公开文件为本次领域/技术文档，未混入预存技能。Git index 空、HEAD 保持基线，未 commit/push。
- **入口阅读量**：不含 AGENTS 和按需专题，旧启动正式记忆＋inbox 为132,568 B；新开发/设计前 glossary＋完整硬契约为16,381 B，工程任务另读17,009 B 工程指南。缩减的是无关必读，不是删除数据保护分支；这些为本次快照数字，不是长期硬配额。
- `git diff --check` 通过；未跟踪的新文档另作内容/链接检查，未以该命令代替新文件验证。

### 新入口恢复演练

父代理按新入口逐题查验，并对关键结论做文本断言；这是文档一致性演练，不是独立 fresh-context 审查或产品功能测试。

| 问题 | 新材料给出的答案 |
|---|---|
| 指纹算不出、IR/asset/current 损坏怎么办？ | contracts 的完整三态及错误分支：系统错误，不归档/不重写用户标注 |
| CLI annot 的 archived 措辞是否赋予归档权限？ | contracts 的只读 CLI 段：不赋权，match/mismatch 输出与原冻结形态不变 |
| DELETE 只从一个 Work 解绑吗？ | contracts：全局物理删除 output＋annotations/archive，扫描全部 Work 摘除 |
| Writer 保存、打开、外部变更是否编译？ | writer-data-model/writer：不自动，Render/Shift+Enter 显式触发，自动保存保留 |
| 用户只有上传 Doc 时能被 arXiv 自动替换吗？ | library 场景 C：不触发、不覆盖，手动端点冲突 |
| 探索 GET 会写入 Library 或排获取 job 吗？ | discovery：不会；显式保存才走独立的权威 mutation，随后可继承 arXiv 获取 |
| I035 等推后事项可被 agent 自动取走吗？ | 本地状态 deferred，tracker frontier 排除，必须用户明确重开 |
| 新 clone 没有 .scratch 是否表示没有问题？ | tracker：私人状态尚未恢复，不推断清空，不猜最新状态 |
| Stage 10 缺失的 D15/F8 如何处理？ | history 保留缺口和替代证据，不补造原话 |
| 完成文档迁移可以自动提交或推进阶段吗？ | AGENTS：都不可以，按当次授权；技能默认步骤不扩大权限 |

## 局限与交接

这是纯文档/注释引用迁移，**未运行产品 build/test/typecheck/lint 四门**，未重验证历史实验、服务可用性或真实文献数据；没有修复任何旧产品问题或开始下一产品阶段。

私人 tracker 不随公开 Git 备份/克隆，本次未配置私人备份、远端或自动化，后续保全由用户决定。旧公开历史没有重写。验收快照时尚未暂存；后续提交授权仅覆盖公开文档与授权引用改动，不夹带 `.pi/skills/` 或 `.scratch/`。

本次执行票据在私有 `.scratch/memory-migration/issues/01-migrate-memory.md`。当下迁移完成不代表旧产品待办已完成，也不使历史一次性执行权限延续。
