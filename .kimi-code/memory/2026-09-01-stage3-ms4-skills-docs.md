# Stage 3 / MS4 完成：skills 契约 + search 空 note hint + 文档同步（2026-09-01）

实现 `2026-09-01-stage3-design.md` 的 MS4 节（E 组 skills + 文档 + 验收指南 + MS2b 遗留 warning 清理）。
四道门全绿：测试 **424 → 426**（cli +2），`corepack pnpm -r build|test|typecheck` + 根 lint（0 warning）。

## 产物（逐文件）

- **`packages/cli/src/agent.ts`**（本里程碑唯一功能代码改动）：`runSearch` 结尾往 **stderr** 打
  `hint: N/M works have empty notes`（仅 N>0；M=总 work 数）。空 note 判定 `(w.note ?? "").trim() === ""`
  （覆盖 null/undefined/空串/纯空白）。stdout 保持纯 JSONL；模块头注释同步。
- **`packages/cli/tests/agent.test.ts`** +2：①纯空白 note 仍计空（33/34 hint）+ stdout 纯 JSONL；
  ②全有 note 时无 hint。既有 search 测试的 stderr 断言从 `""` 改为 `hint: 34/34 ...\n`
  （core fixture library.json 34 works 全 `note: null`）。新增 `rewriteNotes` 助手（直接改写 tmp
  数据目录的 library.json）。
- **skills 三件套 + skills/README.md**：
  - 契约从"每条命令显式 `--data-dir <root>`"改为"**在项目根（含 `literatures/` 的目录）跑 CLI、不传
    `--data-dir`**；cwd 不对先 `cd`（默认 `./literatures` 仅 cwd 相对、**无向上查找**）"；`--data-dir`
    仅保留为文档化逃生舱。所有示例命令去掉 flag。
  - 每个 SKILL.md 开头加硬条款 "## Non-negotiable: the CLI is the only interface"（不读任何源码
    回答文献问题，读源码 = 走错路）——针对 Stage 2 验收遗留"pi 爱自己读仓库源码"。
  - query skill：空 note 检查从旁注节（"The empty-note caveat"，已删）升为主流程
    **Step 2 — Check for empty notes (and offer to backfill)**，原 Step 2–5 重编号为 3–6；
    明确 search stderr 的 hint 行是机器层信号。
  - skills/README："out-of-band writes don't push"（已过时）改为"server 轮询广播 `library.changed`，
    webui 免 F5 自动感知 CLI 写入"；machine-clean 节补 hint 说明；CLI 路径补绝对形态
    `node <repo>/packages/app/dist/bin.js`；约定节加"CLI is the only interface"总纲。
- **README.md**：Data directory 节改 `./literatures` 项目库语义（每项目一库、项目根相对、无向上
  查找）+ 两句带过上 server 轮询广播 / note tab 全文只读 / label 色点 / 已读标识 / upload 真实进度；
  config.toml 示例注释 default ./literatures；agent 契约表 search 行补 hint。
- **AGENTS.md**：项目速览加 Stage 3 状态段；Stage 2 节 `literature-library-skills/` "去留由用户决定"
  → 已删除；环境节补 pandoc shim 坑（前置整个 astro bin 会让 astro 的 node v20 抢先，pnpm 起不来；
  用只含 pandoc 的 shim 目录，如 /tmp/ms1-bin）。
- **`docs/manual-test-stage2.md`**：顶部废弃指引（默认目录契约变 `./literatures`，最新见 stage3）。
- **`docs/manual-test-stage3.md`**（新，中文）：0 准备（build + 裸跑 serve 默认 ./literatures）→
  1 存储统一（CLI 改 note/label → webui 免 F5）→ 2 webui 缺口（笔记 tab 全文只读 / label 色点 /
  已读标识）→ 3 upload（真实进度流水 + `%PDF-junk` 假 PDF 失败探针 + 残留清理）→ 4 IR 渲染回归
  （LaTeX/HTML/PDF 三源各一篇 + 深链接四级）→ 5 独立环境 agent 冒烟（/tmp 新项目目录 + 空
  `literatures/` + 绝对路径 CLI + `pi -nc`，观察 hint/主动提示/不读源码）→ 6 已知限制清单。
- **`packages/web/src/components/RefCard.tsx`**：删 `cardExpand` 的未使用 `store` 参数（MS2b 换
  Segments 后遗留）+ 更新调用点；根 lint 回到 0 warning。

## 代码核实过的事实（未来 session 直接采信）

- repo 真实库 `literatures/library/library.json`：**35 works**；`arxiv:2603.03522` note/label 空、
  read false（stage3 指南第 1/2 步用它）；无 doc 的 work 两条
  （`doi:10.1051/0004-6361/201117315`、`openalex:W3099878876`）→ 详情面板显示"需上传 PDF"。
- webui 色点优先级：会话级右键菜单 overlay > 持久化 `label` 字段 > star→amber 播种；色板
  red 重点 / amber 待读 / green 已精读 / blue 方法 / violet 灵感（LibraryView.tsx `LABEL_COLORS`）。
  已读 = 标题灰化 + "· 已读" 标记；未读条目保留未读小圆点。
- upload 失败探针：`printf '%PDF-junk\n'` 能过 server 的 `%PDF` 头检（app.ts 前 4 字节），
  mupdf 解析失败 → job failed → 详情面板显示错误且**刷新后仍在**（WS hello 回放恢复 tracking）。
  失败残留清理：`rm -rf literatures/output/upload-*`。
- MinerU 上传/下载超时 300s → 1800s（MS3）；upload 进度流水 = runner 的 report 直通 attachPdf 的
  onProgress，阶段跃迁全落 job.progress。

## 状态

Stage 3 代码侧全部完成（MS1–MS4）。全部改动（含 MS1–MS3）仍在工作区**未 commit**——commit/push
由用户逐批确认。手动验收（`docs/manual-test-stage3.md`）待用户执行。
