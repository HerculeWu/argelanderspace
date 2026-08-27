# Stage 2 / MS3 完成：skills 三件套 + README + 手动测试指南（2026-08-27）

实现决策 1/3/7/10/11。产物（全部 tracked 新文件，不动 TS 代码）：

- `skills/README.md` + `skills/argelander-{paper-ingest,read-paper,query-paper-library}/SKILL.md`
  —— 旧 `literature-library-skills/` 方法论（note 纪律、C→B dispatch、B 准确性规则、核对 arXiv id）
  全部保留，机械层换成调 CLI。旧目录保持未动（用户决定其去留；注意它当前是 **untracked**）。
- 根 README：新增 "Agent integration (skills)" 节 + MinerU 配额风险段（~1000 页/天免费档），
  删掉"agent extension planned for Stage 2"的过时句。
- `docs/manual-test-stage2.md`：中文手动验收（0 准备 → 1 摄入 → 2 查询 → 3 阅读 → 4 维护 → 5 失败探针 + 已知限制清单）。

## 代码核实过的关键事实（未来 session 直接采信）

**摄入后必须 `library build`**（实测 + 代码证据）：
- `ingest` 只写 `<data>/output/<doc_id>/<doc_id>.json`（program.ts `runIngest`），doc 立刻出现在
  `list`、可 `read/show/ref`；但 **search 里没有、note/label 报 `error: unknown work ...`（exit 1）**。
- `library build`（core `rebuild()`：`seedFromOutput` 从 output 播种 → enrich → plan → graph）之后
  work 才存在。`--offline` 只关 Crossref/OpenAlex 的活体调用，**ADS 无条件构造、有 token 就照样联网**
  （server/src/deps.ts，bug-for-bug 移植 Python）；offline 足以让 work 带 title/authors 进 search。
- 实测链路（/tmp 数据目录 + arXiv 2607.17040 "Disentangling the Morphology of Palomar 5"）：
  ingest → search 空 → note 报错 → library build --offline → search 命中（id=`arxiv:2607.17040`）
  → note/label 写入成功。

**id 两个家族**：work id（`canonicalId`：doi > arxiv > openalex > title-slug 前缀 `doi:`/`arxiv:`/…）
用于 search/note/label；doc id（`arxiv-…`、`aa…`、`2603.03522`）用于 read/show/ref/list。
search 行的 `doc_ids` 做映射。

**webui 对 CLI 写入的可见性（实测代码，非猜测）**：
- 无文件监听：CLI 写 library.json **不广播 `library.changed`**（只有 webui 自己的 PATCH/upload/refresh
  经 server 才广播）→ 用户需 F5。`/api/library` 每次从盘读，刷新即新。
- `workToRef` 把 `note` 压成 **boolean**（`pyOr(w.note) !== undefined`）→ webui "笔记" tab 是占位符，
  只显示"已有 1 条笔记"，**全文不在 API 里**；验证全文用 `note <work_id>` 无参打印。
- `label --read/--tags/--star` 刷新后可见（侧栏未读点、详情 tags、色点从 star 播种 amber）；
  **`--label <color>` 持久化且进 API 但 webui 不渲染**（LibraryView 色点是本地 state）。
  以上三条已写进手动指南"已知 Stage-2 限制"。

**错误形态（实测）**：假 arXiv id → `error: HTTP 404 for https://arxiv.org/e-print/<id>`；
A&A DOI → `error: HTTP 403 for https://doi.org/...`（DataDome 页面）；均 exit 1、stderr。
未知 section/float/ref/doc/work → `error: unknown <kind> "<q>" — available/closest matches: …`。

**CLI 调用形态**：npm 包 bin 名 `argelanderspace`；repo 内用 `node packages/app/dist/bin.js`
（bundle 实测可用）或 `node packages/cli/dist/bin.js`。根 node_modules/.bin 里没有链接。
手动指南示例用的新 arXiv id：2607.17040（Palomar 5 潮汐尾，实测摄入成功，不在用户 ./data 里）。

## 验收

- 文档外零代码改动；`corepack pnpm -r build|test|typecheck|lint` 全绿（334 测试不变）。
- 自检：三个 SKILL.md 里每条命令/flag 对照 packages/cli/src/{program,agent}.ts 核实；
  每条声称的行为（note 占位符、offline 语义、链接端口链、错误格式）均有上面的实测/代码证据。
