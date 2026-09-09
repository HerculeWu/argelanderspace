# Stage 7 MS2b 存量重摄入迁移记录（2026-09-10 执行，自给自足）

> 前置：`2026-09-09-stage7-roadmap.md`（Q7/Q9/Q10）、`2026-09-09-stage6-roadmap.md` MS3（同型流程先例）。代码起点 = `437299e`（MS2 作者块六项修复）。

## 流程与产物

1. **备份**：`literatures.stage7-backup.tar.gz`（215MB，项目根，`.gitignore` 第 42 行规则覆盖，git 不可见）；迁移前 `library.json`/`library.bib` 副本在 `/tmp/library.stage7-pre.{json,bib}`（临时，重启即失——长期回滚只能靠 tarball）。
2. **重摄入方式**：`node packages/cli/dist/bin.js ingest <arxiv-id>`（默认 data-dir `./literatures`）。docId 由 arXiv id 派生（`docIdFor`），与既有目录名一致故 **docId 不变**；arXiv eprint 走 `literatures/output/.latexcache/` 的 tarball 缓存（9 篇全命中），`acquireSource` 见 src/ 已有 .tex 不重复解包——**全程零网络**（摄入侧）。
3. `library build --offline` 后 parity 校验。

## 4 篇受害者：全部成功，作者块验收逐项通过

| docId | 验收点 | 结果 |
|---|---|---|
| arxiv-1609.05917 | McGaugh/Lelli → [1] CWRU、Schombert → [2] Oregon | ✓（IR diff 仅 +1 leaf：McGaugh 的 affiliations[0]=1） |
| arxiv-1804.10121 | calj@mpia.de → meta.email | ✓（IR diff 仅 +1 leaf：meta.email） |
| arxiv-2603.03522 | 两机构恢复、Huisjes [1]/Hernandez [2] | ✓（IR diff 仅 +4 leaf，全部 meta；平铺降级→结构化） |
| arxiv-2607.17040 | Long Wang [1,2]+wanglong8@sysu.edu.cn、Yang Huang [3,4] | ✓（meta 仅 authorDetails 变；正文 diff 大但已归因，见下） |

**2607.17040 正文大 diff 的归因（重要，非回归）**：旧 IR 有一个垃圾 front-matter section（sec-19，段落文本 = `show]wanglong8@sysu.edu.cn`）——正是新发现 2（`\email[show]` 签名 `"m"` 抓错可选参）把残渣漏进正文。MS2 签名改 `"o m"` 后该垃圾段落消失：section 8→7、block 23→22、block id 重新编号级联导致 citationsByBlock 大量 id 位移。**逐 token 纯文本对账：去掉垃圾段落后新旧正文完全一致**；refs 88=88。

## 5 篇 src-only best-effort：全部失败于编译步（零入库，不阻塞）

失败原因逐篇（均 latexmk 编译阶段，管线本身无 bug；探针 = /tmp 副本试编译，未动 literatures/）：

1. **0902.1039**：src 自带 2009 时代 aa.cls 与现代 TeX Live natbib 冲突（`\bibfont already defined`，\begin{document} 即炸）。探针：换 2501.17225 的新版 aa.cls 后越过了该错，但又撞 `Option clash for package graphicx`——需动源码，超出 best-effort。
2. **1307.2657**：`emulateapj-rtx4.cls` 缺失——TeX Live 只有 emulateapj.cls，arXiv tarball 未自带。
3. **1307.8124**：`aa.cls` 缺失（未自带、TeX Live 无）。探针：放新版 aa.cls 可出 PDF 但 1 错（`longtable not in 1-column mode`——新 aa.cls 默认双栏；源码第 12 行有注释掉的 `onecolumn` 选项）。**作者块探针实证（core dist `buildTexDocIr` 直跑源码，绕过编译）：18 作者、Schlafly 第 8/Morgan 第 15 在列、8 机构全恢复**——一旦编译可过即是新发现 4 的受益者。
4. **2603.00229**：inline thebibliography 里 `\na` 未定义——aas_macros.sty 期刊宏缺失（作者自己的定义在第 14 行被注释掉）。
5. **astro-ph/9707253**：plain TeX（`\ref W`/`\endref`/`\bye`），预期失败。

共同模式：老 arXiv 提交依赖 arXiv 自带 TeX 树的类/宏文件（aa.cls、emulateapj-rtx4、aas_macros），本地 TeX Live 没有。**修复路径（需主 agent/用户拍板，本次未做）**：把缺失类文件拷入各自 src/（可行但引入版本错位 + 有的还需改源码选项），或 infra 层提供类 shim 目录进 TEXINPUTS。挂 known-issue 候选。

## Parity 报告（library build --offline 后）

- **works 数：41 = 41，零新增零丢失**（src-only 全败故无 doc 入 work）；带 doc works 9 = 9。
- **用户字段 note/label/star/read/tags 全 41 works 逐字节零漂移**；library.bib 逐字节相同；顶层 version/project 不变。
- **零悬空 doc_ids**：被引用 8 个 doc_id 全部有对应 IR .json；迁移前即无 404 残留（src-only 5 篇从未进过 doc_ids，无需清理）。
- **2 个 work 的富化字段有差异，已归因为环境而非迁移**：`--offline` **只 gate Crossref/OpenAlex，不 gate ADS**（`packages/server/src/deps.ts:36` AdsClient 无 `enabled: !offline`）——本机有 ADS token，构建期间发生了实时 ADS 调用（ads cache 新增 3 个条目，mtime 为证）：① Astropy 2022（doi:10.3847/1538-4357/ac7c74）获得 abstract/bibcode/journal/acquisition 计划、cited_by_count 4960→5700（新数据）；② 1977 扫描件（doi:10.1111/j.2517-6161.1977.tb01600.x）获得 acquisition 计划（needs_access）。均为增量富化、非用户数据漂移。**"--offline 对 ADS 不失效"是既有语义缺口，MS1/MS2 未触碰该文件；是否 gate 住待主 agent 决策。**

## 四门 + 仓库状态

- `corepack pnpm -r build` ✓ / `-r test` ✓（contracts 30、core 197、web 142、infra 59、server 92、cli 33 全过）/ `-r typecheck` ✓ / 根 `corepack pnpm lint` ✓（biome 203 文件零问题）。
- **零代码改动**；golden 夹具零变动（git status 仅 roadmap memory 的既有修改）。
- `literatures/`（library/ output/ jobs/）整体在 .gitignore 内——迁移产物无需 stage/commit；backup tarball 保留待用户 smoke 通过后删除。
- 回滚：`tar xzf literatures.stage7-backup.tar.gz` 即可整体还原。
