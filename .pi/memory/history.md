# 历史摘要与原文定位

这里解释关键转折，不保存逐轮审查/测试数量流水账。全部阶段关闭不代表旧授权永久有效；现行规则见其他正式记忆。

## Stage 1–8

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

Stage 5–7 的迁移备份已在用户验收后删除，旧“待 smoke/未 commit/备份可回滚”中间状态不再有效。当前问题只看 [known-issues](known-issues.md)。

## 本次记忆制度（2026-09-13）

用户 Q1–Q19 确认：全部材料限 `.pi/`，正式记忆+inbox 必读，专题按需；日常增量进入 session inbox，正式归并单独授权；同范围有权的新决策覆盖旧决策，事实按证据/环境更新；保留用户意图、否决理由和关键证据，不以压缩为由删除安全约束。

制度权威：[inbox 协议](../inbox/README.md)。本次执行报告与旧内容去向：[整理审计](../memory-reference/2026-09-13-memory-restructure-audit.md)。当前执行/提交状态以真实 session inbox 为准，不把文档计划写成已经提交。

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
- 本次协议：2026-09-13 用户三轮全按推荐及最终确认，当前 session inbox 留来源，未来按协议归并。
