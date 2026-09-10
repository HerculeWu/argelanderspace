# Stage 7 手动验收指南（known-issues 清账：作者块修复 / re-upload 推广 / CLI 建条目 / TaskModal 软警告 / TOC 预览净化 / cite_key 稳定）

本指南验证 Stage 7 的全部用户可见变化：作者块四项修复（§1）、re-upload 推广到所有条目（§2）、
CLI DOI 建条目（§3）、TaskModal 超期软警告（§4）、TOC 预览净化（§5）、cite_key 只增不改（§6），
以及硬约束——agent 侧输出零变化（§0c）。
每一步给出：**要做什么**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行。
> Stage 7 无新环境依赖（工具链同 Stage 5/6：TeX Live 必需；pdftocairo/gs 可选）。
> Stage 3/3.1/4/5/6 的验收指南留档作回归参照。

文中标 **（已预实测）** 的条目，是写本手册前在本机真实 Chrome（agent-browser 经 CDP 驱动
/usr/bin/google-chrome）+ **库的临时副本**（`cp -a literatures /tmp/stage7-smoke/data`，server 与
CLI 均指 `--data-dir` 到副本，真实 `literatures/` 与 `status/` 全程零改动）上跑过的验证。
§1–§4、§6 关键预期全部实测通过；§5 预实测发现 xref 半截记号残留（4 篇 34 条），**已修**
（渲染层丢弃未闭合记号），§5b 为修复后的预期。

---

## 0. 环境准备

**0a. 构建 + 起服务**

```bash
cd /home/wwu/project/bibgraph
corepack pnpm -r build
node packages/app/dist/bin.js serve --data-dir literatures --port 8000
# 浏览器开 http://localhost:8000
```

**0b. 迁移与备份说明（MS2b 已于 2026-09-10 实跑）**

Stage 7 MS2b 已对 4 篇作者块受害者做离线重摄入（全程零网络，走 tarball 缓存）：
`arxiv-1609.05917` / `arxiv-1804.10121` / `arxiv-2603.03522` / `arxiv-2607.17040`。
`library build --offline` parity 校验：works 41=41、41 篇的 note/label/star/read/tags 逐字节零漂移、
library.bib 逐字节相同、零悬空 doc_ids。5 篇 src-only 旧档（0902.1039 / 1307.2657 / 1307.8124 /
2603.00229 / astro-ph-9707253）因缺 arXiv 自带类文件（aa.cls / emulateapj-rtx4.cls / aas_macros.sty）
全部失败于 latexmk 编译步，未入库——属环境缺口非管线 bug，已挂 known-issue（见 §8）。
备份 `literatures.stage7-backup.tar.gz`（215 MB）在 repo 根，**验收通过后用户可自行删除**；
回滚 = `tar xzf literatures.stage7-backup.tar.gz`。

**0c. 硬约束总览（已预实测）**

agent 侧输出本阶段**逐字节不变**：golden `.md`（`tests/golden/tex/*.md`）零重冻（管线测试锁死）；
CLI `search` 的 JSONL 行字段与 Stage 6 相同（`id/title/authors/year/venue/arxiv_id/doi/doc_ids/
cited_by_count/note/label/star/read/tags`——`doc_ids` 字段 Stage 2 起就有，非本阶段新增）；
re-upload 的 `doc_ids` 透传只加在 **HTTP payload**（webui 用），CLI agent 面直读磁盘 LibraryStore
不经过它。抽查：

```bash
node packages/app/dist/bin.js search --data-dir literatures | head -1
# 预期：单行 JSON，字段集合如上，无新增 IR/payload 字段
node packages/app/dist/bin.js show arxiv-2501.17225 fig-1 --data-dir literatures
# 预期：仍只有 doc_id/id/kind/number/label/caption/image/link
```

**0d. 破坏性验收请用副本（§2/§3/§4 强烈建议）**

```bash
cp -a literatures /tmp/lit-smoke
node packages/app/dist/bin.js serve --data-dir /tmp/lit-smoke --port 8001
```

status 目录永远跟随 data-dir（`<data-dir>/../status`）——用副本时计划页验收（§4）创建的
计划/任务落在 `/tmp/status`，真实 `status/plans.json` 天然隔离。CLI 同理加 `--data-dir /tmp/lit-smoke`。
在真库上验收也可以：§2 的 upload doc 保留无妨（正是新功能演示），"设为主"切回即可。

---

## 1. 作者块修复（MS2，已预实测）

打开各文档（文档页直达 `/doc/<docId>`），点正文列顶部的折叠作者行展开核对。

**1a. revtex 分组语义：`arxiv-1609.05917`**

- 应该：Stacy S. McGaugh¹, Federico Lelli¹, James M. Schombert²；机构列表两条——
  [1] Department of Astronomy, Case Western Reserve University…（CWRU）、
  [2] Department of Physics, University of Oregon…。即 McGaugh/Lelli 挂第 1 机构、Schombert 第 2 机构。
- 修复前：McGaugh 无机构（revtex 分组在每条 `\author` 后被错误重置）。
- bug：McGaugh 上标缺失；机构条数不是 2。

**1b. 前置 `\email` + `\correspondingauthor`：`arxiv-1804.10121`**

- 应该：5 位作者、2 条机构（MPIA / ARI）之外，作者块底部出现 **✉ calj@mpia.de**（文档级通讯邮箱）。
- 修复前：`\author` 前的 `\email` 被静默丢弃。
- bug：底部无 ✉ 行；或邮箱粘进了人名/机构文本。

**1c. 平铺降级恢复结构化：`arxiv-2603.03522`**

- 应该：Mark D. Huisjes¹（✉ m.huisjes@degoudsewaarden.nl）、X. Hernandez²，**两条机构**
  （CSG De Goudse Waarden Lyceum… / Universidad Nacional Autónoma de México…）。
- 修复前：平铺降级——两位作者均无机构（机构粘在 `\author` 的 `\\` 之后被丢弃）。
- bug：仍然无机构列表。

**1d. `\email[show]` 签名：`arxiv-2607.17040`**

- 应该：Zhenghao He¹（✉ hezhh59@mail2.sysu.edu.cn）、**Long Wang¹´²（✉ wanglong8@sysu.edu.cn）**、
  Zi-yi Zhou¹（✉ …）、**Yang Huang³´⁴**（✉ huangyang@ucas.ac.cn）、Eugene Vasiliev⁵（✉ …），5 条机构。
- 修复前：Long Wang 的邮箱被 `\email[show]` 抓错可选参吞掉（残渣还曾漏进正文形成一个垃圾段落，
  该段落本次重摄入后消失，正文纯文本逐 token 对账一致）。
- bug：Long Wang 无 ✉；上标不是 1,2 / 3,4。

---

## 2. re-upload 推广（MS3，已预实测；建议按 §0d 用副本验收）

**2a. 上传按钮全量开放（已预实测两种条目）**

- 无正文条目（如 "On the variation of the initial mass function" Kroupa 2001）：文献页点开 →
  附件 tab → 有「全文来源」来源 pill + **「上传 LaTeX 源码包（zip）」** 按钮。
- 有 arXiv 正文条目（如 "Tidal tails…" Risbud 2025 = `arxiv-2501.17225`）：附件 tab 显示
  **「上传新版本 LaTeX 源码包（zip）」**，下方小字"新版本上传后自动设为主文档；旧版本保留在上方列表可回看"。
- bug：任何一类条目没有上传按钮（Stage 3.1 时代"先 zip 后 arXiv 摄入按钮消失"的盲区）。

**2b. 上传 → 版本列表两条、upload 自动为主（已预实测）**

制作 zip（取任一篇已摄入文档的 src/ 目录；越小编译越快）：

```bash
cd literatures/output/arxiv-2501.17225/src && zip -qr /tmp/smoke-upload.zip . && cd -
```

在副本库上给 Risbud 2025 上传该 zip。上传中按钮变为进度文案（"排队等待摄入…"/摄入进度），
随后出现 "Rebuilding library" 指示（小夹具全程约 1 分钟；真实论文 zip 随 latexmk 编译时长更久）。

- 应该：完成后版本列表出现**两条**——首行 = 引用键（`risbud2025`）+「主文档」徽标，
  次行 = `arxiv-2501.17225` +「设为主」按钮；磁盘上该 work 的
  `doc_ids = ["upload-doi-…-202453302-<hash6>", "arxiv-2501.17225"]`（upload 在前 = 主）。
- 注意：版本列表首行标签**恒为引用键**（cite_key）而非 doc id——这是显示约定，不是 bug；
  旧版本行才显示原始 doc id。
- bug：上传后仍只有一条；或主/从顺序颠倒（arxiv 仍在首位）。

**2c. 阅读器打开的是主版本（已预实测双向）**

- 点首行（主文档）→ 阅读器打开的是 **upload 版**内容（URL = `/doc/upload-doi-…`）。
- 点次行「设为主」→ 列表换序（`arxiv-2501.17225` 回主位，`doc_ids` 首位换回 arXiv）；
  再点首行 → 打开的是 **arXiv 版**正文。
- bug：切换主文档后打开的内容不变。

**2d. 已有 upload doc 的条目（已预实测）**

上传完成后附件 tab 按钮变为「**重新上传** LaTeX 源码包（zip）」，小字"重新上传会覆盖同一文档
（传错文件或有更新版时使用）"——幂等设计，可反复传同一 zip（docId 含内容 hash，不增生新文档）。

**2e. 验收后恢复**

副本验收零恢复成本（删掉副本即可）。真库验收后：附件 tab 点「设为主」把 arXiv 版切回主位；
upload doc 保留无妨（新功能演示），下次 rebuild 主位选择持久（doc_ids 保序，§6 顺带验证）。

---

## 3. CLI 建条目（MS4，已预实测；用临时 data-dir）

```bash
node packages/app/dist/bin.js ingest 10.1051/0004-6361/202039341 --data-dir /tmp/cli-smoke
```

**3a. DOI 建条目（已预实测，exit 0）**

```
created library entry doi:10.1051/0004-6361/202039341 (no full text yet)
  title: Improving the open cluster census
  next: upload a LaTeX source zip on this work's detail page in the web UI to attach the full text
```

- 应该：exit 0；`<data-dir>/library/library.json` 里新 work——Crossref 即时富化
  （authors=["Hunt","Reffert"]、year=2021、venue="A&A"、cite_key=`hunt2021`、origin=`manual`、
  doc_ids 空）；webui 里出现该条目，附件 tab 可上传 zip 挂正文（与 §2 同一通路）。
- Crossref 失败/无记录时降级为裸条目仍 exit 0（ stderr 有说明）。

**3b. 重复执行（已预实测，exit 0 零写盘）**

```
library entry already exists for this DOI: doi:10.1051/0004-6361/202039341
  next: upload a LaTeX source zip on this work's detail page in the web UI to attach the full text
```

**3c. 裸字符串维持报错（已预实测，exit 1）**

```
error: unrecognized source '随便一段裸字符串': expected an arXiv id/URL, a local .tex/dir/tarball,
or a DOI (PDF ingestion is in development — ...)
```

- 验收后清理：临时 data-dir 直接删除；若在真库测过，从 `library.json` 删掉该 work 后
  `library build --offline` 重建即可。

---

## 4. TaskModal 超期软警告（MS1，已预实测；用副本时 status 天然隔离，见 §0d）

**4a. 新建任务（已预实测）**

计划页新建计划（截止 2026-09-20）→「新建任务」：截止日期预填计划截止；改成晚于它的日期
（如 2026-09-25）。

- 应该：截止日期下方出现小字提示「**任务截止晚于计划截止（2026-09-20）**」；
  「添加任务」**不被阻断**——任务正常保存落盘（plans.json 里 task.due = 2026-09-25 > plan.due）。
- bug：保存被拒/报错；或毫无提示。

**4b. 编辑任务（已预实测）**

打开该任务的「编辑任务」弹窗：同款提示同样显示（同一 TaskModal 组件）。
任务截止 ≤ 计划截止时提示不出现。

---

## 5. TOC 预览净化（MS1 + smoke 修复，已预实测）

**5a. cite 记号已净化（已预实测 ✓）**

打开 `arxiv-2607.17040`，左栏目录展开 TABLES：

- 应该：Table 11 的预览显示 "Main parameters of the **Hunter et al. 2024**-based basis potent…"——
  caption 内的引用显示为可读短文本，不再是 `[cite:…]` 展开记号。
- bug：出现 `[cite: ref-36 | …]` 字样的原始记号。

**5b. xref 记号净化（渲染层兼容截断记号——smoke 预实测发现后已修）**

打开 `arxiv-2501.17225`，左栏 FIGURES 下滚到附录图：

- 应该：Figure A.2–A.19 的预览显示 "Same as the Figure"——`[ref:…]` 记号不再泄漏。
  背景：IR 的 float 预览短文本在摄入期截断（约 60 字符），xref 记号内嵌完整目标预览、
  跨度超限被从中间截断；stripMath 初版只匹配完整闭合记号，半段记号原样透出（本手册
  预实测发现 4 篇共 34 条残留：2501.17225 / 2012.05220 / 1610.08981 / 2603.03522）。
  修复 = 渲染层丢弃未闭合的 `[cite:`/`[ref:` 尾巴（web 层零冻结风险；摄入期先净化再截断
  会改 agent 可见的 manifest 字节，不可行）。
- bug：预览里出现 `[ref:…` 或 `[cite:…` 字样的半截记号。

---

## 6. cite_key 只增不改（MS1，已预实测；在副本上跑）

```bash
cp /tmp/lit-smoke/library/library.bib /tmp/bib-before.txt
node packages/app/dist/bin.js library build --offline --data-dir /tmp/lit-smoke
diff /tmp/bib-before.txt /tmp/lit-smoke/library/library.bib
```

- 应该（已预实测）：`library.bib` **逐字节一致**；works 41→41；全部 cite_key 零漂移；
  note/label/star/read/tags 零漂移；各 work 的 `doc_ids` 顺序不变（§2 上传/切主的
  主版本位在 rebuild 后保持——seed 归并保序）。
- `--offline` 现在同时 gate ADS（MS2b 顺手修：此前只 gate Crossref/OpenAlex，构建期会发生
  实时 ADS 调用）——离线重建应零网络写盘。
- bug：rebuild 后任何既有 work 的 cite_key 改变（Stage 7 前的行为是无条件重排覆盖）。

---

## 7. 本阶段不可视项（一句话带过，无 smoke 面）

- **jpg/gif/webp 直通图尺寸预留（MS1 H）**：现库无此类图，无可视面；管线测试覆盖
  （含 JPEG SOF 填充字节 off-by-one 探针）。
- **UA 改名（MS1 J）**：Crossref/OpenAlex 请求 UA `HubbleSpace/0.1` → `ArgelanderSpace/0.1`，
  仅线上请求指纹变化，无可视面。

---

## 8. 已知边界与本阶段发现的问题（勿当新 bug 报）

- ~~**§5b TOC xref 记号残留**~~（本阶段 smoke 预实测新发现，**已修**）：`[ref:…]` 等内嵌长预览的记号被
  摄入期截断后逃逸渲染层净化，曾影响 4 篇共 34 条 float 预览；修复 = stripMath 丢弃未闭合
  `[cite:`/`[ref:` 尾巴（渲染层方案——摄入期先净化再截断会改 agent 可见 manifest 字节，违反冻结）。
- **MS3 挂账 known-issue**：①从零 rebuild（library.json 丢失后字母序播种）丢主位选择——
  "upload 是主"无持久标记；②stale doc（已不在任何 work 的 doc_ids）在下次 rebuild 前会在
  文档页全量曝光；③bridging 塌缩方向决定主位存亡。
- **5 篇 src-only 旧档未入库**（§0b）：缺 arXiv 自带 TeX 类/宏文件；1307.8124 探针实证一旦能
  编译即 18 作者作者块全恢复。修复路径（拷类文件进 src/ 或 TEXINPUTS shim）待拍板。
- `literatures/output/` 里两个 Stage 3.1 时代孤儿目录 `upload-doi-10-1051-0004-6361-201117315*`
  不属任何 work 的 doc_ids（历史残留，非本阶段产物）。
- TOC 的 Equation 预览显示 raw LaTeX（`\rho_{\text{halo}}…`）为既有行为，非本阶段范围。
- 作者块既有边界（Stage 6 手册 §6 已列）继续有效：单机构内 `\\`、前置 `\inst`、orphan
  `\affiliation`、尾标点去重等挂 known-issue 不修。

---

## 9. 回归面（本阶段未触碰，扫一眼即可）

- 阅读器：宽度自适应 / 多引用 chip 折行 / 右栏跳转定位 与 Stage 6 一致。
- 计划页：除 §4 软警告外与 Stage 4 一致；文献看板与 Stage 3 一致。
- agent 侧：§0c 抽查 + golden `.md` 零重冻（四门测试锁死）。
