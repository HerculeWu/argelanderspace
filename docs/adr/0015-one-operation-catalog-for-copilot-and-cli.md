---
status: accepted
---

# Copilot 与 CLI 共用一份操作目录，外部 agent 与 Copilot 效果相同

工作台的设计目标是人和 agent 共用一套操作。v0.2.0 之前 Copilot 有约 150 个工具动作，CLI 只有 16 个命令且只有少数写入，外部 agent（如 Claude Code）因而只能读取和准备、写入交回 Copilot（[ADR 0014](0014-project-intake-by-interview.md) 的否决项之一）。现决定：每个**操作**（[CONTEXT](../../CONTEXT.md)「界面与沟通」）只定义一次——名称、参数 schema、是否需要人工确认——Copilot 工具与 CLI 子命令都从它派生、名称一一对应，同一份**操作说明**对两方都成立。外部 agent 的写入与 Copilot 走同一套业务代码，效果和保护相同。

## Considered Options

- **CLI 手写一套命令，用测试对齐 Copilot**：两份定义注定漂移，新功能容易只出现在一边。否决。
- **外部 agent 只读、写入交给 Copilot**（ADR 0014 的现行做法）：违背「一样的效果」。否决。
- **CLI 加文件锁直接写**：与 server 内存状态、WS 通知和确认卡语义脱节。否决。
- **所有 CLI 写入都要求工作台在运行**：不开工作台就什么也写不了。否决，只有需要确认的操作要求它在运行。
- **以 Claude Code 自身的命令权限提示或 `--yes` 代替确认卡**：自动模式下等于没有确认。否决。

## Consequences

- **单写入者**：CLI 写入命令检测到该 dataDir 的工作台正在运行时交给 server 执行，否则在本进程里调同一套 core 服务；不再存在 CLI 与 server 同时写同一对象的情况，I013 的不支持范围随之消失。
- **确认**：在 Copilot 中需要确认卡的操作，经 CLI 时卡片同样出现在运行中的工作台里，CLI 阻塞等待用户决定；工作台未运行时这类命令拒绝执行，并提示先打开工作台。
- **范围**：界面动作（面板、翻页、缩放等）不进目录，只保留「让工作台打开某处」一类导航操作。v0.2.0 覆盖文献主线（Library、阅读与标注、论证图、探索、迁入）；Plan、Writer、Mail、文献仓推后到 v0.3。
- **冻结面不动**：`annot` 仍是真只读；`argument get/put`、`pdf-path` 的输出逐字节不变；新命令只做增量。
- 数据保护与被修订的旧条文见 [contracts](../contracts.md)「操作目录与外部 agent」；文献仓无 CLI 一句在 v0.3 之前照旧。同时局部修订 [ADR 0011](0011-copilot-file-and-command-tools.md)（取消随包 skill 白名单，Copilot 获得只读 ADS 搜索）与 ADR 0014（外部 agent 不再只读）。
- **Agent 插件**随 npm 包发布，只带操作说明、不带 CLI 本体与 MCP，使用本机同版本 CLI；桌面应用用户经设置里的「安装命令行工具」拿到 PATH 上的 CLI。

来源：2026-10-28 Copilot / CLI / Agent 插件设计访谈 Q2、Q5、Q11–Q16，用户采纳推荐答案，Q17 批准本 ADR。2026-10-29 随 release-0.2 票 01–15 实施（机制见 [operation-catalog](../operation-catalog.md)）。
