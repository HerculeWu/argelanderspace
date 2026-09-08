# Stage 5 手动验收指南（LaTeX 解析线路重构：编译 + 融合 → TexDocIr 即存储）

本指南验证 Stage 5 的全部用户可见路径：存量迁移结果、新摄入（arXiv / 本地 / zip 上传）、
阅读器（印刷忠实编号 / cite·xref chips / 右侧栏 / TOC / 深链接 / 图显示）、agent CLI 全家、
编译失败面、工作台（文献看板 / 计划页）不受影响。每一步给出：**要做什么**、
**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行。
> 摄入硬前提 = **TeX Live**（latexmk + pdflatex/xelatex + bibtex/biber 在 PATH）；**poppler-utils（pdftocairo）+ ghostscript（gs，仅 EPS 需要）** 可选（矢量图→SVG；dvisvgm 已于 smoke R1 弃用——真图丢全部文字与内嵌位图）。
> 不再需要 pandoc（已随 MS3b 删除）。
> Stage 3/3.1/4 的验收指南留档作回归参照（`manual-test-stage3.md` / `manual-test-stage3.1.md` / `manual-test-stage4.md`）。

文中标 **（已预实测）** 的条目，是写本手册前在本机真实跑过的验证（命令与结果附在各节内联）。

---

## 0. 环境准备

**0a. 构建 + 工具链自检（已预实测：7 包全 Done）**

```bash
cd /home/wwu/project/bibgraph
corepack pnpm -r build        # 7 包全 Done；app bundle 含 dist/argelander.sty
which latexmk pdflatex xelatex bibtex pdftocairo gs   # 前四者必须（/usr/bin，TeX Live 2023+）；pdftocairo/gs 可选但缺了图不转
```

**0b. 确认 app bundle 携带插桩资产（已预实测）**

```bash
ls packages/app/dist/argelander.sty   # 必须存在（缺失 → 插桩静默降级为干净编译、丢事件流）
```

**0c. 迁移备份（若尚未删除）**

迁移前已在 repo 根生成 `literatures.stage5-backup.tar.gz`（358 MB，1907 tar 条目 vs 1798 源文件——
含目录条目）。**验收通过后用户可自行删除该 tarball。**

---

## 1. 存量迁移结果验证（已于 2026-09-08 实跑）

迁移按 Q5/Q12 执行：`output/*/.json`+`assets/` 删除 → 逐 doc 重摄入 → `library build`。

**已实跑结果**：

| 类别 | 处理 | 结果 |
|---|---|---|
| arxiv LaTeX ×7 | 重摄入成功（缓存离线） | `arxiv-1609.05917`（pdflatex 失败后 xelatex 重试成功）、`arxiv-2012.05220`、`arxiv-2501.17225`、`arxiv-2603.03522`、`arxiv-2607.17040`、`arxiv-1610.08981`、`arxiv-1804.10121` |
| arxiv LaTeX ×5 | 编译失败 → 缺失附件处理 | `arxiv-0902.1039`（老 aa.cls × 现代 natbib `\bibfont` 冲突）、`arxiv-1307.2657`（`emulateapj-rtx4.cls` 不在 TeX Live；**实测**用 emulateapj.cls 改名可编译——未自动应用）、`arxiv-1307.8124`（aa.cls 未随包也不在 TeX Live；新版 aa.cls 又触发 longtable 双栏错误）、`arxiv-2603.00229`（`\na` 宏未定义——aas_macros 缺）、`arxiv-astro-ph-9707253`（**plain TeX 格式**，非 LaTeX）|
| 非 LaTeX 时代条目 ×28 | 缺失附件处理 | PDF 时代 ×5（2603.03522、ads-1983ApJ…、arxivpdf×3）、HTML 时代 ×21（962260 + aa*×20，空目录已移除）、`upload-…-a70331`（src/ 仅剩 readme 的 smoke 残留）、`upload-…-201117315`（PDF 上传时代）；其 works 保留、doc 栏空（另有 `document/` 空目录残留一并移除）|
| library build（--offline，两轮） | works 35→36 | +1 = Palomar 正典 work（seed 语义正确；零悬空 doc_ids；全部 note/label/star/read/tags 逐字节保留）；**8 个 work 带 doc**（7 颗重摄入文档全覆盖，2607.17040 手工挂接在 2 个 work 上）|

**手动验证**：

1. `node packages/app/dist/bin.js serve`（默认 ./literatures）→ `GET /api/papers` 应恰好列出 7 个重摄入文档（**已预实测**：7 颗全部列出——1609.05917 / 1610.08981 / 1804.10121 / 2012.05220 / 2501.17225 / 2603.03522 / 2607.17040）。
2. 每颗 doc 目录应有 `<doc_id>.json` + `src/` + `build/`（.aux/.bbl/.toc/.fls/.argelander.jsonl）+ `assets/`（pdftocairo/gs 转换的 SVG）。
3. `GET /api/library` → refs 36 条、graph 重建（本机实测 nodes=156 / links=647）。
4. **bug 信号**：`/api/papers` 出现旧时代 id（aa*/arxivpdf/2603.03522 无 json）→ 说明删除没执行干净；
   `/api/library` 出现 `doc_id` 指向不存在文档 → 悬空引用，迁移漏网。

## 2. 新摄入：arXiv id（缓存命中，离线）

```bash
node packages/app/dist/bin.js ingest 2501.17225   # 已预实测：pdflatex 6s，76 refs
```

应发生：summary 输出 title/n_references=76/`engine: pdflatex`；`output/arxiv-2501.17225/build/` 有
`Arxiv.argelander.jsonl`（事件流存在 = 插桩生效）；**不应**有 "argelander.sty is missing" 警告
（有之 = app 打包资产丢失，§0b 复查）。网络不可用时走 `.latexcache`（本机缓存命中实测无网络）。

## 3. 新摄入：本地源树（fixture，真编译）

```bash
node packages/app/dist/bin.js ingest packages/core/tests/fixtures/tex/battery   # 已预实测：12 warnings 0
```

应发生：summary `engine: pdflatex`、`n_equations: 10`、`n_references: 3`；
`build/main.argelander.jsonl` 存在且含 `"type":"mathnum"` 事件（公式号印刷忠实：
align 行号 3、\tag{X}、gather 4–5、multline 6、eqnarray 7–8、child 文件 9——
`grep '"number"' .../main.argelander.jsonl | head` 可查）。

## 4. zip 上传 + 幂等重传（已预实测）

```bash
# 先建 work（acquire 一个 .bib 条目），再传 zip
curl -X POST "http://127.0.0.1:8896/api/library/upload?id=work:the-texbook-1984" \
  --data-binary @/tmp/smoke-upload.zip -H "content-type: application/zip"   # → 202 {job}
```

应发生：job done 后 `/api/library` 的该 work `doc_id = upload-work-…-d1ab20`、`pdf: true`；
doc 目录含 `<doc_id>.json` + `build/`。**重传同一 zip** → 仍只有一个 `upload-…` 目录
（幂等覆盖，**已预实测**）。
**bug 信号**：work 不存在时 job 失败（attach-only 语义，**已预实测**：无 work 时 refs add 404、
upload job 报 no matching work）。

## 5. 阅读器核对（印刷忠实编号为核心）

`serve` 后开 `/doc/arxiv-2501.17225`：

1. **公式号**：Eq. 区应显示论文真号（1–12 连续，附录表 A.1–A.4）——**绝不**出现旧版"一切 display
   公式 (1)…(N) 自产编号"；未编号 display 公式**无** (N) 徽标。
2. **cite chips**：正文 `(Author Year)` 可点，右栏 ref 卡带作者/年份/DOI。
3. **xref chips**：`Fig. N`/`(N)`/`Section N` 可跳转；TOC 与节号一致（1,2,2.1,…,A.1–A.3）。
4. **图**：`/images/arxiv-2501.17225/figures__All_in_one_XY__pdf.svg` 返回 `image/svg+xml`
   （**已预实测 200**）；**图内文字（标题/轴标签/刻度/星团标注）必须在阅读器里真实可见**——
   smoke R1 的缺陷就是 dvisvgm 转换丢全部文字（现已改 pdftocairo，本机 Chrome 对比
   pdftoppm 真值逐图核对过：文字 + 内嵌位图齐全）；暗色模式下图反色正常。
   **bug 信号**：图只有散点/曲线没有字，或天空图整块缺失 → 转换器退化，查
   `which pdftocairo` 与摄入 job log 的 figure warning。
5. **深链接**：`/doc/arxiv-2501.17225#eq-1` 滚动到公式 1；`#ref-6` 落引用块并聚焦右栏卡。
6. **表**：A.1–A.4 表格渲染（th/td 正确分隔），题注在。

## 6. agent CLI 全家（token 约定不变）

```bash
node packages/app/dist/bin.js search
node packages/app/dist/bin.js read arxiv-2501.17225            # 应含 [cite: …]/[ref: …]/$$…$$/[Figure omitted…]
node packages/app/dist/bin.js read arxiv-2501.17225 --section sec-3
node packages/app/dist/bin.js read arxiv-2501.17225 --manifest refs | head -3
node packages/app/dist/bin.js read arxiv-2501.17225 --manifest bib | head -3
node packages/app/dist/bin.js show arxiv-2501.17225 eq-1        # number: "1"
node packages/app/dist/bin.js show arxiv-2501.17225 fig-1       # image: …/figures__All_in_one_XY__pdf.svg
node packages/app/dist/bin.js ref arxiv-2501.17225 ref-6        # Bok 1934 + cited_in
node packages/app/dist/bin.js note arxiv:2603.03522 "烟雾笔记" && node packages/app/dist/bin.js label arxiv:2603.03522 --read true
```

应发生：markdown token 形态与 Stage 3/4 完全一致；`show` 的 number 是印刷号（eq-4 = "3,X" 形）；
note/label 落 library.json 并可被 search 看到。**bug 信号**：markdown 出现 `[[cite:…]]` 双方括号
token（旧双轨残留）、`show` 的 number 是顺序号而非印刷号。

## 7. 编译失败面（已预实测两条路径）

1. **不支持的构建**：`ingest packages/core/tests/fixtures/tex/minted` → 应 `unsupported-build`
   （minted 预扫描拒绝，不跑编译）。
2. **源级错误**：上传一个只有 `readme.txt` 的 zip（job 内 `findMainTex` 失败）→ job failed、
   错误进入 job.error（webui 失败探针可见，刷新后仍在）。
3. **真编译错误**（例：`ingest 0902.1039`）→ 硬失败 + 分类 `compile-error` + `!` 行摘录
   （本机实测摘录 `\bibfont already defined`）。
4. **超时**：`\loop` 源（fixtures/tex/loopy）→ `compile-timeout`。

## 8. 工作台不受影响（回归抽查）

- **文献看板**：label 色点/已读灰化/notes tab 正常（迁移保留全部 flags——本机 byte 级核对过）。
- **计划页**：`GET /api/plans` 正常读写、rev 乐观锁 409 语义不变（Stage 4 指南 §3 可复跑）。
- **深链接端口**：CLI 打印的 deep link 端口链 `ARGELANDERSPACE_PORT` > config > 8000 不变。

## 9. 迁移遗留物（用户决策点）

- **5 颗编译失败的 arxiv 条目**（§1 表）：work 保留、doc 栏空。修复路径（任选）：
  a) 手工补类/宏文件后重跑 `ingest <arxiv-id>`；
  b) webui 上传修正后的源 zip；
  c) 接受缺失（work 元数据仍在）。
- **28 颗非 LaTeX 时代条目**（PDF 5 + HTML 21 + upload 2）：doc 栏空属预期（PDF/HTML 管线在 `ocr-features` 分支封存）。
- **备份**：`literatures.stage5-backup.tar.gz` 验收通过后可删。
- **`status/`**：与迁移无关（plans.json 未被触碰）。

---

## 附：预实测命令清单（本次编写前真实执行）

```bash
# bundle 资产 + 摄入（offline cache）
node packages/app/dist/bin.js ingest 2501.17225
node packages/app/dist/bin.js ingest packages/core/tests/fixtures/tex/battery
# zip 上传 + 幂等（tmp 数据目录）
curl -X POST "http://127.0.0.1:8896/api/library/upload?id=work:the-texbook-1984" --data-binary @/tmp/smoke-upload.zip -H "content-type: application/zip"
# 迁移核验
curl -s http://127.0.0.1:8897/api/papers
curl -s http://127.0.0.1:8897/api/library | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['refs']))"
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8897/images/arxiv-2501.17225/figures__Alessi_3__pdf.svg
```
