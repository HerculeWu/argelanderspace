# AGENTS.md

## 强制：session 启动协议

**每个新 session 开始时，必须先完整阅读 `.kimi-code/memory/` 目录下的所有文件，再开始任何工作。** 该目录是本项目的长期记忆：里面记录了已完成的验证结论、技术决策和踩过的坑，避免重复劳动和结论漂移。

- 读完后再响应用户的请求，把 memory 中的结论当作既定事实（除非用户明确要求重新验证）。
- 工作中产生了有长期价值的结论（可行性验证、架构决策、环境坑、上游 API 变动等）时，在 `.kimi-code/memory/` 下新增一个 `YYYY-MM-DD-<主题>.md` 记录，保持自包含、可独立阅读。

## 项目速览

ArgelanderSpace（原 bibgraph）：论文摄入（PDF / 出版商 HTML / arXiv LaTeX → 统一 Document JSON）+ 引文图谱文献管理 + React 阅读器。细节见 `README.md`。

**主线是 TypeScript（已合并 `main`，M0–M6 完成）**：pnpm workspace 在 `packages/` 下——`contracts`（zod 契约）/ `core`（纯领域）/ `infra`（mupdf、pandoc、MinerU、ADS/Crossref/OpenAlex、config.toml）/ `server`（Hono + job runner + WS）/ `cli`（commander）/ `web`（React 阅读器）/ `app`（发布用的单包 bundle，`argelanderspace` on npm）。构建/测试/检查一律 `corepack pnpm -r build|test|typecheck|lint`（本机裸 `pnpm` 不在 PATH，必须走 corepack）。

**Python 旧树已于 2026-08-27 删除**（人工冒烟验收通过后；git history 可查）。当前主线的背景与计划见 memory 目录。

## 环境

- Node v24+ / npm 11+；pnpm 经 `corepack pnpm` 调用（pnpm 11.24.0，见根 package.json `packageManager`）
- pandoc 在 `/home/wwu/miniforge3/envs/astro/bin/`，跑 LaTeX/HTML 管线（含相关测试）前需加入 PATH
- keys：`MINERU_API_KEY`（~/.zshrc）、ADS token（`~/.ads/dev_key`）、`OPENALEX_API_KEY`（~/.zshrc）；也可写进 `~/.config/argelanderspace/config.toml`（env 优先）
