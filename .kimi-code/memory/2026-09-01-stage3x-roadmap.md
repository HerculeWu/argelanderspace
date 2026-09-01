# 路线图：Stage 3.1/3.2 计划 + Stage 4/5 远期（2026-09-01 用户口述记录）

## Stage 3.1（小）：OCR 隔离 + 空页面移除

- **非 LaTeX 摄入代码整理进专门模块，整体保存到 `ocr-features` 分支，main 保持干净**：PDF 管线 / MinerU 客户端 / 出版商 HTML 适配器 / acquire 的 PDF 抓取。
- 移除 webui 现在留空的**终端和浏览器页面**——明确不包含在本产品功能中。
- 动机（用户）：OCR 是大问题（反爬/配额/鉴权 401），拖慢发布；~90% 论文 arXiv 可得与出版版一致内容。
- 助手预估工作量：**中等**。删除/隔离面：`packages/core/src/pipelines/{pdf,html}`、`packages/infra/src/{mineru,html,acquire/pdf-downloader}`、pdf 的 links/text-provider（**注意：infra `pdf/raster.ts` 与 mupdf 依赖要留**——LaTeX 管线用 mupdf 栅格化矢量图）、cli `detect.ts`/`ingest` 路由收窄、server upload 端点 + webui 上传按钮、golden-pdf/golden-html 与 infra 相关测试套件随删（infra 91 测试大半在 PDF/MinerU/HTML）；acquire planner 的 HTML 适配器注册表降级处理。渲染/阅读层不受影响（Document JSON 照读，`/api/paper/:id/ir` 不动）。webui 空页面移除是小活。
- 分支策略：`ocr-features` 分支保存被删代码（git 历史也在，双保险）；后续 OCR 功能从该分支发展成专门模块。

## Stage 3.2（小）：公式编号/渲染修复

- **保留所有公式的编号**（用户决策，理由：编号是交流的"坐标"）；注意 number 产出点可能在 core 共享的 structure/walk 层——改动会波及 `ocr-features` 分支携带的 PDF/HTML golden 语义，与 3.1 同批做可一次处理边界。
- 查明 §2.2 公式丢失的管线间隙（pandoc AST → walk，疑似未编号公式环境）并修复。
- 复查已读标识实际渲染（验收发现可见性不足）。
- 变更 number 行为会打破 bug-for-bug golden 基线——Python 基线已不存在，TS 自洽地重新冻结 fixture 并人工抽查。
- 助手预估：**小到中**（调查主导）。

## 合并建议（助手评估，用户拍板）

**建议 3.1 + 3.2 合并为一个 stage**（就叫 Stage 3.1 或 3.x）：两者工作量都不大；文件面重叠（pipelines/structure/walk 层）；3.2 修编号会动到 3.1 正要隔离的代码边界，分开做要给 `ocr-features` 分支多一次 rebase 冲突处理；合并后一次验收门 + 一次手动验收即可。若 3.2 调查揭示根因很大（如 pandoc AST 处理要重写）再拆开。

## Stage 4（远期，只记录不展开）

把计划页面补完 + agent 操作计划页面的相关功能。

## Stage 5（远期，只记录不展开）

论文写作功能。
