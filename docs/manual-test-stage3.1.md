# Stage 3.1 手动验收指南（pandoc 硬下限 / 摄入面收窄 / zip 上传 / 公式编号 / 表格修复 / stub pane 移除）

本指南验证 Stage 3.1 的五组改动：①pandoc ≥3.9 硬下限（旧版本直接报错指路）；②摄入面收窄
（只收 arXiv id 与本地 LaTeX 源，DOI/URL/PDF 友好报错）；③webui 上传改 LaTeX zip 包
（attach-only、三段进度、幂等 docId、失败可见）；④公式全量编号（`\tag` 优先）；⑤AASTeX
`deluxetable`/`table*` 表格修复；外加"终端/浏览器"空 stub pane 的移除。每一步给出：
**要做什么**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行、
> **不传 `--data-dir`**（默认 `./literatures`，只在 cwd 下解析）。如果你全局装过
> `npm i -g argelanderspace`，直接写 `argelanderspace` 即可。
> Stage 3 的验收指南（`manual-test-stage3.md`）留档作回归参照，不再单独维护。

---

## 0. 准备

```bash
cd /home/wwu/project/bibgraph

# 全量构建（cli/server/web/app bundle）
corepack pnpm -r build
```

先**不要**配 pandoc shim——§1 的第一步要拿系统 pandoc 3.1.3 当反例。server 也在 §1 之后再起
（server 进程会跑上传摄入，必须带着 shim 启动）。

---

## 1. pandoc ≥3.9 硬下限

**1a. 拦截（系统 pandoc 3.1.3，无 shim）**

先造一个最小 LaTeX 项目（§4 公式编号验收也复用它）：

```bash
mkdir -p /tmp/eqtest && cat > /tmp/eqtest/main.tex <<'EOF'
\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Math}\label{sec:math}
See \eqref{eq:a}, \eqref{eq:tagged} and \eqref{eq:b}.
\begin{equation}\label{eq:a} a=1 \end{equation}
\begin{equation*} b=2 \end{equation*}
\[ c=3 \]
\begin{equation}\tag{S1}\label{eq:tagged} d=4 \end{equation}
\begin{equation}\label{eq:b} e=5 \end{equation}
\begin{align}
  f &= g \label{eq:r1} \\
  h &= i \nonumber \\
  j &= k \label{eq:r2}
\end{align}
\end{document}
EOF
```

确认当前 shell 里没有 shim（`which pandoc` 应指向 `/usr/bin/pandoc`，`pandoc --version` 是 3.1.3），
然后跑摄入（`--out-root` 指到 /tmp，不碰 repo 的库）：

```bash
node packages/app/dist/bin.js ingest /tmp/eqtest --no-assets --out-root /tmp/eqout-floor
```

**应该发生：** 退出码非 0，stderr 打出可操作的报错（版本、路径、补救命令全点名）：

```
error: pandoc >= 3.9 is required for LaTeX ingest (older pandoc strips display-math environments and mangles equations); found pandoc 3.1.3 at /usr/bin/pandoc. The astro conda env ships a new enough pandoc — point PATH at a shim dir instead: mkdir -p /tmp/ms1-bin && ln -sf /home/wwu/miniforge3/envs/astro/bin/pandoc /tmp/ms1-bin/pandoc && export PATH=/tmp/ms1-bin:$PATH
```

如果这台机器没有系统 pandoc（`which pandoc` 为空），则应报 `pandoc is not installed …`，同样算通过。

**是 bug 的迹象：** 旧 pandoc 下摄入照常跑通（说明硬下限没生效——3.1.3 会剥公式环境外壳，产物必然残）。

**1b. shim 建法（唯一正确姿势）**

```bash
mkdir -p /tmp/ms1-bin
ln -sfn /home/wwu/miniforge3/envs/astro/bin/pandoc /tmp/ms1-bin/pandoc
export PATH=/tmp/ms1-bin:$PATH
pandoc --version   # 应是 3.9.0.2
```

⚠️ **不要把整个 astro bin 前置进 PATH**——里面的 node v20 会抢先系统 node，pnpm 起不来。
只 symlink pandoc 一个二进制。/tmp 会被系统清理，shim 丢了重建即可。

**应该发生：** 带上 shim 后同一条 ingest 命令跑通：

```bash
node packages/app/dist/bin.js ingest /tmp/eqtest --no-assets --out-root /tmp/eqout
```

从这里起，**所有终端（含跑 server 的）都保持 `PATH=/tmp/ms1-bin:$PATH`**。起服务：

```bash
node packages/app/dist/bin.js serve    # 单独一个终端，保持运行
```

浏览器打开 <http://localhost:8000>，确认文库列表能加载（repo 自带 35 条）。

---

## 2. 摄入面收窄：DOI/URL/PDF 友好报错

**做什么：** 依次试三种不再受理的输入：

```bash
node packages/app/dist/bin.js ingest 10.1051/0004-6361/201117315
node packages/app/dist/bin.js ingest https://www.aanda.org/articles/aa/abs/2020/06/aa38192-20/aa38192-20.html
node packages/app/dist/bin.js ingest literatures/input/2603.03522.pdf
```

**应该发生：** 三条都退出码非 0、不产出任何文档：

1. DOI / 出版商 URL → `error: cannot ingest DOI/publisher URL …: publisher HTML/PDF ingestion is in
   development (archived on the ocr-features branch); use an arXiv id, or upload a LaTeX source zip
   in the web UI`；
2. 本地 PDF 文件 → `error: unrecognized source '…': expected an arXiv id/URL or a local
   .tex/dir/tarball (PDF ingestion is in development — …)`；
3. 正向对照（arXiv id / 本地 .tex / 目录 / tarball）照常可用——§4、§5 就是正例。

**是 bug 的迹象：** 三条中任何一条开始真的下载/摄入（说明收窄没生效），或报错是纯栈trace而非指路文案。

---

## 3. zip 上传：成功 / 幂等 / 失败探针

上传入口是**详情页 attach-only**：目标 work 必须已存在（库里"需上传源码包"的条目）。
本节约内容对不上的物料做管路测试——上传的 zip 是 Pal 5 论文源码，挂到 Hyades 那条 work 上，
**内容不匹配是预期的**；身份焊死保证它挂到目标 work 而不会新建重复 work。

**3a. 造测试 zip**（直接打包 repo 自带 2607.17040 的 arXiv 源码树）：

```bash
cd literatures/output/arxiv-2607.17040/src && zip -rq /tmp/pal5-src.zip . && cd /home/wwu/project/bibgraph
```

**3b. 成功路径。** 浏览器文库页搜索 "Hyades"，点开 "Simulations of the Hyades"
（`doi:10.1051/0004-6361/201117315`，来源标"需上传源码包"）→ 详情面板点
**"上传 LaTeX 源码包（zip）"** → 选 `/tmp/pal5-src.zip`。

**应该发生：**

1. 按钮上的进度文字逐段滚动：**"Unpacking LaTeX source zip" → "Ingesting LaTeX source" →
   "Rebuilding library"**，任务期间按钮禁用；
2. 完成后**免 F5** 条目自动变"已入库"（server 广播 `library.changed`）；
3. 终端里 `node packages/app/dist/bin.js list` 可见新 doc
   `upload-doi-10-1051-0004-6361-201117315-a70331`（幂等 docId = `upload-<slug44>-<hash6>`），
   works 总数仍是 **35**（没有重复 work）；条目点击可进阅读器看全文。

**3c. 幂等重传。** 同一条目再传一次同一个 zip。

**应该发生：** 再次成功，`literatures/output/` 下仍只有一个 `upload-doi-…-a70331` 目录
（重传=覆盖同一 doc），文库仍 35 条。

**3d. 失败探针（两种都要试）。**

```bash
printf 'not a zip\n' > /tmp/fake.zip                                     # 探针一：假 zip
echo hello > /tmp/readme.txt && (cd /tmp && zip -q notex.zip readme.txt) # 探针二：合法 zip 但没有 .tex
```

**应该发生：**

1. 探针一（`/tmp/fake.zip`）：POST 被同步拒绝（400），详情面板红字 **"上传失败，请重试"**；
2. 探针二（`/tmp/notex.zip`）：job 跑起来后失败，红字 **"上传失败：no .tex file found under …"**；
   **F5 刷新后红字仍在**（WS hello 回放恢复失败状态）；
3. 探针后重传 `/tmp/pal5-src.zip` 仍能成功（失败不留残状态）。

**是 bug 的迹象：**

- 进度自始至终只有一条静态文本，或失败后界面毫无提示；
- job 失败的红字一刷新就消失；
- 重传产出第二个 `upload-*` 目录，或 `list` 里 works 变多；
- 上传成功后条目还标"需上传源码包"（身份焊死/校验失效）。

**清理（可选，把库恢复原样）：**

```bash
rm -rf literatures/output/upload-doi-10-1051-0004-6361-201117315-a70331 \
       literatures/output/upload-doi-10-1051-0004-6361-201117315   # Stage 3 遗留 spool（无 json，不参与建库）
node packages/app/dist/bin.js library build --offline
```

---

## 4. 公式全量编号（`\tag` 优先）

**做什么：** 把 §1a 造好的最小文档摄入 repo 的库并重建：

```bash
node packages/app/dist/bin.js ingest /tmp/eqtest --no-assets
node packages/app/dist/bin.js library build --offline
```

浏览器打开 <http://localhost:8000/doc/latex-eqtest>。

**应该发生：**

1. 五个独立公式块右侧编号依次是 **(1) (2) (3) (S1) (4)**——`equation*` 和 `\[…\]` 这些
   传统不编号的形式也按序发号；
2. **(S1)** 来自 `\tag{S1}`：显示号用 tag 文本、**不占用计数器**（所以下一个是 (4) 不是 (5)），
   公式 body 里不残留 `\tag`（KaTeX 渲染正常）；
3. 末尾 align 块编号 **(5–6)**：逐行编号、中间 `\nonumber` 行跳过；
4. 首段 "See (1), (S1) and (4)." 三个 crossref chip 显示与公式编号同步、可点击跳转闪烁。

**是 bug 的迹象：** 任何 display 公式块没有编号；`\tag` 公式显示成序号或正文人肉残留 `\tag`；
chip 显示 "(?)"（旧行为）。

**清理：** `rm -rf literatures/output/latex-eqtest && node packages/app/dist/bin.js library build --offline`。

---

## 5. 表格修复：2607.17040 端到端

这篇 AASTeX 论文有 5 个 `deluxetable` + 4 个 `table*`（修复前全部被 pandoc 降级丢失）+
2 个普通 `table`，是本轮修复的靶标。

**做什么：**

```bash
node packages/app/dist/bin.js ingest 2607.17040      # 重摄入，覆盖 repo 里旧产物；有缓存走缓存，否则联网
node packages/app/dist/bin.js library build --offline
```

浏览器打开 <http://localhost:8000/doc/arxiv-2607.17040>。

**应该发生：**

1. §2.2 的 **Table 1**（"Summary of the Galactic potential models…"）渲染成真正的表格，带完整
   caption，不再是乱码段落；附近正文里没有 `\colhead`/`\startdata` 之类的残骸；
2. 左栏 TOC 的 **Tables 组显示 11 张表**，逐张可点开预览；
3. 正文所有 "Table N" 引用（15 行 16 处 token）**全部是可点击的 chip**（修复前这些引用全部解析失败），点击滚动定位 +
   闪烁、右栏出表格卡；
4. 公式 (1)–(5) 编号齐全；式 (3)（含 `cases` 分段）**完整渲染**、无 KaTeX 报错
   （旧 pandoc + 旧代码会把它削残）。

**是 bug 的迹象：** TOC 里表格少于 11 张；§2.2 仍有乱码段；任何 "Table N" 引用是纯文本而不是 chip；
式 (3) 渲染报错或内容残缺。

---

## 6. stub pane 移除

**做什么：** 看三处入口。

**应该发生：**

1. 左侧活动栏只剩 **计划 / 文献 / 文档** 三个图标 + 底部固定的 **扩展**（不再有"终端""浏览器"）；
2. 命令面板（⌘K / Ctrl-K）的导航组只剩 文献库 / 文档查看器 / 计划（外加操作组的"向右分屏"）；
3. 多窗格时（⌘\\）窗格头部的视图切换菜单同样只剩 计划 / 文献 / 文档；
4. "计划"和"扩展"的 stub 占位页**仍在**，点进去显示"将在后续阶段接入"。

**是 bug 的迹象：** 任何一处还出现 终端/浏览器 入口；或 计划/扩展 占位页跟着消失。

---

## 7. 回归点（Stage 3 行为保持）

细节见 `manual-test-stage3.md`，这里快速过一遍：

1. **library.changed 免 F5**：server 跑着、浏览器停文库页，另开终端
   `node packages/app/dist/bin.js label arxiv:2603.03522 --label green`，1–2 秒内色点自动变绿；
2. **label 色板**：red 重点 / amber 待读 / green 已精读 / blue 方法 / violet 灵感；
3. **笔记 tab**：详情面板"笔记" tab 显示 note 全文、只读；
4. **深链接四级**：`/doc/arxiv-2501.17225`、`#sec-2`、`#eq-2`、`#ref-6` 逐一粘贴验收
   （⚠️ 锚点是管线结构 id，不是印刷编号）。

---

## 8. 已知限制（验收时别当 bug 报）

1. **`subequations` 被 pandoc 合并成一条 DisplayMath**：只出 1 个公式块、只编 1 号，`\label` 丢失
   （两版 pandoc 同；发生率低，拍板不修）。
2. **深链接锚点 = 结构 id**：`sec-N`/`eq-N`/`ref-N` 的 N 是管线内部编号，非印刷节号/式号。
3. **PDF / 出版商 HTML 摄入降级为"开发中"**：代码在 `ocr-features` 分支；MinerU key 目前 401
   失效，启用前需自查。
4. **上传不做内容校验**：身份焊死只保证 doc 挂到指定 work；zip 里是不是那篇论文，用户自负。
5. **笔记 tab 只读 / label 右键会话级 / 无 MCP**：均沿用 Stage 3 的设计决定，详见 stage3 文档 §6。
