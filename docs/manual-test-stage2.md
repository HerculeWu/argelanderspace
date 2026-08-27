# Stage 2 手动验收指南（pi + skills 三件套）

本指南验证 Stage 2 的三条 agent 工作流（摄入 / 查询 / 阅读）+ 维护回路 + 失败探针。
每一步给出：**要输入的 prompt**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物）。
> 如果你全局装过 `npm i -g argelanderspace`，直接写 `argelanderspace` 即可。

---

## 0. 准备

```bash
cd /home/wwu/project/bibgraph

# 1) 全量构建（cli/server/web/app bundle）
corepack pnpm -r build

# 2) 把三件套装进 pi 的全局 skills 目录（symlink，随 repo 更新）
mkdir -p ~/.pi/agent/skills
for s in argelander-paper-ingest argelander-read-paper argelander-query-paper-library; do
  ln -sfn "$PWD/skills/$s" ~/.pi/agent/skills/$s
done

# 3) LaTeX 管线需要 pandoc（arXiv 摄入用）
export PATH=/home/wwu/miniforge3/envs/astro/bin:$PATH

# 4) 起服务（单独一个终端，保持运行）
node packages/app/dist/bin.js serve --data-dir ./data
```

浏览器打开 <http://localhost:8000>，确认文库列表能加载（现有 34 条）。

然后在项目目录里启动 pi。若 agent 找不到 `argelanderspace` 命令，告诉它一句：
"CLI 用 `node packages/app/dist/bin.js`，一律加 `--data-dir ./data`"。

**端口说明**：CLI 打印的深链接端口取 `ARGELANDERSPACE_PORT` > config.toml `port` > 8000。
如果你给 `serve` 传了非默认 `--port`，请在 pi 的 shell 里 `export ARGELANDERSPACE_PORT=<同端口>`，
否则 agent 给你的链接端口是错的。

---

## 1. 摄入工作流（argelander-paper-ingest）

**输入：**

```
把 arxiv 2607.17040 加进我的文献库
```

（这是一篇 2026 年关于 Palomar 5 潮汐尾形态的新论文，确认过不在当前库里；
你也可以换任何一个库里没有的 arXiv id。）

**应该发生：**

1. agent 先**核对 arXiv id**（查 abs 页或搜索），告诉你匹配到的标题；
2. 跑 `ingest 2607.17040`，末尾打印摄入摘要（节数/参考数/引用解析率）；
3. 跑 `library build`——**没有这一步不算完成**（只 ingest 的话文献库里没有这条 work）；
4. 用 `search` 确认新条目出现；
5. **主动给出一条建议 note**（形如"在 … 场景下回查此文"）请你确认或修改；
6. 你回复后，agent 用 `note <work_id> <text>` 写入（work id 形如 `arxiv:2607.17040` 或 `doi:...`）。

**验证：**

- 浏览器**手动刷新（F5）**后，新论文出现在文库列表（CLI 写入不会实时推送，刷新是预期操作）；
- 点开它的详情面板，"笔记" tab 显示"已有 1 条笔记"（当前 webui 不显示 note 全文，见"已知限制"）；
- note 全文用 CLI 验证：

  ```bash
  node packages/app/dist/bin.js note arxiv:2607.17040 --data-dir ./data
  ```

  应打印你刚确认的那段文字。

**是 bug 的迹象：**

- agent 没核对 id 就直接 ingest（或更糟：自己"推"了一个 id）；
- agent 没跑 `library build` 就宣布完成 / `note` 报 `error: unknown work ...`；
- agent 没问 note，或直接把自拟的 note 写进去没经你确认。

---

## 2. 查询工作流（argelander-query-paper-library）

**输入：**

```
我文献库里关于疏散星团潮汐尾的论文都有哪些？它们用了什么检测方法？
```

**应该发生：**

1. agent 跑 `search` 读**全量**索引行，然后自己判断相关性（不是关键词 grep）；
2. 给出 2–5 篇的 shortlist，每篇附一句"为什么相关"；
3. 逐篇调用 read-paper 技能深读（带针对性子问题）；
4. 综合答案：共识 / 分歧 / 互补 / 空白，每条结论带 **work id + 深链接**。

**注意**：当前库里大多数条目 note 是空的（只有第 1 步新摄入的有）。
agent 应该**主动指出这一点**（空 note 的条目在排序里几乎不可见），并提出按
title/tags 放宽匹配 + 建议回填 note。如果它提出回填，让它给 2–3 篇潮汐尾论文各拟一条
note 草稿、你确认后写入——这正好把 note 纪律也验收了。

**是 bug 的迹象：**

- 不给 shortlist 直接长篇回答，或 shortlist 没有理由；
- 综合答案里没有任何可点击追溯的链接 / work id；
- 多篇结论矛盾时被悄悄抹平成一种说法。

---

## 3. 阅读工作流（argelander-read-paper）

**输入：**

```
解释 arxiv-2501.17225 这篇的式 (2)
```

（也可以问"图 1 讲了什么"，探测浮动体路径。）

**应该发生：**

1. agent 用 `read --manifest refs` 或正文里的 `[ref: eq-2 | …]` 锚定位，再用
   `show arxiv-2501.17225 eq-2` 取**完整 LaTeX**（不是靠编号脑补）；
2. 解释每个变量时只引用论文里定义过的含义（该式把观测自行投影到 CP 方向，
   变量定义紧跟在公式后一段）；
3. 答案末尾给深链接：`http://localhost:8000/doc/arxiv-2501.17225#eq-2`；
4. **你点开链接**：webui 应打开该文并精确滚动到式 (2)（带高亮闪烁）。

**是 bug 的迹象：**

- agent 没调 `show`/manifest 就"复述"公式内容（变量张冠李戴通常由此而来）；
- 把引用文献的内容说成本文的结论；
- 链接点进去没有落到公式位置（落错位置/没反应 → 报 MS2 深链接 bug）。

---

## 4. 维护回路（note / label）

**输入：**

```
把刚加的 Palomar 5 那篇标成已读，打上 tidal-tails 和 gaia 标签，再加个星
```

**应该发生：**

agent 对第 1 步的 **work id** 跑：

```
label <work_id> --read true --tags tidal-tails,gaia --star true
```

**验证（浏览器 F5 刷新后）：**

- 侧栏该条目的未读标记消失；
- 详情面板出现 `tidal-tails`、`gaia` 两个标签；
- 侧栏该条目旁出现琥珀色圆点（当前 webui 的色点由 star 播种）。

**是 bug 的迹象：**

- agent 把 doc id（`arxiv-2607.17040`）当 work id 用，报 `unknown work` 后卡住；
- 不刷新看不到变化——**这不是 bug**，见下方限制第一条。

---

## 5. 失败探针

**5a. 假 arXiv id**

```
把 arxiv 9999.99999 加进库里
```

应该：agent 先验证（abs 页 404 / 搜不到），**明确告诉你这个 id 不存在并停下**。
是 bug：agent 不验证直接跑（ingest 也会以 `error: HTTP 404 for
https://arxiv.org/e-print/9999.99999` 失败，但应该先验证），或者编造"已成功"。

**5b. 被反爬墙的 DOI**

```
把 10.1051/0004-6361/202453302 加进库里
```

应该：agent（或实际 ingest）撞上 A&A 的 DataDome 墙——`error: HTTP 403 for
https://doi.org/...`——然后**如实报告失败**并主动给退路：找 arXiv 版（这篇恰好就是
arXiv 2501.17225，已在库）或请你手动下载 PDF 后给它本地路径。
是 bug：agent 原地重试 403，或假装摄入成功。

---

## 已知 Stage-2 限制（验收时别当 bug 报）

1. **无主动推送**：agent 经 CLI 写的 note/label/build 不会向 webui 推
   `library.changed`；webui 要**手动刷新（F5）**才能看到。`library.changed`
   只在 webui 自己发起的变更（上传 PDF、界面内 PATCH、refresh）时广播。
2. **webui "笔记" tab 是占位符**：只显示"已有 1 条笔记"，不显示全文。
   note 全文请用 `note <work_id>`（无 text 参数）或 `search` 的 JSON 行查看。
3. **`label --label <颜色>` 不渲染**：色标会持久化进 library.json 并出现在 API
   里，但当前 webui 列表的色点是本地状态（从 star 播种），不读这个字段。
4. **无 MCP**：pi 的原生方式即 CLI + skills，这是设计选择不是缺失。
5. **深链接端口**：`serve --port` 用非默认端口时，agent 环境里需设
   `ARGELANDERSPACE_PORT`，否则 CLI 打印的链接端口不对。
6. **出版商 HTML 全线被墙**（A&A/OUP/APS/IOP，DataDome/Cloudflare/Radware）：
   DOI 摄入大多 403，优先走 arXiv；退路是用户上传 PDF。
7. **PDF 摄入烧 MinerU 配额**（免费档约 1000 页/天）：agent 可自由触发 OCR，
   但批量 PDF 摄入前应先估算页数并跟你确认。
