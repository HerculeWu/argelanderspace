# Stage 1 完成状态（2026-08-27）

**Stage 1 TS 重构已完成**，全部在 `ts-migration` 分支（未合 main、未 push、未发布 npm）。每个 milestone 一个 commit（M0→M6 共 10 个，含 M5 fixup）。

## 验收状态

- 测试 **262 全绿**：contracts 17 / core 78 / infra 90 / server 65 / cli 12
- **6 篇 golden 逐字段 diff 全过**：LaTeX×2（allowlist 空）、PDF×2（allowlist 2：source.path、is_ocr——值已断言）、HTML×2（allowlist 空）
- 打包冒烟：`npm pack` → 干净目录安装 → `argelanderspace serve` 起服务、SPA/API/WS 正常、SIGTERM 干净退出（bundle 4.4MB，mupdf 保持 external——WASM 定位 + AGPL 边界双重原因）
- Python 树**零改动保留**（`bibgraph/`、`server/`、`tests/run_tests.py`、`data/`）

## 待用户操作（按序）

1. **手动冒烟测试**（用户明确要求留给自己）：`node packages/cli/dist/bin.js serve --data-dir ./data --port 8000`（dev 树内）或 pack 后 `npx argelanderspace serve`。重点看：Doc 阅读器、Library 图谱、上传 PDF 的异步进度（WS）、改名后品牌。
2. 冒烟通过后：**删 Python 树**（`bibgraph/`、`server/`、`scripts/reprocess.py`、`tests/run_tests.py`、`__pycache__`），decision #4 已授权。
3. 发布前改两处占位：`packages/app/package.json` 的 `repository.url`（现为 `https://github.com/<you>/argelanderspace`）、`LICENSE` 版权人（现为 "ArgelanderSpace contributors"）。
4. `npm publish`（在 `packages/app` 下）与 git push 均未做。

## 留给 Stage 2 的接缝

- WS 通道 `/ws`（hello 快照 + job.* + library.changed）已就绪——agent 可订阅
- `htmlAdapterInfos()` 活注册表已接入 planner
- 深链接设计（MCP 响应带 `http://localhost:PORT/doc/<id>#fig-N`）待 DocPane 支持 URL 定位——Stage 2 第一项
- skills 三件套（`literature-library-skills/`）仍 untracked，Stage 2 重写为 MCP 薄层

## 已知但有意保留的事项

- infra 的 crossref/openalex UA 仍是 `HubbleSpace/0.1`（bug-for-bug；改名只到品牌层，UA 属行为层——可在 Stage 2 顺手改）
- upload 异步化是 M4 有意分歧（202 + job + WS 进度）；`?sync=1` 保留旧行为
- mupdf-js 上游 bug：`onChar` 截断非 BMP 码点（已在 infra 绕开，可向上游报 issue）
- `--reuse` 在 Python 版就是死 flag，TS 版原样保留为 no-op
