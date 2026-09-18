# AGENTS.md

## 语言与项目

用户母语为中文，默认用中文交流。

**ArgelanderSpace** 是单用户科研工作台，也是用户与 AI agent 协作的 interface，不只是文献工具；webui 目标是可独立操作的应用。Stage 14 已于 2026-09-17 关闭（ADS 文献发现：文献详情「探索相关文献」→ ADS similar+useful 临时探索图，库图退役旧全局推荐转 saved-only + graph.json 版本化自愈，smoke 通过），**Stage 15 已于 2026-09-18 关闭**（添加文献时若有 arXiv 即自动下载最新源-编译-挂载到条目，含原位刷新、附件 tab 可点击行与进度/重试、获取类广告标签清理、`logs/arxiv-fetch.jsonl` 报错日志、隐藏开关 `auto_ingest_arxiv`，smoke 通过）。**下一阶段未指定**（等用户拍板），Stage 4.1 仍推后。当前能力与架构见正式记忆，对外说明见 `README.md`。

## 强制：session 启动协议

开始工作、回应任务之前：

1. 完整阅读 `.pi/memory/` 的全部文件，先 [00-index.md](.pi/memory/00-index.md)，再按其中顺序读取；不能只读索引。
2. 阅读 [.pi/inbox/README.md](.pi/inbox/README.md) 及全部未归并 session 文件，按事件时间补充最新状态；即使超过体量提醒阈值也不得跳读。
3. 按任务读取 `.pi/memory-reference/` 对应专题。硬约束以正式记忆及有效的新决策为准，专题不能藏匿必读安全规则。

**同事项、同范围内，有权的新决策覆盖旧决策**，包括尚未归并的 inbox 和用户本次明确决定；按决策发生时间，不按文件 mtime。事实按证据与环境更新，不机械按新旧排序。建议不等于决定，代码偏差不自动覆盖用户约束；有歧义时标记并询问，不能扩大授权或解除数据保护。详细规则以 inbox 协议为权威。

## 记忆写入与整理

- 所有记忆相关文件只放 `.pi/`；正式记忆 `memory/`、专题/获授权方案 `memory-reference/`、日常增量 `inbox/`。
- 日常默认只写自己的 `YYYY-MM-DD-<session短标识>-<主题>.md`，关键节点及时更新，结束收尾；区分决策、事实、问题、待确认与交接状态。无值得交接内容不强制建文件。
- 正式记忆/专题的更新、归并需要明确授权；新规则即使只在 inbox 仍有效。删除或裁剪原文前须确认已入可定位的 Git 历史；未提交原文不得因已写摘要而删除。
- 启动/收尾发现 inbox 达8份或正文40 KB，及阶段交界时提醒整理；不自动归并、不自动截断。不引入后台任务/hook。
- 保留结论、关键理由、范围与重新讨论条件；单一权威位置，其他引用。不得将 token/密码/完整敏感日志写入任何记忆文件。
- **整理授权不等于 commit/push 授权；旧阶段的自动提交等执行授权不永久继承。**

## 工程入口与约束

pnpm workspace：contracts / core / infra / server / cli / web / app（发布单包 `argelanderspace`）。Node v24+；本机必须使用 `corepack pnpm`，裸 pnpm 不在 PATH。

常规代码验收四门：

```bash
corepack pnpm -r build
corepack pnpm -r test
corepack pnpm -r typecheck
corepack pnpm lint
```

无 per-package lint。纯记忆整理做文档与保真检查，不默认运行全构建测试。

- 摄入硬前提：TeX Live（latexmk/pdflatex/xelatex/bibtex/biber）；图转换可选 poppler-utils（pdftocairo）+ ghostscript（EPS）。pandoc/mupdf/dvisvgm 旧路线已退役。
- 普通 golden 可按获批行为变更更新；**agent 既有输出冻结、annot 自诞生冻结**是独立契约，不因退出重构期自动解除。
- 标注是 per-doc 用户数据：三态指纹规则不得合并简写或将系统错误当 mismatch；归档权威仅 server 访问路径，CLI annot 真只读；DELETE 全局物理删除；跨进程同 doc 并发写不支持。
- 文献问答走 CLI/skills，不用内部 JSON/源码替代文献接口；开发任务可读代码，结构导航优先 CodeGraph。

开始相关修改前读 [契约与决策](.pi/memory/contracts-and-decisions.md)、[工程教训](.pi/memory/engineering.md)及索引中的专题。当前问题、环境和历史只在其权威记忆文件维护，不在本文件重复堆积。
