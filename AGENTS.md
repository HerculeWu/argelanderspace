# AGENTS.md

## 强制：session 启动协议

**每个新 session 开始时，必须先完整阅读 `.kimi-code/memory/` 目录下的所有文件，再开始任何工作。** 该目录是本项目的长期记忆：里面记录了已完成的验证结论、技术决策和踩过的坑，避免重复劳动和结论漂移。

- 读完后再响应用户的请求，把 memory 中的结论当作既定事实（除非用户明确要求重新验证）。
- 工作中产生了有长期价值的结论（可行性验证、架构决策、环境坑、上游 API 变动等）时，在 `.kimi-code/memory/` 下新增一个 `YYYY-MM-DD-<主题>.md` 记录，保持自包含、可独立阅读。

## 项目速览

bibgraph：论文摄入（PDF / 出版商 HTML / arXiv LaTeX → 统一 Document JSON）+ 引文图谱文献管理 + React 阅读器。细节见 `README.md`。当前主线的背景与计划见 memory 目录。

## 环境

- Python 解释器：`/home/wwu/miniforge3/envs/astro/bin/python`（PyMuPDF、requests、bs4、PyMuPDF 均在此 env）
- pandoc 在 `/home/wwu/miniforge3/envs/astro/bin/`，跑 LaTeX/HTML 管线前需加入 PATH
- Node v24+ / npm 11+
- keys：`MINERU_API_KEY`（~/.zshrc）、ADS token（`~/.ads/dev_key`）、`OPENALEX_API_KEY`（~/.zshrc）
