# Issue tracker: Local Markdown

**本仓库不使用 GitHub Issues 承接规格、任务或讨论。** 使用 Matt 原生 Local Markdown 布局，`.scratch/` 被仓库 `.gitignore` 排除；不能因仓库有 GitHub remote 就切换到公开 tracker。

## 布局与操作

- 一个 feature 一目录：`.scratch/<feature-slug>/`。
- 规格：`.scratch/<feature-slug>/spec.md`；只有确有规格内容才创建。
- 一票据一文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号。禁止将全部实施票据拼成一个文件。
- 票据头部写 `Status:`，使用 [状态词汇](triage-labels.md)；普通票据另写 `Progress:`。
- `Blocked by:` 写实际票据编号/路径；同目录可只写编号，跨 feature 用相对 `.scratch/` 的路径，不能假定两个 feature 的 `01` 是同一票据。
- 评论与过程追加在各文件 `## Comments` 中，记录事件时间、决定/事实/待确认及证据。不是每次工具调用都记日志。
- “publish to the issue tracker”在本仓库指写上述本地文件，不是联网发布。
- “fetch relevant ticket”指读取完整文件及 Comments，必要时读其规格和阻塞票据。
- 规格和经 `to-tickets` 批准的自包含票据不再重复 triage。未经批准的草案不能因为文件存在就标 ready。

## 读取与执行门

普通实施 frontier 必须同时满足：`Status: ready-for-agent`、`Progress: not-started`、所有 blocker 已完成验收、以及当前任务已有执行授权。暂停工作只能按当前授权继续，不能把全库的 ready 票据视为常驻后台任务。

`deferred`、`needs-triage`、`needs-info`、`ready-for-human`、`wontfix` 不进入 agent 自动取票队列。启动和关闭阶段不自动选择下一阶段。选择/读取票据不等于允许用户数据迁移、commit 或 push。

## 旧问题导入

首次迁入位于 `.scratch/legacy-backlog/issues/`；这是历史问题整理桶，不是一项整体批准的实施 feature。每份保留 `Legacy ID: Ixxx`、原分类、原证据时点与来源。开放问题/待确认事项先为 needs-triage，推后事项为 deferred；本次不重跑历史实验、不宣称当前仍可复现。

I001–I035 的公开去向索引见 [迁移审计](../migrations/memory-to-domain-modeling.md)。接受的边界留契约/专题，已关闭事项留历史，不伪造待办或否决。进入实际实施时另形成自包含规格/票据，建立与 Legacy ID 的链接，不失去原问题身份。

新 clone 通常没有 `.scratch/`：这表示本地 tracker 未恢复，不表示没有问题或未来工作。涉及这些事项时请求用户恢复私人副本，或按历史 Git 来源恢复经授权的旧记录，不能猜测最新状态。

## Wayfinding

- map：`.scratch/<effort>/map.md`，保存 Notes / Decisions-so-far / Fog。
- child：`issues/NN-<slug>.md`，声明 `Type: research | prototype | grilling | task`；按原技能用 `Status: claimed | resolved` 标记生命周期。
- `Blocked by:` 列 child 标号；所有 blocker resolved 且未 claimed 的票据才可进入 frontier，按 map 顺序选择。任何 deferred 项仍排除。
- claim 是开始工作前的第一次写入；resolve 时补 `## Answer`，标 resolved，再在 map 中链接结论。map 是决策地图，不是自动执行授权。

## 隐私、保全与权限

`.scratch/` 是本地文件，并非加密存储；隐藏目录名本身不保证隐私。不得 `git add -f`、强制修改忽略规则或通过 issue/日志/公开文档绕过用户的非公开选择。

它**不会随公开 Git 备份或克隆**。本次不配置私有远端、自动备份、hook 或后台任务；长期保全由用户另行选择私人备份/私有 Git。清理任何尚未另行保全的票据前必须请求授权。

公开的 glossary、ADR、工程文档与本地任务记录分开维护；不把私有讨论全文复制进公开 ADR。旧记忆已经进入的 Git 历史不会因忽略或删除活动文件变成私有，本次不重写历史。

操作范围遵守当次授权。文档迁移不自动提交，不创建 GitHub issue/标签，不触碰文献库、计划、稿件或标注数据。技能默认的提交/远端操作步骤不能扩大此权限。
