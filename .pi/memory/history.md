# 历史摘要与原文定位

这里解释关键转折，不保存逐轮审查/测试数量流水账。全部阶段关闭不代表旧授权永久有效；现行规则见其他正式记忆。

## Stage 1–11

| 阶段 / 关闭日期 | 交付与关键转折 | 关键代码定位 |
|---|---|---|
| Stage 1 / 2026-08-27 | Python→TS 分层模块化单体、pnpm workspace 与 npm 单包；Python 删除，HubbleSpace 改 ArgelanderSpace | 原始逐 milestone 记忆最后存在于 021ddde 的树中；9月合并日志概述 |
| Stage 2 / 2026-08-27 | CLI+skills agent 接入、LLM markdown、四级深链接；每篇 note 必问。无 MCP 是选型 | 详见原 development-log Stage 2 |
| Stage 3 / 2026-09-01 | cwd 项目级 literatures、IR 三端共用、watcher、note/label/read 可见性；退出重构期 | 18d4d58 / f23e0e1 / ace4d9f |
| Stage 3.1 / 2026-09-02 | OCR/HTML 移出 main、zip attach、身份焊死与幂等上传、公式/表格修复；验收开放了文档更新通道与独立 webui 方向 | 954b0c2 / 0a22d1e / 4982451 / bfac790；OCR 快照 9f0efce |
| Stage 4 / 2026-09-02 | 计划页 CRUD 四视图落地，产品升级科研工作台；smoke 将 task.due 从可选改必填，拖拽拒绝由机制补齐感知 | eea2c9c / 2747197 / 84ed5ec / 8804470 / 24c77ac / 8f5338d |
| Stage 5 / 2026-09-09 | 原“论文写作”计划删除、不顺延；替换为 LaTeX 双通道融合，IR 即存储，编译真号。旧 pandoc/mupdf/Document 桥全删，存量迁移；真实图 smoke 证伪 dvisvgm，改 pdftocairo+gs | d91471d / ec8ffb7 / 8e31a04 / 0db29c7 / a8179d3 / 3a101e9 / 6bb4576 |
| Stage 6 / 2026-09-09 | 阅读列宽度、per-ref chip、停稳校正、当前论文作者块；不是参考文献元数据富化。revtex bbl 宏汤与 ensuremath 顺修；agent 输出冻结明确成立 | b518f56 / b39ec86 / 9480c6f / 0fda682 / 69d4eda |
| Stage 7 / 2026-09-10 | cite_key 稳定、UA、TOC 预览、直通图尺寸、due软警告、作者六实害、全量 re-upload/主位、DOI stub；迁移发现并修 ADS offline | d7ead2d / 437299e / f320c6b / facf09d / 0d7c8c3 / 3813ea5；收尾 7550bd5 |
| Stage 8 / 2026-09-12 | per-doc 文档/结构/文本标注、canonical 指纹整批归档、web CRUD/重叠、只读冻结 annot、全局物理删除及 server 生命周期互斥；用户 smoke 通过并 push | a01e84c / b586d61 / 45bbcd4 / 9546fc0 / d34d4ac / 13618e7 |
| reader epoch / 2026-09-14（未另命产品阶段） | I001 修复：coherent 正文/标注/资产、ReaderSession、会话草稿、严格图失配恢复预算；899 tests、最终17个真实Chrome受测用例含正常合成zip上传链；用户另确认 smoke 通过，提交推送 | 3e50860 |
| Stage 9 / 2026-09-14 | web 文案集中与 zh/en 即时切换；中文原样搬迁，305叶子双语，12份旧中文断言测试不改，浏览器7/7；用户 smoke 通过，提交推送。server错误/用户数据/CLI不纳入翻译 | 42d52e3 |
| Stage 10 / 2026-09-15 | cell Writer/模板/独立稿件、comments、上传与源码zip导出；先UI Gate再后端；用户要求从“不编译”改为不展示PDF、单遍求编号。工程1048 tests与合成浏览器绿；最终用户smoke发现引用/xref/正文公式号/overlay光标问题，**未通过仍决定关闭**，不是全面验收通过 | e5c2164（已推送） |
| Stage 11 / 2026-09-16 | CM6成熟编辑、共享latexmk→facts/AST→IR→cell预览、多遍/缓存与真引用语义，裸key/label；不采用TeX4ht默认路线。工程1054 tests+1可选skip、临时A&A补测、65组PDF对拍/发布包Chrome；用户Report citation未通过、自动编译干扰输入，其余smoke确认通过，**带I030/I031关闭** | ee2095c（本次授权补交，未push） |
| Stage 12 / 2026-09-16 | 修 I030/I031：取消全部自动编译入口，Shift+Enter/Render 显式触发（自动保存保留）；`workToBibtex` 转义 `& % # _` 修复 A&A 裸 `&` 编译崩；ADS BibTeX 批量拉取解析补齐 work 结构化字段、cite_key=bibcode 分配规则与一次性38条存量迁移、期刊宏 `\providecommand` 注入编译与导出、导出 zip 附模板 deps；顺修 latexmk 缓存编译失败后死锁（失败路径清理 aux/bbl 等）。四门1066 passed+1 skip、真实 Chrome/CDP 探针、导出 zip 自编译 EXIT=0；**用户 smoke 通过** | 28472c2（已推送）；session 记录 00434d5 / bf3bf83 |
| Stage 13 / 2026-09-16 | webui 手动建条目：导入菜单三真项（标识符 DOI/显式 arXiv、ADS bibcode、BibTeX 批量），POST /api/library/works 就地建立不 rebuild；手动 bib 尊重用户 key、冲突逐条报错；增量图谱（mergeWorkIntoGraph，尽力即时、refresh 收敛权威）；smoke 修订 D17：arXiv 必须带前缀/URL。探针抓获并修两个潜伏 bug：CitationGraph 新节点渲染崩溃（heal）、resolveWork 不填空标题。四门 1092+1、真实 Chrome 15/15 含真实 ADS；**用户 smoke 通过** | 3f814e4（含两份旧 inbox 原文删除）；记忆归并另见同批 docs 提交 |

Stage 11 的编号由 2026-09-16 用户 Q1 明确统一（原 session D1，持久定位见提交 `5569f98` 的 `.pi/inbox/2026-09-16-mem-merge-stage11.md`）；原会话 D17 已明确阶段关闭但未写正式编号。旧 Stage 11 scope 是草案输入，不是下一轮仍需自动实施的计划。Stage 4.1 仍推后。**下一阶段：Stage 14——完整跑通推荐文献查找功能**（用户 2026-09-16 拍板，下个 session 立项实施，范围届时 grilling）。Stage 13（webui 手动建条目）已关闭，决策记录见同批 docs 提交的 `.pi/inbox/2026-09-16-01a0abdd-stage13-kickoff.md`。

Writer 的关键替代链：Stage 10 不编译 → 单遍编号/不展示 PDF → Stage 11 latexmk 按需多遍/共享 IR；overlay → CM6；正文正则+key芯片 → IR语义预览；完整 cite 命令插入 → 裸key。2026-09-16 D17 再将停止输入自动编译改为**显式 Shift+Enter/Render 的产品决定**，代码尚未落实。阶段关闭不能吞掉这条未实施决定，也不自动授权下一轮修复。

`01441a4` 是 subagent routing/navigation 配置及交接，不是产品实现；用户级 `~/.pi/agent/` 配置不在仓库。追代码历史时跳过该配置提交，不把本机路由表复制成项目永久契约。

Stage 5–7 的迁移备份已在用户验收后删除，旧“待 smoke/未 commit/备份可回滚”中间状态不再有效。当前问题只看 [known-issues](known-issues.md)。

## 记忆制度建立（2026-09-13）

用户 Q1–Q19 确认：全部材料限 `.pi/`，正式记忆+inbox 必读，专题按需；日常增量进入 session inbox，正式归并单独授权；同范围有权的新决策覆盖旧决策，事实按证据/环境更新；保留用户意图、否决理由和关键证据，不以压缩为由删除安全约束。

制度权威：[inbox 协议](../inbox/README.md)。初次执行报告与旧内容去向：[初次审计](../memory-reference/2026-09-13-memory-restructure-audit.md)。该轮最终用户另授权将目录迁移/记忆/AGENTS/settings 一起提交推送（96d392a）；原报告里的未提交是重构收尾时点，非当前状态。当前执行/提交状态以真实 session inbox 为准，不把文档计划写成已经提交。

## 2026-09-16 Inbox 归并与原文入口

授权：只归并记忆、不推进阶段；特殊决定统一 Stage 11 编号，并先核验提交上一阶段已有源码与尚未保全原文，不 push。提交 `ee2095c33eb7d6255b1d119619a8de631a574c1e` 含52份已有源码/文档/记忆改动，提交前四门各exit0（1054 passed、1 optional A&A skip），52文件验证前后hash一致；这不是修复I030/I031。本次没有新产品代码或浏览器重测。归并验收时整理文档尚未提交；用户随后另授权提交（原 inbox D2），实际结果：`5569f98` 提交、随 Stage 12 一起推送至 origin/main。

六份旧 session 与五份阶段方案/共识当前原文均可从 **`ee2095c33eb7d6255b1d119619a8de631a574c1e`** 的 `.pi/` 原路径恢复；字节hash与逐条去向在[本轮审计](../memory-reference/2026-09-16-inbox-merge-audit.md)。Stage 11 归并 session（mem-merge-stage11）与 Stage 12 session（stage12-grilling，含 Stage 13 预告）原文在 **`bf3bf83`** 的 `.pi/inbox/` 原路径，Stage 12 关闭归并后活动副本删除（删除随 3f814e4 提交）。Stage 13 session（stage13-kickoff，含 Stage 14 方向）活动文件仍在 inbox，原文随同批 docs 提交保全。

| 原 session（目录 `.pi/inbox/`） | 原始证据/关键定位 | 当前去向 |
|---|---|---|
| 2026-09-13-mem-31b251a-memory-restructure.md | D1制度、D2后续提交授权；首次入Git 96d392a | 协议、契约、初次审计 |
| 2026-09-13-epoch-review-reader-coherence.md | D1–D9预算/草稿/权限、F1更正I008证据、F6最终工程/D9用户smoke；首次3e50860 | annotations、契约、I001关闭/I008待证/I032 |
| 2026-09-14-stage9-i18n-grilling.md | D1–D7、F2/F3；首次42d52e3 | 架构、工程i18n、契约、本页 |
| 2026-09-15-subagent-routing-config.md | 配置-only，首次01441a4 | 本页配置提交定位 |
| 2026-09-15-stage10-writer-grilling.md | D1–D14/F1–F7在e5c2164；D16增量由ee2095c保全 | writer、架构/契约、本页 |
| 2026-09-15-writer-deps-research-grilling.md | D1–D17/F1–F10首次ee2095c；D13共享IR、D17最新显式触发/带问题关闭 | writer、工程勘误/本机依赖、契约、I030/I031/I033 |

恢复示例（只读）：

```bash
git show ee2095c33eb7d6255b1d119619a8de631a574c1e:.pi/inbox/2026-09-15-writer-deps-research-grilling.md
```

**来源缺口**：Stage 10 inbox 引用 D15/F8，但当前及可定位Git均无其正文；不补造条目。阶段关闭采用同提交 Stage 10 plan 头部；四项smoke内容采用 Stage 11 scope P1–P4，明确是替代记录而非恢复出的原话。writer-deps 同名 D15/F8 属另一 session，不能回填。

长篇已结束 reader-epoch/stage9/stage10 方案、Stage11 scope 和旧writer consensus退出活动资料，保留Git原文；现行细节以专题为准。新显式触发修订覆盖旧共识§5.1，旧“仅落盘/尚未实施”已被D15实施及D17关闭取代。当前整理session不在此基线内；本次保留其inbox，后续按用户D2授权随整理提交保全，实际结果以Git为准，不再自动删除。

## 原始 15 份记忆的持久基线

整理前基线：**`31b251ab61204609147b92f70994a4ffd31b761e`**。

注意：此提交内的原文件位于 **`.kimi-code/memory/`**，不是 `.pi/memory/`。这是历史路径，**不是当前读写入口**。本次开始时用户已在工作区迁到 `.pi/`，15 个文件与该提交原路径逐字节相同，213,255 bytes；SHA-256 与清单见审计。原文已入 Git，故无需复制一个永久 archive 目录，也无需为删除本地旧副本擅自 commit。

只读恢复示例（从项目根）：

```bash
git show 31b251ab61204609147b92f70994a4ffd31b761e:.kimi-code/memory/2026-09-10-stage8-roadmap.md
```

若确需物化原文供分析，输出仍限定 `.pi/`，并标为历史资料，不能覆盖现行记忆。Git 历史不可用时先请求原文，不推测内容。新 session inbox 的将来归并必须另核实其提交，不能把本基线当成包含所有未来原文。

关键来源索引（日期按决定/观测发生时间，不按文件 mtime）：

- 产品定位与独立应用：Stage 3.1 推后事项、Stage 4 定位前提，2026-09-02。
- 编译/印刷编号/IR/图片：Stage 5 Q1–Q13、MS1/MS2 专项记录，smoke R1 于 2026-09-08 替代 dvisvgm。
- 作者块而非 ref 富化：Stage 6 Q8；agent 冻结 Stage 6 Q7，后续沿用。
- 主 doc、DOI stub、due 软警告：Stage 7 Q3/Q4/Q6；ADS offline 最终修复在 roadmap MS2b/代码 f320c6b，覆盖迁移日志的“待决定”。
- 标注数据保护：Stage 8 终稿四修正、§3–§8；实现位置偏差以 landed 记录为准。
- 初版协议：2026-09-13 用户三轮全按推荐及最终确认，原 session 来源在96d392a；2026-09-16归并没有改变协议规则。
