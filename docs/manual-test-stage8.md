# Stage 8 手动验收指南（文档标注 annotations：文本/结构/文档三级标注 + 失效归档 + 文档删除 + CLI `annot`）

本指南验证 Stage 8 的全部用户可见变化：文本标注（§1）、结构标注八类（§2）、文档级标注（§3）、
右栏 `引用 | 标注` tabs（§4）、标注深链接（§5）、重摄入失效归档（§6）、CLI `annot`（§7）、
文档删除（§8）、外部编辑免刷新（§9），以及硬约束——agent 侧既有输出零变化（§0c）。
每一步给出：**要做什么**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行。
> Stage 8 无新环境依赖（工具链同 Stage 7：TeX Live 必需；pdftocairo/gs 可选）。
> Stage 3/3.1/4/5/6/7 的验收指南留档作回归参照。

文中标 **（已预实测）** 的条目，是写本手册前在本机真实 Chrome（Node 24 内建 WebSocket 经 CDP 驱动
/usr/bin/google-chrome）+ **库的临时副本**（`cp -a literatures /tmp/stage8-smoke/literatures`，server 与
CLI 均指 `--data-dir` 到副本，真实 `literatures/` 与 `status/` 全程零改动，已用 mtime 校验）上跑过的验证。
失效/删除两节用的是副本里的临时 upload 文档（hunt2021/hunt2023/bailerjones2021 条目 + 一个 10 行
LaTeX 夹具 zip），真实库不受影响。

---

## 0. 环境准备

**0a. 构建 + 起服务**

```bash
cd /home/wwu/project/bibgraph
corepack pnpm -r build
node packages/app/dist/bin.js serve --data-dir literatures --port 8000
# 浏览器开 http://localhost:8000
```

打开阅读器：直达 URL `http://localhost:8000/doc/<docId>`（如 `/doc/arxiv-2501.17225`），
或文献页点开条目 → 附件 tab → 点版本行；阅读器顶栏的文档名下拉可切换已入库文档。

**0b. 破坏性验收请用副本（§6 失效、§8 删除 强烈建议）**

```bash
cp -a literatures /tmp/lit-smoke8
node packages/app/dist/bin.js serve --data-dir /tmp/lit-smoke8 --port 8001
```

status 目录永远跟随 data-dir（`<data-dir>/../status`）——用副本时真实 `status/plans.json` 天然隔离。
CLI 同理加 `--data-dir /tmp/lit-smoke8`。

**0c. 硬约束总览（已预实测）**

agent 侧既有输出本阶段**逐字节不变**：`search/read/show/ref/note/label/list` 命令面与输出格式零改动
（golden `.md` 零重冻，管线测试锁死）。抽查：

```bash
node packages/app/dist/bin.js search --data-dir literatures | head -1
# 预期：单行 JSON，字段集合与 Stage 7 相同（id/title/authors/year/venue/arxiv_id/doi/
# cited_by_count/note/label/star/read/tags/doc_ids），无新增字段
node packages/app/dist/bin.js show arxiv-2501.17225 fig-1 --data-dir literatures
# 预期：仍只有 doc_id/id/kind/number/label/caption/image/link
```

新命令 `annot` 自诞生起进入冻结面：输出行字段序固定为
`id,doc_id,target,context,body,created_at,updated_at,link`（§7）。
CLI 打印的深链接端口链 = `ARGELANDERSPACE_PORT` > config.toml `port` > 8000——
若 serve 用了非默认端口且没用 env/config 宣告，CLI 打印的 link 端口会指 8000（既有端口链语义，非本阶段新增）。

**0d. 验收用文档**

- 主用 `arxiv-2501.17225`（段落/章节/公式/图/表/列表/引用 chip/行内公式全覆盖）；
- 代码块用 `arxiv-2012.05220`（全库仅它与 `arxiv-1804.10121` 有 code 块）；
- **algorithm 块现库没有**（已实测全库 8 篇）：算法结构标注管线支持但无可视面，§2 跳过该类。

---

## 1. 文本标注（选区 → 浮动工具条 → 高亮，已预实测）

打开 `/doc/arxiv-2501.17225`，滚到 3.1 CP method 一节。

**1a. 基本创建（已预实测）**

- 鼠标拖选正文一句话（如 "where μ̄_c denotes the mean proper motion…" 里的几个词），松手后
  选区下方浮现小工具条「🖊 添加标注」。
- 点它 → 右侧弹出创建浮窗（标题「添加文本标注」，编辑框占位提示「支持 Markdown 与 $…$ / $$…$$ 数学」）。
- 输入内容（可含 `**加粗**`、`$v_i$`），点「保存」（或 ⌘↵ / Ctrl↵）。
- 应该：浮窗切换为已保存视图（标题变「文本标注」）；正文选区被高亮涂色；该段**左缘**出现计数 marker `1`；
  右栏「标注」tab 徽标 +1。落盘 `literatures/annotations/arxiv-2501.17225/current.json`
  （target 含 `block`/`container`/`start`/`end`/`quote`——offset 是 canonical 文本的 UTF-16 坐标）。
- 工具条消失途径：选区折叠、滚动、Escape、点别处（设计行为）。
- bug：松手后工具条不出现；保存后无高亮；current.json 未落盘。

**1b. 原子扩展：从引用 chip / 行内公式内部起选（已预实测）**

- 第 1 节首段（Introduction）含引用 chip「Bok (1934)」。**从 chip 文字内部起选**、拖出到后面的普通文字，
  保存后查看 current.json：quote 以完整 chip 文本开头（如 `"Bok (1934) and"`）——选区自动扩展到整个
  chip，绝不保存 chip 内部 DOM offset。
- 行内公式同理：摘要里有 `$>$100`——从公式内部起选拖出，quote 含完整 `$>$`（canonical 规则：math → `$<latex>$`）。
- bug：quote 从 chip/公式中间截断；或选区起点落在 chip 内时工具条不出现。

**1c. 重叠标注（已预实测）**

- 在同一句话上再建一条与 1a 部分重叠的标注（文本标注允许任意重叠）。
- 应该：两条各自高亮，**重叠处颜色叠深**；该段左缘计数 marker 变 `2`。
- **点击重叠处** → 弹出小选择器，列出全部命中（目标摘要「文本标注」+ 章节路径 + quote + body 预览）；
  点选一条 → 打开其浮窗，且该条高亮提亮（active 优先级）。
- bug：重叠处只命中一条；选择器条目数不对。

**1d. gutter 计数 marker（已预实测）**

- 块左缘数字 marker：块上只有 1 条文本标注时点击 → **直接打开该条浮窗**；多于 1 条时点击 → 弹选择器（同 1c）。

**1e. 拒绝面（已预实测五种）**

- **跨段落选区**（从一段拖进另一段）→ toast「暂不支持跨段落标注」，无工具条。
- **图表 caption 的标签头**（"Figure 1." 这段 chrome）→ toast「此处不支持文本标注」，无工具条。
- **公式正文**（display 公式上拖选）、**章节标题**、**表格体**（tableBody 单元格）→ 同上 toast，
  无工具条。code/algorithm 正文同机制（同一容器判定路径）——这些位置只支持结构标注（§2）。
- 大范围标注需求走结构标注或文档级标注（设计决定，不是缺陷）。

**1f. 正向容器：caption 正文与列表项（已预实测）**

- 图 1 的 caption **正文**（"Figure 1." 标签之后的文字）可正常建文本标注
  （current.json 里 `container: {type:"caption"}`）。
- 列表（§6 Conclusions 的 bullet list）某项内文字可建（`container: {type:"list_item", index:N}`，index 从 0 起）。

---

## 2. 结构标注（hover 边钮，8 类，已预实测 7 类）

**2a. 入口与创建（已预实测）**

- 鼠标悬停任意块（段落/章节标题/公式/图/表/列表/代码）→ 块**右上缘**浮现小按钮（💬＋；实测 hover 时
  opacity 0→1）。点击 → 创建浮窗，标题分别为「添加标注 · 段落」「添加标注 · 章节 3.1」「添加标注 · 公式 1」
  「添加标注 · 图 1」「添加标注 · 表 A.1」「添加标注 · 列表」「添加标注 · 代码」（编号 = 印刷号）。
- 保存后：块**左缘**出现竖条 marker（accent 色），块左侧带 3px 描边（active 时更深），
  **块正文不涂色/不加底**（实测 background 保持透明——结构标注只用边缘标记，不整段涂黄）。
- 点左缘 marker → 打开该标注浮窗（查看/编辑/删除）。
- 落盘 target 含**创建时快照**（snapshot：段落=全文、章节=号+标题、公式=号+label+latex、
  图/表=号+label+caption+footnote(+表体/资产 hash)、列表=各项文本、代码=lang+body）——
  快照只记录"当时标了什么"，不用于自动重定位。
- 代码块去 `/doc/arxiv-2012.05220` 验（§5.4 Access 的 SQL 查询块，正文非附录）。
- bug：某类块 hover 不出按钮；保存后无 marker；块正文被染色。

**2b. 算法块**

- 现库 8 篇文档无 algorithm 块（已实测），无可视面；管线与 UI 对该类的支持有测试覆盖。

---

## 3. 文档级标注（已预实测）

- 右栏切到「标注」tab → 顶部「＋ 添加文档标注」按钮 → 面板内联编辑器 → 保存。
- 应该：列表**最上方**出现「整篇文档」条目（文档级恒置顶）；徽标 +1。文档级标注无挂靠块，
  正文里无 marker/高亮。
- 点击「整篇文档」条目只激活列表条目（无跳转目标）；查看/编辑用条目右侧铅笔按钮（设计行为，见 §4 注）。

---

## 4. 右栏「引用 | 标注」tabs（已预实测）

**4a. 默认与徽标**：打开阅读器默认仍在「引用」tab；「标注」tab 带总数徽标（文档级+结构+文本合计）。
创建标注后**不自动切 tab**（反馈 = marker/高亮 + 徽标即时更新）。

**4b. 列表序**：整篇文档置顶，其余按文档阅读序（实测：与 CLI `annot` 的行序逐条一致——
两端同一排序规则，500 轮 fuzz 对拍过）。条目 = 目标摘要（类别+印刷号 / 章节路径 / 文本 quote）+ body 预览。

**4c. 点击条目**（已预实测）：跳转目标块 + 闪光 + 该标注进入 active（描边/高亮提级）。
**注意：点击条目不自动打开浮窗**（定稿设计）——查看全文 = 点块左缘 marker / 点正文高亮 / 深链接（§5）；
编辑 = 条目铅笔或浮窗内「编辑」。

**4d. 编辑双路 + 渲染 + 校验（已预实测）**

- 浮窗内「编辑」与列表条目铅笔都能改 body；删除两路都有（单条删除不二次确认，与全局 UX 一致）。
- body 查看态渲染 Markdown + 数学：`$…$` 行内（实测渲染出 KaTeX）、`$$…$$` 展示公式（katex-display）、
  `**粗体**` 等。
- 校验：body 清空或全空白时「保存」禁用（trim 非空校验；合法内容按**原始字节**保存，不 trim）。
- `updated_at` 语义（已预实测）：只有 body 字节真变才 bump；打开/关闭浮窗、跳转、排序都不动
  （创建时 `created_at == updated_at`）；body 未改动的保存直接不发请求。

---

## 5. 标注深链接 `#ann-<id>`（已预实测）

- 链接格式 `/doc/<docId>#ann-<id>`（如 `/doc/arxiv-2501.17225#ann-a_1b2c3d4e`）。
  获取途径：CLI `annot` 输出的 `link` 字段（§7），或按格式手拼。
- 新浏览器标签/新窗口打开该链接（已预实测）：文档打开后**跳到目标块 + 闪光 + 激活该标注 +
  自动打开其浮窗**（文档级标注无块可跳，只激活+开浮窗）。
- 未知/已删/已归档 id（如 `#ann-a_00000000`，已预实测）：**静默**——文档正常打开、不跳转、无 toast、
  不搜 archive（沿用 unknown-anchor 哲学）。

---

## 6. 失效归档（重摄入，已预实测；务必用副本 §0b）

语义：标注只绑定**创建时的文档内容**（current.json 里 `content_fingerprint`）。同内容重摄入 → 标注保留；
内容变化重摄入 → 该 doc 全部 current 标注**一次性整批归档**（不做逐条 salvage），阅读器从空 current 开始。
归档权威只在 server 访问路径（GET/PUT annotations 时幂等检查）；CLI `annot` 只读、不归档（§7）。

用一个 upload 文档演示（upload docId = `upload-<slug>-<workId哈希6>`，**只随 work 变**，重传同条目即原位覆盖）：

**6a. 夹具与上传**

```bash
mkdir -p /tmp/smoke8-fix && cd /tmp/smoke8-fix && cat > main.tex <<'EOF'
\documentclass{article}
\usepackage{amsmath}
\title{Stage Eight Smoke Fixture}
\author{Smoke T. Est}
\begin{document}
\maketitle
\section{Alpha}
First paragraph of the alpha section with an inline formula $a^2+b^2=c^2$ to select.

Second paragraph of the alpha section, short and plain.
\section{Beta}
Third paragraph in the beta section with a display equation below.
\begin{equation}
E = m c^2
\end{equation}
\end{document}
EOF
zip -q ../smoke8-v1.zip main.tex && cd -
```

副本库 webui：文献 → 打开无正文条目（如 "Improving the open cluster census - I." Hunt 2021）→
附件 tab → 「上传 LaTeX 源码包（zip）」选 `smoke8-v1.zip` → 等"Rebuilding library"完成
（小夹具约 10 秒内）。点版本行打开该 upload 文档的阅读器。

**6b. 建标注 + 同内容重传 → 存活（已预实测）**

- 在夹具文档上建两条标注（一条段落结构标注 + 一段文字选区标注）。
- 附件 tab「重新上传」**同一个 zip** → 等完成 → 刷新/重开阅读器。
- 应该：标注原样保留（指纹不变）。`annotations/<doc>/` 下无 archive 目录。
- 同语义也适用于 arXiv 文档：副本里 `ingest 2501.17225 --data-dir <副本>` 走 tarball 缓存
  （`output/.latexcache`，零网络）同字节重摄入，标注同样保留（已预实测）。

**6c. 改内容重传 → 整批失效归档（已预实测）**

```bash
cd /tmp/smoke8-fix && sed -i 's/First paragraph/First CHANGED paragraph/' main.tex && zip -q ../smoke8-v2.zip main.tex && cd -
```

附件 tab 重新上传 v2 → 等完成。然后**顺序验证三条**：

1. **CLI 先验**（在任何阅读器访问前）：
   `node packages/app/dist/bin.js annot <upload-doc-id> --data-dir /tmp/lit-smoke8`
   → stdout 空、exit 0、stderr 一行固定 note：
   `note: document content changed since its annotations were written; they are archived and not shown`
   ——且此时 archive 目录**仍不存在**（CLI 不归档）。
2. **打开该文档的阅读器**（server GET 触发归档）：标注 tab 回到空态
   （「暂无标注。悬停正文中的段落 / 公式 / 图表等块…」）；磁盘出现
   `annotations/<doc>/archive/<UTC 时间戳 3 位毫秒>-<旧指纹8>.json`
   （如 `20260910T174910060Z-4a64c362.json`），内容 = 旧 current 原样（旧标注逐条在、旧指纹在）。
3. **打开中的编辑器**（重摄入完成时阅读器本就开着该文档）：屏幕上的旧 IR 与旧标注**不会自动消失**
   （阅读器不重取 IR，既有缺口——手动刷新页面）；此刻任何保存动作（如编辑某条后点保存）触发 409：
   toast「文档内容已变化，旧标注已归档」+ 标注面板重取为空；若被归档的标注**正在编辑中**，
   浮窗转归档态：banner「此标注已随旧文档内容归档，无法再保存修改；可复制内容后关闭。」、保存禁用、
   草稿原样保留可复制。若epoch 翻转时正挂着**文本创建**浮窗：浮窗直接关闭 +
   toast「文档内容已变化，旧标注已归档；请重新选择文本」（此分支为代码路径核对，未单独实测）。

---

## 7. CLI `annot`（只读，已预实测）

```bash
node packages/app/dist/bin.js annot arxiv-2501.17225 --data-dir /tmp/lit-smoke8
```

**7a. 匹配（已预实测）**：stdout 每行一条 current 标注，阅读序（文档级在前），字段序固定
`id,doc_id,target,context,body,created_at,updated_at,link`。示例行（结构-章节标注）：

```json
{"id":"a_…","doc_id":"arxiv-2501.17225","target":{"type":"structure","id":"sec-7","kind":"section","snapshot":{"number":"3.1","heading":"CP method"}},"context":{"section_id":"sec-7","section_path":["3 Methods","3.1 CP method"]},"body":"…","created_at":"…","updated_at":"…","link":"http://localhost:8000/doc/arxiv-2501.17225#ann-a_…"}
```

context 分级：document → 仅 title；section/float → section_id+section_path；text/paragraph/list →
另带完整 canonical `container_text`。零写盘：跑完 `annotations/` 目录不变（`git status`/mtime 可查）。

**7b. mismatch（已预实测）**：见 §6c-1——空 stdout + 固定 stderr note + exit 0 + 不归档。

**7c. 未知文档（已预实测）**：`annot bogus-doc` →
`error: unknown doc "bogus-doc" — available: arxiv-1609.05917, …` + exit 1（既有候选列表模式）。

**7d. 零标注文档（已预实测）**：`annot latex-battery` → stdout 空（零行）、无 note、exit 0
（指纹都不算——没有可被旧指纹藏住的标注）。

**冻结说明**：`annot` 的行字段序/排序/link 格式自本阶段起进入 agent 输出冻结面，后续改动即破坏契约。

---

## 8. 文档删除（已预实测；务必用副本）

入口只在 webui（CLI 无删除命令）：文献 → 条目详情 → 附件 tab → 版本行右侧垃圾桶按钮
（主文档行也有；注意主文档行标签恒为**引用键**而非 doc id——Stage 7 既有显示约定）。

**8a. 确认框（已预实测）**：「该文档及其 N 条标注将永久删除，此文档将从所有关联文献条目中移除。」
（N = 打开确认框时实时取的标注数；取数失败降级为「标注（数量未知）」，不阻断删除。）
按钮「永久删除」。

**8b. 摄入中 busy → 409（已预实测）**：对该条目重新上传一个**大** zip（真实论文源码包，编译窗口长），
摄入进行中点删除 → 确认框不关、显示「文档正在摄入，请稍后删除」；裸 API 同语义：
`curl -X DELETE /api/paper/<doc>` → 409 `{"detail":"document busy"}`。等 job 结束后重试即可删。
（反向互斥同样存在：删除执行中同 doc 的上传会被 409 拒绝。）

**8c. 三态工作区迁移（已预实测三态全过）**：

- 删**非当前**文档：阅读器当前文档不变；版本列表少一行。
- 删**当前**文档且该 work 还有剩：阅读器自动切到删除后的新主文档（剩余 doc_ids[0]），URL 随之换。
- 删**当前**文档且无剩：阅读器回到空态「没有可显示的文档。处理一篇论文，或从 文献 中打开。」。

**8d. 全局物理删除（已预实测）**：`output/<doc>/` 与 `annotations/<doc>/`（current+archive）同步删除；
该 doc 从**所有**关联 work 的 `doc_ids` 摘除（一个 doc 可经身份合并出现在多个 work——删除后任何 work 的
版本列表都不再出现它）；立即广播 `library.changed`，文献页/图谱同步。不触发 rebuild/enrich。

---

## 9. 外部编辑 current.json（已预实测）

server 运行中用编辑器/jq/python 直接改 `annotations/<doc>/current.json`（如追加一条 annotation），
**不用 F5**：server watcher（1.5s 轮询指纹）发现变化 → 广播 `annotation.changed`（external）→
打开中的阅读器自动重取，标注列表/徽标即时更新（实测 11 → 12 条）。
注意 schema 约束：id 须 `a_<8 位小写 hex>`、target 三型合法、body 非空——写坏 schema 不会静默重置，
下次访问报 500（面板显示「标注载入失败（服务器错误）。重试」）。

---

## 10. 已知行为与边界（勿当新 bug 报）

- **列表条目点击不开浮窗**（§4c）：定稿设计 = jump + flash + 激活；查看走 marker/高亮/深链接。
- **文本标注不能建在**公式/code/algorithm 正文、表格体（tableBody）、章节标题上（拒绝 toast）——
  大范围需求用结构标注；caption 的 "Figure N." 标签头是 chrome，不可选（caption 正文可以）。
- **重摄入后打开中的阅读器不重取 IR**（既有缺口，Stage 8 前就有）：屏幕仍是旧 IR + 旧标注，
  失效要等下次访问/刷新；snapshot 重建因此目前只是形式正确。**手动刷新页面即可**。
- **DELETE 中途 rm 失败的部分删除**会留 ghost library 条目到下次 `library build`（极端边缘；重建即愈）。
- **orphan annotations**：绕过删除入口手动 `rm -rf output/<doc>/` 时其 `annotations/<doc>/` 成为孤儿——
  不自动清理、Stage 8 **不提供访问保证**（保留为潜在恢复/未来迁移的原始数据）；archive 同样不对
  reader/agent 开放（无 `annot --archive`，未来需要时另立 sanctioned surface）。
- **跨进程并发 mutate 同一 doc 不支持**（CLI 与 server 同时写同一 doc = 操作边界，无跨进程锁）。
- GET ensure 在锁外的极端并发下可能双归档：archive 文件名极端碰撞加 `-N` 后缀兜底，**绝不覆盖**已有
  archive，无数据丢失。
- 选区落到块尾部边缘区域（`.ann-edge` 覆盖带）时，文本标注的选区会延展到 canonical 文本末（设计内行为）。
- 归档 banner 文案在"文档被外部删除"场景措辞欠准（说的是归档——cosmetic，留账）。
- 浮动工具条/选择器在视口边缘双轴钳制（8px 边距）；happy-dom 测试环境下 y 钳制断言恒过（pin 无牙），
  真实浏览器已实证。
- 结构标注的图/表快照里 `asset_hash` 为尽力而为字段（取不到资产时省略）；figure 的 MinerU 时代
  `chartType/content` 字段不进指纹投影（OCR 遗存，非正文内容）。

---

## 11. 回归面（本阶段未触碰，扫一眼即可）

- 阅读器既有面：宽度自适应 / per-ref chip 折行 / 右栏跳转定位 / 作者块（Stage 6/7 一致）；
  四级旧深链接（`#sec-N`/`#fig-N`/`#eq-N`/`#ref-N`）不受影响。
- 文献看板 / 计划页 / 上传与重建流程与 Stage 7 一致（上传按钮三态文案、设为主、rebuild 保序）。
- agent 侧：§0c 抽查 + golden `.md` 零重冻（四门测试锁死）。
