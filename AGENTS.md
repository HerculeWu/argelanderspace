# AGENTS.md

## 语言与项目

默认用中文交流。**ArgelanderSpace** 是单用户科研工作台，也是用户与 AI agent 协作的 interface；webui 是可独立操作的应用，不只是文献工具或 agent 看板。

领域语言见 [CONTEXT.md](CONTEXT.md)，产品与结构见 [architecture](docs/architecture.md)，阶段结果和原文恢复见 [history](docs/history.md)。已关闭阶段不是默认待办，下一阶段由用户决定。

## 工作前读取

1. 开发、设计或修改前完整读取 [CONTEXT.md](CONTEXT.md) 与 [硬契约](docs/contracts.md)。不得用 ADR 摘要替代完整数据保护规则。
2. 实施、调试、验收时读取 [工程指南](docs/engineering.md)。
3. 按 [domain 文档入口](docs/agents/domain.md) 读取涉及的 ADR 和专题；做某张票据时读取完整票据、相关规格、评论和阻塞项。

不再全量读取旧 memory/inbox 或全部历史。必读文件丢失时先报告并恢复，不推断约束消失；涉及本地 tracker 而 `.scratch/` 不在时，按 tracker 规则请求恢复，不当作没有待办。

## Agent skills

### Issue tracker

使用**本地 Markdown**：`.scratch/<feature>/spec.md` 和 `issues/<NN>-<slug>.md`，不使用 GitHub Issues。规则见 [issue-tracker](docs/agents/issue-tracker.md)。

### Triage labels

采用 Matt 默认五态＋本仓库 `deferred` 扩展，均为本地字段，不创建远端标签。`deferred` 不进入可执行队列，只能由用户明确重开；完整语义见 [triage-labels](docs/agents/triage-labels.md)。

### Domain docs

Single-context：根目录 `CONTEXT.md`＋`docs/adr/`。词汇、ADR、技术文档的职责和按任务读取规则见 [domain](docs/agents/domain.md)。

## 知识维护、隐私与授权

- 当前获授权任务内，确认的术语、重要决定、工程事实及时更新各自权威位置；只读/方案讨论任务未获写入授权时不写。没有长期变化不强制建记录。
- CONTEXT 只写领域词汇；ADR 只记重要真实取舍；技术机制进专题；规格草案、执行进度、未决问题和讨论进相应本地票据，不再建立中央 session inbox。
- 同事项同范围内，有权的新决策按发生时间覆盖旧决策。建议、假设、较新的代码不是自动覆盖；局部修订写清旧定位、新结论、范围与原因。事实按证据/环境更新，来源不明先询问，不能扩大权限或取消数据保护。
- 每项现行知识只有一个完整权威位置，其他地方用链接。保留理由、否决项、来源与重新讨论条件；旧决定迁成 ADR 不伪造新的批准日期。
- 可公开的 glossary、ADR、架构、契约、工程指南进入仓库；本机私有记录、任务与讨论放被忽略的 `.scratch/`，不得 force-add 或复制进公开 issue/文档绕过隐私选择。任何文档或票据都不记录 token、密码或完整敏感日志。
- `.scratch/` 不加密，也不随公开 Git 备份/克隆。私人备份另由用户决定，不擅自建远端、hook 或后台任务。
- 大规模重组、删除与范围变化需明确授权。裁剪旧原文前核验可定位持久 Git 记录；私有票据不能为满足保全而加入公开 Git，须经用户确认私有保全后才清理。摘要不是原文备份。迁移不自动清除既有 Git 历史。
- 文档维护、阶段关闭或技能流程均不自动授权用户数据迁移、commit/push。历史阶段执行授权不继承；`/implement` 等技能中的提交步骤仍受当次授权约束。

## 工程入口与硬约束

pnpm workspace：contracts / core / infra / server / cli / web / app（发布包 `argelanderspace`）。本机 Node v24+，使用 **`corepack pnpm`**，裸 pnpm 不在 PATH。

前端设计或实现先读 [Web design](packages/web/DESIGN.md)：从 `packages/web/src/ui/` 公共入口复用，沿现有 i18n/theme/density，并用真实浏览器检查布局与交互。

常规代码验收四门：

```bash
corepack pnpm -r build
corepack pnpm -r test
corepack pnpm -r typecheck
corepack pnpm lint
```

无 per-package lint。纯文档与注释引用迁移做保真、链接和改动范围检查，不默认运行产品四门。

- 摄入依赖 TeX Live（latexmk/pdflatex/xelatex/bibtex/biber）；图转换可选 pdftocairo＋ghostscript。旧 pandoc/mupdf/dvisvgm 路线已退役。
- 普通 golden 可按获批行为变更更新；**agent 既有输出冻结、annot 自诞生冻结**独立成立，不因退出重构期而解除。
- 标注是 per-doc 用户数据：三态指纹规则与异常分支不得合并简写，系统错误不能当 mismatch；归档仅由 server annotations 访问路径负责；CLI annot 真只读；DELETE 全局物理删除；跨进程同 Doc 并发写不支持。修改前必须读 [完整契约](docs/contracts.md)。
- 文献问答走 CLI/skills，不以内部 JSON/源码替代文献接口；开发任务可以读源码，结构、调用与影响导航优先 CodeGraph。
