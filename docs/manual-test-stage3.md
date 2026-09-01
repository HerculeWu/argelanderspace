# Stage 3 手动验收指南（存储统一 / IR 渲染 / webui 缺口 / upload / agent 独立环境）

本指南验证 Stage 3 的四组改动：①存储契约 `./data` → `./literatures`（项目级库、cwd 相对、无向上查找）+
server 自动感知 CLI 写入；②webui 缺口（笔记 tab 全文 / label 色点 / 已读标识）；③upload 真实进度 +
失败可见；④渲染 IR 三端共用后的阅读器回归。最后是独立环境拓扑下的 agent 冒烟（skills 新契约）。
每一步给出：**要做什么**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行、
> **不传 `--data-dir`**（Stage 3 起默认 `./literatures`，只在 cwd 下解析、不向上查找）。
> 如果你全局装过 `npm i -g argelanderspace`，直接写 `argelanderspace` 即可。
> Stage 2 的验收指南（`manual-test-stage2.md`）已废弃，以本文为准。

---

## 0. 准备

```bash
cd /home/wwu/project/bibgraph

# 1) 全量构建（cli/server/web/app bundle）
corepack pnpm -r build

# 2) pandoc shim（LaTeX 管线需要）。不要前置整个 astro bin——
#    里面的 node v20 会抢先系统 node，pnpm 起不来；用只含 pandoc 的 shim 目录
mkdir -p /tmp/ms1-bin
ln -sfn /home/wwu/miniforge3/envs/astro/bin/pandoc /tmp/ms1-bin/pandoc
export PATH=/tmp/ms1-bin:$PATH

# 3) 起服务（单独一个终端，保持运行）——裸跑，默认 ./literatures，不传 --data-dir
node packages/app/dist/bin.js serve
```

浏览器打开 <http://localhost:8000>，确认文库列表能加载（repo 自带 35 条）。

**端口说明**：CLI 打印的深链接端口取 `ARGELANDERSPACE_PORT` > config.toml `port` > 8000。
如果你给 `serve` 传了非默认 `--port`，请在跑 CLI 的 shell 里 `export ARGELANDERSPACE_PORT=<同端口>`。

---

## 1. 存储统一：CLI 写入 → webui 免 F5

**做什么：** server 保持运行、浏览器停在文库页。**另开一个终端**（repo 根目录），用 CLI 改一条 work：

```bash
node packages/app/dist/bin.js note arxiv:2603.03522 在需要 RAR/BTFR 与疏散星团动力学检验时回查此文
node packages/app/dist/bin.js label arxiv:2603.03522 --label blue --read true
```

**应该发生：**

1. 浏览器**不做任何刷新**，约 1–2 秒内文库列表自己更新：`arxiv:2603.03522` 那一条出现蓝色色点、
   标题灰化并带 "· 已读" 标记（server 轮询 `literatures/` 的 library.json + output/，广播
   `library.changed`，前端自动重拉）；
2. 再改一次（`--label green`），色点应在不刷新的情况下变色。

**是 bug 的迹象：**

- 超过几秒没动静、必须 F5 才能看到变化；
- DevTools 里 `/ws` 断连或没有收到 `library.changed`（cause 为 `external`）。

---

## 2. webui 缺口：笔记 tab 全文 / label 色点 / 已读标识

**做什么：** 在浏览器里点开第 1 步那条目的详情面板。

**应该发生：**

1. **"笔记" tab 显示 note 全文**（就是第 1 步写入的那段话），不再是"已有 1 条笔记"占位符；
   tab 内**只读**、没有编辑框——写路径归 agent/CLI，这是设计决定；
2. 侧栏条目旁的**色点颜色跟随持久化的 `label` 字段**（blue=方法；全套：red 重点 / amber 待读 /
   green 已精读 / blue 方法 / violet 灵感），不再只是 star 播种的琥珀色；
3. **已读标识**：已读条目标题灰化 + "· 已读"；未读条目显示未读小圆点。

**是 bug 的迹象：**

- 笔记 tab 仍显示占位符/计数而非全文；
- CLI 设的 label 颜色与侧栏色点不一致（或根本不渲染）；
- `--read true` 之后条目外观毫无变化。

---

## 3. upload：真实进度流水 + 失败可见

**做什么（成功路径）：** 在侧栏找一条标着"需上传 PDF"的条目（如 `doi:10.1051/0004-6361/201117315`），
详情面板点上传按钮，选一颗本地 PDF（可用 `literatures/input/2603.03522.pdf`）。

**应该发生：**

1. 按钮区域的进度**从单条静态文本变成多条阶段消息流水**（上传 → MinerU 提取 → ingest/rebuild 等
   阶段逐条滚动），任务期间按钮禁用（不可重复上传）；
2. 完成后该条目自动关联新 doc、出现在阅读器列表（无需 F5）；
3. MinerU 上传/下载超时已从 300s 提到 1800s——大 PDF 不再 5 分钟必死（知道即可，无须专门验证）。

**做什么（失败探针）：** 造一颗能过 `%PDF` 头检查、过不了 mupdf 解析的假 PDF 再上传：

```bash
printf '%%PDF-junk\n' > /tmp/fake.pdf
```

**应该发生：** 任务进入 failed，**错误消息显示在详情面板**；刷新页面后错误仍可见（WS hello 回放
会恢复 job tracking）。清理残留：`rm -rf literatures/output/upload-*`。

**是 bug 的迹象：**

- 进度自始至终只有一条静态文本（Stage 2 的旧行为）；
- 失败后界面毫无提示，或一刷新错误就消失。

---

## 4. 阅读器：IR 切换后的渲染回归抽查

Stage 3 把渲染 SOT 换成 core 构造的 IR（server `/api/paper/:id/ir`，web/CLI 同消费），这里抽查
三类源各一篇 + 深链接四级。

**做什么 / 应该发生：**

1. 打开 `http://localhost:8000/doc/arxiv-2501.17225`（LaTeX 源）：正文里的 **cite chip**
   （如 "Bok 1934"）点击弹参考文献卡；**xref chip**（Figure 1 / equation 编号）点击滚动定位 +
   闪烁；图/表/公式渲染正常（KaTeX 公式、表格、图片）；
2. 打开 `http://localhost:8000/doc/aa39341-20`（HTML 源）与
   `http://localhost:8000/doc/2603.03522`（PDF/MinerU 源）：章节树、浮动体、参考文献同样正常，
   图片能加载（img_path 含子目录的也应正常，如 `assets/…`）；
3. **深链接四级**逐一粘贴到地址栏验收：
   - 文档级：`/doc/arxiv-2501.17225` → 打开该文；
   - 节级：`/doc/arxiv-2501.17225#sec-2` → 滚动到 1 Introduction；
   - 浮动体级：`/doc/arxiv-2501.17225#eq-2` → 滚动到式 (2) 并闪烁；
   - 参考文献级：`/doc/arxiv-2501.17225#ref-6` → 先跳到首个引用它的正文块，再高亮右栏参考卡。

**是 bug 的迹象：**

- chip 点击无反应、右栏卡片内容残缺（cite/xref 与卡片的 occurrence 配对是 IR 化最大的回归点）；
- 图片 404（尤其 img_path 带子目录的 HTML 源文档）；
- 四级链接任何一级落错位置或没反应。

---

## 5. agent 验收（独立环境拓扑）

Stage 2 验收的教训之一是 pi 在 repo 里会被 AGENTS.md 带跑、且爱自己读源码。本节在**真实使用拓扑**
下验收：非 repo 目录 + 绝对路径 CLI + 空库。

**准备：**

```bash
# 新项目目录（非 repo），含空 literatures/
mkdir -p /tmp/aspace-stage3-demo/literatures
cd /tmp/aspace-stage3-demo

# 该目录下另起终端跑 server（可选，点深链接需要；裸跑默认 ./literatures）
node /home/wwu/project/bibgraph/packages/app/dist/bin.js serve --port 8043
# 对应地 export ARGELANDERSPACE_PORT=8043

# 三件套装进 pi 全局 skills（装过可跳过，symlink 随 repo 更新）
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library; do
  ln -sfn /home/wwu/project/bibgraph/skills/$s ~/.pi/agent/skills/$s
done

# 在新项目目录启动 pi（-nc 不读 context files）
pi -nc
```

告诉 agent 一句："CLI 用 `node /home/wwu/project/bibgraph/packages/app/dist/bin.js`；当前目录就是
项目根（含 `literatures/`），不要传 `--data-dir`。"（pandoc shim 的 PATH 也要带进 pi 的 shell。）

**5a. 摄入（argelander-paper-ingest）**

```
把 arxiv 2607.17040 加进我的文献库
```

应该：核对 id → `ingest` → `library build` → `search` 确认 → 主动给 note 建议稿请你确认 → 写入。
全程**不应**出现 `--data-dir`，命令都应在 `/tmp/aspace-stage3-demo` 下执行。

**5b. 查询（argelander-query-paper-library）——重点看空 note 提示**

```
我文献库里关于疏散星团潮汐尾的论文有哪些？
```

应该：

1. `search` 的 **stderr 打出 `hint: N/M works have empty notes`**（库里只有刚摄入的一篇有 note
   时尤为明显）；
2. agent **主动指出空 note 问题**并提出回填（这是 Stage 2 验收的遗留缺陷，现在既是 skills 主流程
   的 numbered step，又有机器层 hint 双保险）；
3. shortlist → 深读 → 综合，带 work id + 深链接。

**5c. 阅读（argelander-read-paper）**

```
解释刚摄入那篇的图 1
```

应该：`read --manifest refs` 定位 → `show` 取完整 caption → 回答带深链接。若起了 8043 端口的
server，点开链接应在 webui 落到对应浮动体。

**5d. 维护（note/label）**

```
把它标成已读，加 tidal-tails 标签
```

应该：`label <work_id> --read true --tags tidal-tails`；webui（若开着）免刷新自动更新。

**贯穿观察项（是 bug 的迹象）：**

- agent **读任何源码文件**（`.ts`/`.py`、repo 里的实现、`literatures/` 下的 JSON）来回答文献问题
  ——skills 开头的强硬条款禁止这么做，读源码 = 走错路；
- 命令里出现 `--data-dir`，或 agent 在错误的 cwd 下跑 CLI 后对着空库发愣；
- 深链接端口与 serve 端口不符（`ARGELANDERSPACE_PORT` 没设）。

---

## 6. 已知限制（验收时别当 bug 报）

自 MS2b/MS3 报告继承，均为已接受的边界：

1. **hyperlink-only xref 不产生 float 卡**：PDF 里只有超链接、正文无 `[ref: …]` token 的交叉引用，
   IR 数据边界上不再生成右栏浮动体卡片（Stage 2 行为是瞎凑，现已按边界处理）。
2. **TOC 浮动体预览可能带展开记号**：caption 内含 cite/xref 时，TOC 悬浮预览会显示
   `[cite:…]` 这类记号原文（cosmetic，暂不修）。
3. **笔记 tab 只读**：webui 不提供 note 编辑器，写路径归 agent/CLI（设计决定）。
4. **webui 的 label 右键菜单仍是会话级**：界面里右键改的色点只覆盖当前会话；持久化写路径是
   CLI `label --label`（Stage 3 未做 webui → library.json 的 label 写回）。
5. **无 MCP**：pi 的原生方式即 CLI + skills，这是设计选择不是缺失。
6. **深链接端口**：`serve --port` 用非默认端口时，跑 CLI 的环境需设 `ARGELANDERSPACE_PORT`，
   否则 CLI 打印的链接端口不对。
7. **出版商 HTML 全线被墙**（A&A/OUP/APS/IOP，DataDome/Cloudflare/Radware）：DOI 摄入大多 403，
   优先走 arXiv；退路是用户上传 PDF。
8. **PDF 摄入烧 MinerU 配额**（免费档约 1000 页/天）：agent 可自由触发 OCR，但批量 PDF 摄入前
   应先估算页数并跟你确认。
