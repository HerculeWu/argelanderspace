# Domain docs

本仓库采用 **single-context**：根目录 [CONTEXT.md](../../CONTEXT.md) 和 [docs/adr/](../adr/)。workspace 包是技术分层，不按包拆领域词汇。

## 阅读与使用

- 开发、设计或修改前先读 `CONTEXT.md` 和 [硬契约](../contracts.md)；实施、调试、验收另读 [工程指南](../engineering.md)。
- 阅读本任务涉及的 ADR。当前入口：[Work 与 Doc 分离](../adr/0001-work-doc-identity.md)、[编译事实与共享 IR](../adr/0002-compiled-ir.md)、[标注内容绑定与整批归档](../adr/0003-annotation-epochs.md)、[临时探索与持久文库](../adr/0004-discovery-library-separation.md)。新 ADR 创建后同步此入口。
- 输出、票据、测试命名使用 glossary 中的规范术语；定义冲突立即指出，不漂移到被排除的同义词。
- `CONTEXT.md` 只写领域定义，不收实现细节、规格、工作进度或工程笔记；成熟的领域词条一经确认就在获授权任务内更新。
- ADR 只记录同时满足“难以逆转、没有背景会令人困惑、确有取舍”的决定。保留原决策日期、来源、理由；迁移日期不是重新批准日期。重大修订通过明确的替代关系记录。
- 通用 Matt 行为允许 glossary/ADR 尚不存在时继续探索；本仓库已建立这些入口。已声明的硬契约或必读专题丢失时，先报告并恢复，不当作不存在的约束。
- 文档与实现不符时，区分实现偏差、过时事实和有权的新决策。不能用较新的代码自动推翻用户决定；有歧义时保留约束并询问。

## 按工作面补读

| 工作面 | 权威入口 |
|---|---|
| 产品能力、包职责、存储与同步概览 | [architecture](../architecture.md) |
| 文库身份、cite key、手动创建、上传、arXiv 获取 | [library](../library.md) |
| LaTeX 编译、插桩、宏、编号、引用、作者、图转换 | [tex-pipeline](../tex-pipeline.md) |
| Reader、标注 target/canonical text、共同 epoch、资产与草稿 | [annotations](../annotations.md)；数据保护和冻结 CLI 全文在 [contracts](../contracts.md) |
| 科研计划页面、plans 存储、未来 agent 计划接口 | [plans](../plans.md) |
| ADS 探索、saved-only 库图与缓存自愈 | [discovery](../discovery.md) |
| Writer 工作流、共享预览、陈旧保护与兼容性 | [writer](../writer.md)；文件协议用既有 [writer-data-model](../writer-data-model.md)；共享管线另读 tex-pipeline |
| 构建、测试、打包、依赖与迁移教训 | [engineering](../engineering.md) |
| 当前任务、推后或未验证问题 | [本地 tracker 规则](issue-tracker.md)，按任务读取 `.scratch/`；不把旧阶段视为待执行票据 |
| 历史决定、阶段结果、原文恢复 | [history](../history.md) |
| 本次旧记忆去向与保真证据 | [迁移审计](../migrations/memory-to-domain-modeling.md) |

## 权威与维护

每项现行知识只有一个完整权威位置，概览与安全提示可短述并指向原文。字段/schema 查询可回到源码；源码证明当前实现，不自动改变产品契约。技术细节进专题，任务过程进本地票据，历史证据进 Git，不再建立中央会话 inbox。

在当前设计/实施任务授权内及时更新相关已确认知识；纯只读任务不写。未确认想法保留在相应本地规格/票据中并标明待确认，不升级成 glossary、accepted ADR 或现行契约。无长期变化的 session 不强制创建记录。

工程文档可进入公开仓库；规格草案、票据、讨论、原始诊断材料和本机私有信息放被忽略的 `.scratch/`。公开材料仅保留可公开结论与必要来源，不含凭据或完整敏感日志。提交/推送及删除历史仍须相应授权。
