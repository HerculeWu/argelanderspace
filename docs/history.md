# 历史结果与原文定位

本页保存关键转折和证据入口，不是当前待办或执行授权。当前任务、开放/推后问题以 [本地 tracker](agents/issue-tracker.md) 为准；现行产品规则由各专题和 [contracts](contracts.md) 维护。

**最近产品阶段：Stage 15 已于 2026-09-18 经用户 smoke 关闭；下一产品阶段未指定，Stage 4.1 仍推后。**2026-09-21 的领域文档迁移不是新的产品阶段。

## 阶段结果

| 阶段 / 关闭日期 | 结果与重要取舍 | 持久定位 |
|---|---|---|
| Stage 1 / 2026-08-27 | Python→TS 分层模块化单体、pnpm workspace 与单包发布，HubbleSpace 改 ArgelanderSpace | 最早逐 milestone 记录在 `021ddde` 的树；9月 development-log 摘要 |
| Stage 2 / 2026-08-27 | CLI+skills、LLM markdown、深链接、摄入后每篇询问 note；无 MCP 为接入选择 | 原 development-log Stage 2，恢复基线见下 |
| Stage 3 / 2026-09-01 | cwd 项目级 literatures、IR 三端共用、watcher、note/label/read；退出重构期 | `18d4d58` / `f23e0e1` / `ace4d9f` |
| Stage 3.1 / 2026-09-02 | OCR/HTML 移出 main、zip attach 身份焊死与幂等上传、公式/表格修复；独立 webui 方向 | `954b0c2` / `0a22d1e` / `4982451` / `bfac790`；OCR 快照 `9f0efce` |
| Stage 4 / 2026-09-02 | 计划 CRUD 四视图、科研工作台定位；smoke 改 task.due 必填、拒绝拖拽补齐可感知反馈 | `eea2c9c` / `2747197` / `84ed5ec` / `8804470` / `24c77ac` / `8f5338d` |
| Stage 5 / 2026-09-09 | 原“论文写作”阶段删除、不顺延；改为编译事实＋源码融合 IR，编译真号、IR 即存储；真实图 smoke 证伪 dvisvgm，改 pdftocairo+gs | `d91471d` / `ec8ffb7` / `8e31a04` / `0db29c7` / `a8179d3` / `3a101e9` / `6bb4576` |
| Stage 6 / 2026-09-09 | 列宽、per-ref chip、停稳校正、当前论文作者块；不是参考文献元数据富化。revtex/ensuremath 顺修，agent 输出冻结独立成立 | `b518f56` / `b39ec86` / `9480c6f` / `0fda682` / `69d4eda` |
| Stage 7 / 2026-09-10 | cite_key 稳定、UA/TOC/图尺寸/due 软警告、作者六实害、全部 Work 上传/主位、DOI stub；修 ADS offline | `d7ead2d` / `437299e` / `f320c6b` / `facf09d` / `0d7c8c3` / `3813ea5`；收尾 `7550bd5` |
| Stage 8 / 2026-09-12 | per-doc 标注、canonical 指纹整批归档、web CRUD/重叠、冻结只读 annot、全局物理删除与 server 生命周期互斥；用户 smoke 通过 | `a01e84c` / `b586d61` / `45bbcd4` / `9546fc0` / `d34d4ac` / `13618e7` |
| Reader epoch / 2026-09-14 | I001 关闭：共同接纳正文/标注/资产，ReaderSession、会话草稿、严格一次图片恢复预算；899 tests、最终17个真实 Chrome 受测用例含正常合成 zip 通知链；用户另确认 smoke | `3e50860`；未另命产品阶段 |
| Stage 9 / 2026-09-14 | web zh/en 文案集中，305叶子、12份原中文断言测试不改、浏览器7/7、用户 smoke；不翻译 server错误/用户数据/CLI | `42d52e3` |
| Stage 10 / 2026-09-15 | Cell Writer、模板、便签、图片与 zip；从不编译修订为不展示 PDF、单遍求编号。1048 tests 与合成浏览器绿，但用户发现 citation/xref/公式号/overlay光标问题，**smoke 未通过仍决定关闭** | `e5c2164` |
| Stage 11 / 2026-09-16 | CM6、共享 latexmk→facts/AST→IR、多遍/缓存/真引用、插裸key/label；1054+1 optional skip，65组合成 PDF 对拍及发布包 Chrome；用户 Report citation 和自动编译干扰输入未通过，**带 I030/I031 关闭** | `ee2095c`；编号由用户在 `5569f98` 的 mem-merge-stage11 D1 确认 |
| Stage 12 / 2026-09-16 | I030/I031 修复：取消全部自动编译入口，Shift+Enter/Render，自动保存保留；bib 转义、ADS 结构化字段、cite_key=bibcode 分配与一次性存量改键、期刊宏、zip 附模板依赖、latexmk 失败缓存自愈。1066+1 optional skip、真实 Chrome/CDP、zip 自编译 EXIT=0、用户 smoke 通过 | `28472c2`；session 增量 `00434d5` / `bf3bf83` |
| Stage 13 / 2026-09-16 | 手动三模式建条目、不 rebuild、bib 用户 key、增量图；smoke 要求显式 arXiv 前缀/URL。探针修 CitationGraph 新节点崩溃与 resolveWork 不填空 title。1092+1、Chrome 15/15 含真 ADS、用户 smoke 通过 | `3f814e4`；最终决定原文在迁移基线的 stage13-kickoff inbox |
| Stage 14 / 2026-09-17 | ADS similar18/useful6 临时探索、真实引用边、成功 seed 才入历史、真取消、唯一 bibcode 入库；saved-only 图＋graph v2 锁内自愈、退役旧推荐/假导出，摘要 HTML 白名单＋KaTeX。1173+1、Chrome43/43、真实 ADS17/17（18 related/6 useful/129边）、用户 smoke 通过 | `5f554ee` feat / `5a9b1cc` docs；最终方案在迁移基线 |
| Stage 15 / 2026-09-18 | 添加时按 A/B/C 自动 arXiv 获取与同 id 原位刷新、照 upload 焊身份、持久 ingest job、失败 JSONL、附件可点击行/进度/重试、获取广告清理、隐藏开关；CLI 不动（I035）。1216+1、真实 Chrome＋网络26/26，用户 smoke 通过 | 迁移基线 `46093915` 包含最终代码、方案、inbox；其提交本身为 logs ignore 补充，不冒称 feat 提交 |

表中测试数、发布或用户 smoke 均为原阶段证据，不是文档迁移的新实测。临时 `/tmp` 探针/截图不保证仍在；工具测试绿、合成 smoke、用户 smoke、阶段关闭是不同结论。

## 关键替代链

- 产品由“文献工具/看板”升级为科研工作台与独立 webui（2026-09-02）；能力缺口不能反推永久只读定位。
- Writer：不编译 → 单遍编号/不展示 PDF → 共享 IR 与 latexmk 必要多遍；overlay → CM6；完整 cite 命令插入 → 裸 key/label。
- 2026-09-16 D17 将停止输入自动编译改为显式触发；**Stage 12 已实施**。旧“尚未实施”是 Stage 11 收尾时点，不是现行状态。
- Stage 13 的 suggested 增量图被 Stage 14 saved-only 替代，exportBibtex 假占位 Q1 已通过删除关闭，不再作为开放任务。
- Stage 15 D16 覆盖初版“已有任何 Doc 都跳过”：同 arXiv Doc 刷新，其它上传正文不碰；D10 最终接受独立 attach-arxiv 端点，撤回的中间设想不是现行接口。
- 普通 golden 可依获批变更更新，与 agent/annot 独立冻结同时有效，不相互抵消。

## 已关闭问题

### I001 — Reader 同 epoch 更新

`3e50860` 完成共同读取与前端状态机；真实合成 zip 摄入→job.done→自然 library.changed→同 main 接纳新 IR/标注/图，最终17个受测用例及用户 smoke 通过。无资产 watcher、同步 hash、跨进程与严格恢复预算的接受边界另记 I032，不能混回原问题。

### I030 — Writer Report citation / bib 编译失败

`28472c2`：workToBibtex 缺 LaTeX 转义导致裸 `&` 经 bibtex 进入 bbl；转义 `& % # _`（保留 `$`）、ADS 字段富化、期刊宏解决根因。隔离实验、真实稿件与导出 zip 编译、用户 smoke 通过；不是用扩大模板兼容承诺关闭问题。

### I031 — 自动编译干扰输入

`28472c2`：保存/打开/外部变更/切模板的自动编译入口全部取消，显式 Shift+Enter/Render，自动保存保留。真实 Chrome/CDP 连续输入0编译、Shift+Enter恰1次，用户 smoke 通过；不是增加 debounce。

## 原文恢复基线

### 本次领域文档迁移

**`46093915ab1c597eb3b1ce0a28ce73aaef99f37a`** 完整保存迁移前 `.pi/memory/`、`.pi/inbox/`、`.pi/memory-reference/` 的17份当前文件。逐文件 hash、迁移去向及检查结果见 [迁移审计](migrations/memory-to-domain-modeling.md)。

```bash
git show 46093915ab1c597eb3b1ce0a28ce73aaef99f37a:.pi/memory/contracts-and-decisions.md
```

这些路径只用于 Git 历史定位，已不是活动读取入口。删除活动文件不清除已存在的公开历史，也不会让旧内容变私有。需要物化私有原文作调查时放 `.scratch/` 并标历史，不覆盖现行文档；Git 不可用先请求原文。

### 2026-09-16 归并基线

**`ee2095c33eb7d6255b1d119619a8de631a574c1e`** 保全当时11份原文（178,509 B），包括 six inbox 与五份 reader epoch/Stage9/Stage10/Stage11/writer 共识方案。此前52份已有源码/文档/记忆改动经四门与 hash 核验后提交；这不是修复 I030/I031。

- 归并结果提交 `5569f98`，后随 Stage 12 推送（原历史记录）；不是本次提交授权。
- 原 inbox：`2026-09-13-epoch-review-reader-coherence.md`、`2026-09-13-mem-31b251a-memory-restructure.md`、`2026-09-14-stage9-i18n-grilling.md`、`2026-09-15-subagent-routing-config.md`、`2026-09-15-stage10-writer-grilling.md`、`2026-09-15-writer-deps-research-grilling.md`，均在该提交的 `.pi/inbox/`。
- 原方案在该提交 `.pi/memory-reference/`：reader-epoch-plan、stage9-i18n-plan、stage10-writer-plan、stage11-render-pipeline-scope、writer-rendering-consensus（带原日期前缀）。完整路径/hash 可从迁移基线的 `2026-09-16-inbox-merge-audit.md` 恢复。
- Stage 11 归并 session（mem-merge-stage11）与 Stage 12 session（stage12-grilling）的最终原文在 **`bf3bf83`** 的 `.pi/inbox/`；删除活动副本随 `3f814e4`，不是原文丢失。
- `01441a4` 只涉及 subagent routing/navigation 配置，不是产品实现；用户级工具配置不复制成项目永久契约。

### 2026-09-13 初次重构基线

**`31b251ab61204609147b92f70994a4ffd31b761e`** 保存最早15份、213,255 B 原始记忆，路径是 **`.kimi-code/memory/`**，不是 `.pi/memory/`。当轮字节/hash逐一匹配后才删除活动旧副本。

```bash
git show 31b251ab61204609147b92f70994a4ffd31b761e:.kimi-code/memory/2026-09-10-stage8-roadmap.md
```

当轮制度原始 Q1–Q19、D1/D2 与后续提交推送在 **`96d392a20cb4cb6e3139333299efec31ca58579b`** 的 `.pi/inbox/2026-09-13-mem-31b251a-memory-restructure.md`。旧制度已被本次用户批准的直接领域文档维护替代，不从审计恢复旧全量启动或 inbox 写入义务。

两次旧审计全文保留在本次迁移基线 `.pi/memory-reference/2026-09-13-memory-restructure-audit.md` 与 `2026-09-16-inbox-merge-audit.md`；它们是时点证据，不是另一套当前规则。

### 来源缺口

Stage 10 inbox 引用 D15/F8，但旧整理在当前及可定位 Git 中均未恢复到其正文；不补造原话。阶段关闭采用同基线 Stage 10 plan 头部，四项 smoke 采用 Stage 11 scope P1–P4，明确为替代记录。writer-deps 的同名 D15/F8 属另一 session，不能回填。

## 历史数据与环境提示

Stage 5–7 迁移备份在原用户验收后已删除，不再承诺旧 tarball 可回滚。Stage 8 后任何新数据迁移还须遵守标注三态；旧“清 JSON+assets”脚本不是现行可执行指南。

本机模板安装版本/hash、服务鉴权/网络观测与凭据位置已转入私有 `.scratch/memory-migration/local-environment.md`；不在公开文档维护另一份实时环境状态。通用工程教训见 [engineering](engineering.md)。
