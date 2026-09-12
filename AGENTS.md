# AGENTS.md

## 强制：session 启动协议

**每个新 session 开始时，必须先完整阅读 `.kimi-code/memory/` 目录下的所有文件，再开始任何工作。** 该目录是本项目的长期记忆：里面记录了已完成的验证结论、技术决策和踩过的坑，避免重复劳动和结论漂移。

- 读完后再响应用户的请求，把 memory 中的结论当作既定事实（除非用户明确要求重新验证）。
- 工作中产生了有长期价值的结论（可行性验证、架构决策、环境坑、上游 API 变动等）时，在 `.kimi-code/memory/` 下新增一个 `YYYY-MM-DD-<主题>.md` 记录，保持自包含、可独立阅读。

## 项目速览

ArgelanderSpace（原 bibgraph）：单用户**科研工作台**（不只是文献工具）——承担用户与 AI agent 协作的 interface；已落地核心 = arXiv LaTeX 摄入 → 项目级文献库/引文图谱 → React 阅读器（含 per-doc 文档标注层）→ agent 协作（CLI + pi skills）。产品形态/架构/使用语义详见 `.kimi-code/memory/2026-09-01-product-and-architecture.md`；对外介绍见 `README.md`。

**工程**：pnpm workspace（`packages/`：contracts / core / infra / server / cli / web / app 发布单包）。验收门：`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`（无 per-package lint script；本机裸 `pnpm` 不在 PATH，必须走 corepack）。**重构期已于 2026-09-01 宣告结束**：bug-for-bug 兼容与 golden 逐字段 diff 基线退役，golden 夹具转为普通回归测试（行为变更由 TS 管线自洽重冻 + 人工抽查）。

**历程**（详见 `.kimi-code/memory/2026-09-01-development-log.md`）：Stage 1 TS 重构（2026-08-27）→ Stage 2 agent 接入（2026-08-27）→ Stage 3 存储统一 `./literatures` + 渲染 IR 三端共用 + webui 补齐（2026-09-01）→ Stage 3.1 摄入收窄 LaTeX + zip 上传 + 公式/表格修复（2026-09-02）→ Stage 4 计划页面（2026-09-02 关闭）→ Stage 5 LaTeX 解析线路重构（IR 化）（2026-09-09 关闭）→ Stage 6 阅读器四项修复（2026-09-09 关闭）→ Stage 7 known-issues 清账（2026-09-10 关闭）→ Stage 8 文档标注（2026-09-12 关闭）。

**下一步**：**由用户拍板**。候选：known-issues 各节遗留（5 篇 src-only 缺 arXiv 类文件、脚注 DROP、tikz、作者块残留边界、Stage 8 节存照 8 项，见 `2026-09-01-known-issues.md`）、Stage 4.1（agent 操作计划页面：CLI/skills 读写 `status/plans.json`）**推后**（数据层已预留：稳定 id/pretty JSON/watcher/plan.changed/CRUD 纯函数）、标注层未来方向（migration skill / 编辑工作流 / 协作扩展，见 `2026-09-10-stage8-roadmap.md` 产品定位节）。Stage 8 已关闭（per-doc 标注层：文本/结构/文档三级 target + canonical 指纹失效归档 + 阅读器 CRUD + CSS Custom Highlight 重叠渲染 + CLI `annot` 只读 + 文档删除端点；agent 既有输出零改动、`annot` 自诞生冻结；定稿/里程碑/审查存照见 `2026-09-10-stage8-roadmap.md`）。**webui 独立应用原则**与其余推后事项见 `2026-09-01-stage3x-roadmap.md` 推后事项节 + `2026-09-01-known-issues.md`。

## 环境

- Node v24+ / npm 11+；pnpm 经 `corepack pnpm` 调用（pnpm 11.24.0，见根 package.json `packageManager`）
- **TeX Live 全家在 `/usr/bin`**（latexmk/pdflatex/xelatex/bibtex/biber，摄入与真编译测试的硬前提；真编译用例走 `HAVE_LATEXMK` 风格探测 gating，缺工具自动 skip）。图转换 = **poppler-utils（pdftocairo）+ ghostscript（gs，EPS 用）**（可选，缺失降级为无图；dvisvgm 已于 smoke R1 弃用——真图丢全部文字与内嵌位图）。**pandoc 已于 Stage 5 MS3b 随旧管线删除**——旧 shim 说明（astro env `/tmp/ms1-bin`）只具历史意义（其提示仍适用：不要把整个 astro bin 前置 PATH，其 node v20 会抢先系统 node）
- keys：`MINERU_API_KEY`（~/.zshrc；**2026-09-01 实测返回 401 鉴权失败**，OCR 已降级为"开发中"，启用前自查）、ADS token（`~/.ads/dev_key`）、`OPENALEX_API_KEY`（~/.zshrc）；也可写进 `~/.config/argelanderspace/config.toml`（env 优先）
