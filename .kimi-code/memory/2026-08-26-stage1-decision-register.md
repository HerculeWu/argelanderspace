# Stage 1 决策登记册（2026-08-26 全部拍板）

逐分支决策结果，①-⑥ 共 24 项 + 技术默认值。✱ = 用户否决了助手推荐、自己做的选择。

## ① 数据与兼容
1. 存储：**文件存储不变**（library.json + data/output 布局，SQLite 以后再说）
2. 兼容口径：**bug-for-bug 兼容**（golden diff 必须全过；已知毛病原样保留，验收后单独立项修）
3. 数据目录：**`--data-dir` 可配，默认 `./data`**
4. Python 旧版：**TS 验收后删除**（git history 保留）

## ② 工程基建
5. workspace：**pnpm workspaces**（不上 turborepo）
6. 测试框架：**Vitest**
7. lint/format：**Biome**
8. 模块格式：**ESM-only，Node ≥ 20**

## ③ 框架与库
9. 服务器框架：**Hono**
10. contracts schema：**zod**（运行时校验 + 推导类型，server/web 共用）
11. HTML 解析：**cheerio**
12. BibTeX：**@retorquere/bibtex-parser**

## ④ 任务与实时
13. job runner：**手写轻量**（内存队列 + JSON 落盘，串行）
14. ✱ 实时推送：**WebSocket**（助手推荐 SSE，用户选 WS——为 Stage 2 agent 双向交互留能力）
15. REST 端点：**现有 8 个端点路径与响应形状原样保留**（前端零改动）
16. 摄入并发：**串行**（MinerU 配额 + 本地 CPU）

## ⑤ 前端与改名
17. 前端范围：**只改名 + API 对齐**（组件不动；M4 的 WS 进度客户端是唯一新增）
18. 位置：**web/ → packages/web**
19. git：**现 repo 开 `ts-migration` 分支**
20. 改名深度：**全换**（包名/UI 品牌/壳名 HubbleSpace → ArgelanderSpace）

## ⑥ 发布
21. License：**MIT**
22. 发布形态：**单包 bundle**（workspace 内部包 private，只发 `argelanderspace`，含 server+cli+web dist）
23. 配置：**env 为主 + 可选 `~/.config/argelanderspace/config.toml`**
24. ✱ CI：**Stage 1 先不上**

## 技术默认值（助手定，用户未否决）
TS strict + `noUncheckedIndexedAccess`；mupdf 版本精确锁定；原生 fetch 自封装重试/节流/缓存；tsup 构建库；commander 做 CLI；文档最后统一重写。

## 里程碑计划

- **M0 脚手架+契约**：分支、pnpm skeleton、contracts 的 zod schema（从 schema.py + golden 反推）。验收：6 篇 golden JSON 全部通过 zod 校验。
- **M1 纯逻辑核心**：library（store/seed/graph/planner/resolve）+ documents 纯逻辑（annotate/citations/crossrefs/references/structure/textfix diff）。验收：`tests/run_tests.py` 用例移植后全绿。
- **M2 infra 适配器**：mupdf（按 spike 适配点）、pandoc、HTTP 源（含 OPENALEX_API_KEY）、MinerU 客户端、cheerio fetcher。验收：适配器集成测试。
- **M3 三条管线**：LaTeX → PDF → HTML，逐一对 6 篇 golden 逐字段 diff。⚠️ 输入夹具（.htmlcache/.latexcache/mineru 缓存）必须先归档进 fixtures，尤其 HTML——站点已墙，只此一份。
- **M4 server + jobs**：Hono 8 端点、静态托管、CSRF 守卫、job runner + upload 改异步 + WS 进度。验收：API 冒烟 + upload 全流程。
- **M5 CLI + web**：commander CLI（ingest/library/serve）、web 移入 packages/web + 品牌全换 + WS 进度客户端。验收：`npx argelanderspace serve` 人工走通。
- **M6 收尾**：单包 bundle、MIT LICENSE、README 重写、config.toml、删 Python、更新 memory。验收：npm pack 干净安装一条命令跑通。
