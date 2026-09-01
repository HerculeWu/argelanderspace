# ocr-features 分支封存说明

本分支是 ArgelanderSpace OCR / 非 LaTeX 摄入能力的**封存快照**（2026-09-01 自 main `5c0e93e` 建）。main 自 Stage 3.1 起只保留 arXiv / 本地 LaTeX 摄入，以下能力整体封存于本分支：

- PDF 摄入（MinerU OCR）：`packages/core/src/pipelines/pdf`、`packages/infra/src/mineru`、`infra/src/pdf`（pipeline/text-provider/links）、`core/src/acquire/fetch-pdf.ts`、`infra/src/acquire/pdf-downloader.ts`
- 出版商 HTML 摄入（A&A/OUP 等适配器）：`packages/core/src/pipelines/html`、`packages/infra/src/html`
- PDF 专属 Document 构建层：`core/src/documents/` 的 textfix / pdf-links / mineru / sequence-matcher / structure
- 相关测试、fixtures（golden-pdf / golden-html 等）

## 状态：未维护、不 rebase

降级原因（2026-09-01 用户拍板）：出版商全线 bot 墙（DataDome/Cloudflare/Radware）；MinerU 鉴权 401 + 配额约束；约 9 成论文 arXiv 可得与出版版一致内容，例外由用户自行转 LaTeX 经 webui 上传 zip 入库。

复活时以 main 为准重新评估，**勿直接合并本分支**。背景与决策记录见 main 的 `.kimi-code/memory/`（`2026-09-01-stage3x-roadmap.md` 定稿、`2026-09-01-known-issues.md`、`2026-09-01-pitfalls.md`）。
