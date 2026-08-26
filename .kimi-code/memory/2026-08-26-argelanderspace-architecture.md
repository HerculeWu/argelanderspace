# ArgelanderSpace 路线图与架构决策

- **日期**：2026-08-26（用户拍板）
- **背景**：bibgraph 重构改名 **ArgelanderSpace**。定位不止文献阅读/管理，未来加项目管理等域；但先把文献管理做好。
- **终极目标场景**：用户在 terminal 里跑 pi-agent 基底的科研助手、与 AI 协作写作；ArgelanderSpace 的 webui 承担**图形化看板 + 阅读原文载体**的角色（"不能剥夺用户看论文的权利"）。

## 路线图（顺序已定）

- **Stage 1**：TS 重构现有 app + 改名 + 测试达标。**不做 agent 功能。**
- **Stage 2**：pi agent extension（MCP server + skills 重写）。设计要点：MCP 工具响应**必须带深链接**（`http://localhost:8000/doc/<id>#fig-3`），agent 在 terminal 引证，用户点链接在 webui 打开到对应位置——需要 DocPane 支持 URL 驱动定位。

## 架构决策：A 为主干 + 借 B/C 部件（用户已选）

分层模块化单体（Hexagonal / Ports & Adapters），外加两个借来的部件：

1. **骨架：分层模块化单体**。每业务域一个模块，纯领域逻辑 → 端口 → 适配器。所有外部依赖（mupdf、pandoc、MinerU、ADS/Crossref/OpenAlex、文件存储）都在端口后；REST/MCP/CLI 只是薄适配器。
2. **从插件架构借「模块注册表」**（不做真插件系统）：composition root 处每个域模块声明式注册 `routes / panes / mcpTools / cliCommands`，作为将来演化的接缝。
3. **从事件架构借「内嵌任务运行器 + SSE」**：轻量 job runner（内存队列 + 落盘状态，无外部依赖），摄入类长任务全走它，UI/agent 订阅进度。顺带解决现有 `/api/library/upload` 同步硬等 OCR 的问题。

明确否决：完整插件化工作台（B，Stage 1 成本过高、收益 Stage 2 前用不到）、完整事件溯源/CQRS（C，单用户文件存储过度工程）。

## 目标包结构（pnpm monorepo）

```
packages/
├── contracts/   # zod schema：Document JSON、library payload、API DTO（server/web 共用）
├── core/
│   ├── documents/  # 摄入管线（端口：PdfToolkit→mupdf、LatexToolchain→pandoc、OcrEngine→MinerU）
│   ├── library/    # Work/引文图谱/存储（端口：MetadataSource→ADS/Crossref/OpenAlex）
│   └── projects/   # 未来域，同构插入
├── infra/       # 适配器实现：fs 仓库、mupdf、pandoc、HTTP 源、MinerU 客户端
├── server/      # Hono REST + 静态托管 + SSE
├── cli/         # commander
└── mcp/         # Stage 2 才建
web/             # 现有 React（改名 ArgelanderSpace，HubbleSpace 壳保留）
```

## 测试体系（Stage 1 的"测试达标"标准）

- 域核心纯函数单测
- **golden-file 契约测试**：Python 版管线输出冻结为基准，TS 输出逐字段 diff（论文集覆盖 PDF / arXiv-LaTeX / HTML 三源各 2–3 篇，复用 `data/output` 已有文档）
- contracts 包 zod schema 同时喂 server 和 web，消除前后端字段漂移

## 开工决策（2026-08-26 全部拍板）

- 运行时：**Node + npx**（Bun 单二进制以后需要再加）
- npm 包名：**`argelanderspace`**（已查可用；`argelander` 被占）
- golden-file 论文集：已冻结到 `tests/golden/`（6 篇 + `manifest.json`）——
  LaTeX: `arxiv-2501.17225`、`arxiv-2012.05220`；
  PDF: `2603.03522`（born-digital）、`ads-1983ApJ...270..365M`（扫描/OCR）；
  HTML: `aa39341-20`（aanda）、`962260`（oup）。
  这些是 Python 版输出基准，TS 移植逐字段 diff 验收。
