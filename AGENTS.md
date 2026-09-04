# AGENTS.md

## 强制：session 启动协议

**每个新 session 开始时，必须先完整阅读 `.kimi-code/memory/` 目录下的所有文件，再开始任何工作。** 该目录是本项目的长期记忆：里面记录了已完成的验证结论、技术决策和踩过的坑，避免重复劳动和结论漂移。

- 读完后再响应用户的请求，把 memory 中的结论当作既定事实（除非用户明确要求重新验证）。
- 工作中产生了有长期价值的结论（可行性验证、架构决策、环境坑、上游 API 变动等）时，在 `.kimi-code/memory/` 下新增一个 `YYYY-MM-DD-<主题>.md` 记录，保持自包含、可独立阅读。

## 项目速览

ArgelanderSpace（原 bibgraph）：单用户**科研工作台**（不只是文献工具）——承担用户与 AI agent 协作的 interface；已落地核心 = arXiv LaTeX 摄入 → 项目级文献库/引文图谱 → React 阅读器 → agent 协作（CLI + pi skills）。产品形态/架构/使用语义详见 `.kimi-code/memory/2026-09-01-product-and-architecture.md`；对外介绍见 `README.md`。

**工程**：pnpm workspace（`packages/`：contracts / core / infra / server / cli / web / app 发布单包）。验收门：`corepack pnpm -r build|test|typecheck` + 根 `corepack pnpm lint`（无 per-package lint script；本机裸 `pnpm` 不在 PATH，必须走 corepack）。**重构期已于 2026-09-01 宣告结束**：bug-for-bug 兼容与 golden 逐字段 diff 基线退役，golden 夹具转为普通回归测试（行为变更由 TS 管线自洽重冻 + 人工抽查）。

**历程**（详见 `.kimi-code/memory/2026-09-01-development-log.md`）：Stage 1 TS 重构（2026-08-27）→ Stage 2 agent 接入（2026-08-27）→ Stage 3 存储统一 `./literatures` + 渲染 IR 三端共用 + webui 补齐（2026-09-01）→ Stage 3.1 摄入收窄 LaTeX + zip 上传 + 公式/表格修复（2026-09-02）→ Stage 4 计划页面（2026-09-02 关闭）。

**下一步**：**Stage 5 = LaTeX 解析线路重构（IR 化）**——废弃 pandoc/mupdf，latexmk 编译产物 + unified-latex 源码树双通道融合出新 IR，**IR 即存储**，streamView/agent 内容均从 IR 渲染；UX 不增不减；编号改印刷忠实。2026-09-04 grilling 定稿（三轮 Q1–Q13，用户确认），详见 `.kimi-code/memory/2026-09-04-stage5-roadmap.md`。**原论文写作 stage 已删除（不顺延）**。Stage 4 已关闭（MS1–MS4 + smoke 三轮修复全过、已 push；定稿/里程碑/审查记录见 `.kimi-code/memory/2026-09-02-stage4-roadmap.md`）。Stage 4.1（agent 操作计划页面：CLI/skills 读写 `status/plans.json`）**推后**（数据层已预留：稳定 id/pretty JSON/watcher/plan.changed/CRUD 纯函数）。开放问题/推后事项（**全条目 re-upload**、**webui 独立应用原则**、README pandoc 版本说明 + 检验脚本、CLI 未识别源建条目、**task.due 可晚于 plan.due**、**tikz/pgfplots 不渲染**）见 `2026-09-01-stage3x-roadmap.md` 推后事项节 + `2026-09-01-known-issues.md`。

## 环境

- Node v24+ / npm 11+；pnpm 经 `corepack pnpm` 调用（pnpm 11.24.0，见根 package.json `packageManager`）
- pandoc 在 `/home/wwu/miniforge3/envs/astro/bin/`，跑 LaTeX/HTML 管线（含相关测试）前需加入 PATH。**坑**：不要把整个 astro bin 前置 PATH——astro 自带的 node v20 会抢先系统 node（pnpm 11 需 node ≥22.13，会起不来）；用只含 pandoc 的 shim 目录前置（如 `/tmp/ms1-bin/pandoc` → astro pandoc 的单独 symlink）
- keys：`MINERU_API_KEY`（~/.zshrc；**2026-09-01 实测返回 401 鉴权失败**，OCR 已降级为"开发中"，启用前自查）、ADS token（`~/.ads/dev_key`）、`OPENALEX_API_KEY`（~/.zshrc）；也可写进 `~/.config/argelanderspace/config.toml`（env 优先）
