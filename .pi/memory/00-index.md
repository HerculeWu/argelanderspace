# 项目记忆入口

正式记忆整理于 2026-09-16；产品事实截至 Stage 12 关闭（2026-09-16）。日常新增决定可能在 inbox 中，**本目录不是不可变快照**。

## 当前状态

ArgelanderSpace 是单用户科研工作台，也是用户与 AI agent 协作的 interface，不只是文献工具。Stage 1–14 已关闭；**Stage 14（ADS 文献发现 Discovery）已交付且 smoke 通过**（含摘要 HTML/数学渲染修复）。下一阶段：**Stage 15——添加文献时若有 arXiv 即自动导入 arXiv 正文内容**（用户 2026-09-17 拍板，下个 session 立项，范围届时 grilling）。Stage 4.1 仍推后，问题清单不是默认任务队列。

Writer 已交付 cell 编辑/导出、CodeMirror 与共享编译→IR 预览；Stage 12 落地 Shift+Enter/Render 显式触发渲染（自动保存保留）、bib 转义与 ADS BibTeX 字段富化（cite_key=bibcode 分配规则、一次性存量迁移）、期刊宏注入与导出 zip 附带模板依赖。reader 同 epoch 自动更新已完成（I001 关闭）。Stage 14 新增：文献详情页「探索相关文献」→ ADS similar(18)+useful(6) 临时探索图（真实引用边、菱形 Useful、入库不打断探索）；库图退役旧全局推荐（saved-only + graph.json 版本化自愈）。详情各归其权威文件，不以代码现状废除新决定。

## 启动阅读顺序（不得只读索引）

1. 本文件。
2. [产品与架构](product-and-architecture.md)：当前能力、数据与使用语义。
3. [契约与决策](contracts-and-decisions.md)：用户意图、不可擅改的边界、接口冻结及标注数据保护。
4. [问题清单](known-issues.md)：开放问题、接受边界、推后能力、待确认项。
5. [工程规则](engineering.md)：环境、验收、测试/打包/迁移教训。
6. [历史摘要](history.md)：阶段结果、关键转折、原始证据恢复入口。
7. [Inbox 协议](../inbox/README.md)及 `.pi/inbox/` 全部未归并 session 文件，按事件时间补充最新状态；不因体量大而跳读。

同事项同范围内，有权的新决策覆盖旧决策；事实按证据和环境更新，不能机械按新旧排序。规则权威位置是 inbox 协议，本页仅作导航。

## 按任务补读

| 工作面 | 先读专题 |
|---|---|
| LaTeX 编译、插桩、宏展开、编号、引用、作者、图转换 | [tex-pipeline](../memory-reference/tex-pipeline.md) |
| 标注 target/canonical text、指纹投影、reader 共同 epoch/草稿/资产、REST/CLI、删除并发 | [annotations](../memory-reference/annotations.md) |
| 计划页面交互、plans 存储、未来 agent 计划接口 | [plans](../memory-reference/plans.md) |
| Writer 稿件/模板/导出、成熟编辑器、共享 IR 与陈旧保护 | [writer](../memory-reference/writer.md) |
| 本轮 inbox 归并的去向、替代链、原文提交和验收证据 | [本轮审计](../memory-reference/2026-09-16-inbox-merge-audit.md) |
| 2026-09-13 初次记忆重构的历史恢复与保真证据 | [初次审计](../memory-reference/2026-09-13-memory-restructure-audit.md) |

专题是现行细节，不是重读旧 roadmap 的入口。关键硬约束在必读文件中有摘要。已关闭方案/逐轮审查的完整原文留 Git，恢复方法见 history。

## 维护分工

- 正式记忆：每条现行知识只设一个权威位置，其余链接；保留关键理由，不复制开发过程。
- Inbox：日常默认唯一写入处，拍板/验证/问题/阻塞及时记，结束收尾。未归并决定仍有效。
- 专题与阶段方案：按需读；获授权才修改；阶段方案须标草案/已批准/执行中/已关闭，草案无决策效力。
- 专门整理：只有明确授权才归并；原文入 Git 后才能裁剪删除；无 commit/push 隐含授权。
- 软提醒：8 个 session 文件或 40,000 UTF-8 字节，及阶段交界。达到阈值只提醒，不自动整理，不跳读。
- 所有记忆相关文件限 `.pi/`；不得另建 `docs/` 记忆副本。业务说明与用户 smoke 手册仍是原有项目文档，不属于新增记忆目录。

正式必读参考预算 35–50 KB，保真优先，不是硬配额。新事实无需为了“自足”重复全套架构；引用权威条目即可。
