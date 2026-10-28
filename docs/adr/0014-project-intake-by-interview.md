---
status: accepted
---

# 项目迁入：agent 访谈加迁入清单，而非导入器

用户要带进工作台的往往是做到一半的研究项目：材料散在几个文件夹和服务器上，文献在 ADS libraries、Zotero 或 Downloads 里的散 PDF，稿件常在 Overleaf。来源的组合因人而异，没有一个导入器能覆盖。因此**项目迁入**（[CONTEXT](../../CONTEXT.md)「数据范围」）由一份随包 skill 驱动：agent 像访谈一样逐步询问用户要提供什么，用业务工具把文献、计划写进 Project，并把经过记在 Project 根的**迁入清单**里，换会话、换 agent 都能接着做。工作台只补访谈所缺的几个原子能力（本地 PDF 挂载、读 ADS libraries、批量 bibcode 导入），不做一键导入。

## Considered Options

- **一键导入器 / 导入向导**（按 Zotero、ADS、文件夹各写一个导入）：来源组合无穷，失败时用户只看到半套结果，也没有人去问"这两个 PDF 是不是同一篇"。否决。
- **只靠 Copilot 会话记进度，不要清单**：换 agent（Copilot ↔ 外部 agent）或会话丢失就断了；留在原处的材料位置也无处可查。否决。
- **把已有 LaTeX 稿件转换成 Manuscript**：Writer 只有 cell 模型与有限模板，不兼容任意宏，转换结果有损且看起来像成功。否决：稿件留在原处（含 Overleaf，只登记链接或读下载的 zip），只把它的 .bib 导入 Library。
- **外部 agent 经 CLI 直接写入**：要新增 CLI 写命令（一发布即进冻结面），且与运行中的 server 并发写不受支持（I013）。否决：外部 agent 只做读取与准备（在本机和服务器上翻找、整理清单与 .bib），写入交给工作台内的 Copilot。（2026-10-28 局部修订：该否决的两条理由由 [ADR 0015](0015-one-operation-catalog-for-copilot-and-cli.md) 解决——迁入所用的操作有 CLI 入口，写入经单写入者路由并沿用确认卡，外部 agent 可以完成整个迁入。范围：只改外部 agent 的角色，本 ADR 其余取舍不变。批准：用户 2026-10-28 设计访谈 Q5、Q12–Q15。尚未实施。）
- **把用户文件整理或移进 Project**：迁入只读取或复制，从不移动、改写或删除用户原文件；代码、数据、服务器结果只在清单里登记位置。

## Consequences

- 迁入质量取决于 skill 与模型，而不是一段可穷尽测试的导入代码；验收用合成的"乱项目"夹具与脚本化模型，再由用户用自己的真实项目终验。
- 迁入 skill 加入 Copilot 加载的随包 skill 白名单（局部修订 [ADR 0011](0011-copilot-file-and-command-tools.md) 的白名单）。
- 只有 DOI / arXiv 精确命中时 agent 自行认定同一篇，其余列候选由用户确认，与「挂载不靠标题相似猜测」一致；批量导入会合并 Work 的条目逐条拒绝而非整批失败。
- 业务工具的数据保护见 [contracts](../contracts.md)「项目迁入」；经 bash / edit 的操作（scp、解压、写清单）照 ADR 0011 不受契约保护。
- Zotero 笔记、PDF 内嵌批注不转成工作台标注；要做需另行设计显式迁移，标注契约不因迁入放宽。
- 教程层仍不进入用户自己的 Project（[ADR 0012](0012-in-app-tutorial-in-its-own-project.md)）：教程第 9 章只介绍迁入并导航出去，迁入的引导由新 Project 里的 Copilot 接过。

来源：2026-10-26 项目迁入设计访谈 Q1–Q21（用户采纳推荐答案，Q9 补充 Overleaf），用户 2026-10-26 批准本 ADR；规格见本地 `.scratch/project-intake/spec.md`。尚未实施。
