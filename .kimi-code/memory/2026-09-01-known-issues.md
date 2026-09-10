# 遗存问题与外部服务状态（2026-09-01 合并版）

## 外部服务

- **MinerU**：2026-09-01 实测 **401 `user authenticate failed`（A0202）**——`~/.zshrc` 的 `MINERU_API_KEY` 失效/鉴权问题，启用 OCR 前用户自查。免费档约 1000 页/天。
- **出版商全线 bot 墙**（2026-08-26 实测）：aanda.org（DataDome）、academic.oup.com（Cloudflare）、iopscience（Radware）、journals.aps.org（Cloudflare）全 403/人机验证。HTML 适配器是待命能力（Stage 3.1 起隔离到 `ocr-features` 分支）。**arXiv 是当前唯一全自动摄入源**；ADS 扫描件半可用（偶发 504）。
- keys 位置：`MINERU_API_KEY`/`OPENALEX_API_KEY` 在 ~/.zshrc，ADS token 在 `~/.ads/dev_key`；也可写 `~/.config/argelanderspace/config.toml`（env 优先）。
- ~~Crossref/OpenAlex 的 UA 仍是 `HubbleSpace/0.1`~~（**2026-09-10 Stage 7 MS1 已改**为 `ArgelanderSpace/0.1`，crossref.ts:55/openalex.ts:138；线上请求指纹已随之改变）。

## 代码遗存（低优先级，立此存照）

- **MinerU `use_cache` 死代码**：缓存探测用字面量 `content_list.json`，真实解包是 `<uuid>_content_list.json` → 短路从不命中，重摄入必重跑全流程（烧配额）。OCR 模块复活时修。**（2026-09-01 Stage 3.1 起随 `ocr-features` 分支迁出 main）**
- **MineruClient 构造即解析 API key**（而非首次调用时）：暖缓存 + 无 env 场景直接 throw。**（同上，已迁出 main）**
- ~~subequations 被 pandoc 合并成一条 DisplayMath~~（**2026-09-08 随 pandoc 删除关闭**）：该机制（pandoc 3.1.3/3.9 合并 subequations 为单条 DisplayMath、丢 `\label`）不再适用。新管线经 amsmath 通道出 subequations 逐条公式与真号（3a/3b 实测正确，MS1 `tex/hyperref` fixture 锁死；xref/eqref 亦正确）。
- **TikZ/pgfplots 图不渲染**（2026-09-04 Stage 5 grilling Q9 用户拍板记为遗留；**2026-09-09 Stage 7 Q1 再拍板：现库零 tikz 使用，继续推后**，等有 tikz 文档入库再立项）：旧管线（pandoc RawBlock 被 walk 静默丢弃）与新管线（不做独立物化）均不渲染 tikz 图——streamView 中此类图不可见，功能不增。未来若要支持需对 tikz 环境做独立编译物化（如 standalone 编译 + pdftocairo）。
- ~~**`enrichAndPlan` 每次 rebuild 无条件重排 `cite_key`**~~（**2026-09-10 Stage 7 MS1 已修**：run.ts 预灌 usedKeys + `if (!w.cite_key)` 才分配，已有键一律不动）。
- **attachPdf 两个隐患**（已实锤）：① 目标 work 无 doi/arxiv 时 seed 退用提取标题算 canonical id，标题失配则 doc 落到新建重复 work，且返回前不校验 `doc_ids`；② `upload-<slug>` 截 48 字符有 docId 撞车风险。**Stage 3.1 MS2 修复**：stamp 焊死目标 work 身份（无 doi/arxiv 时 work.title 覆盖 doc meta.title）+ 直挂 `doc_ids` + 返回前校验 + 幂等 docId `upload-<slug44>-<hash6>`。
- acquire planner 的 EDP/A&A `READY` 标记与现实脱节（站全墙）；plan 输出的 journal_html READY 不可信。**（Stage 3.1 MS1 随 HTML 面裁剪）**

## Stage 7（2026-09-10 关闭——MS1–MS5 landed、用户验收通过、已 push；定稿/里程碑/审查见 `2026-09-09-stage7-roadmap.md`）

**硬约束守住**：agent 侧输出逐字节不变（golden .md 零重冻；MS2 golden .json 也零 diff；MS3 核实 CLI 直读磁盘不消费 LibraryPayload；MS4 agent.ts 零改动）。

已关闭：UA 改名、cite_key 重排、TOC 预览 `[cite:…]`、task.due 语义（软警告）、jpg/gif/webp 直通图尺寸、hyperlink-only xref（取证关闭）、作者块 6 实害边界、re-upload 推广（A1 并行多 doc + 主 doc 指针）、CLI 未识别源建条目（DOI/URL→docless work）。**遗留/新挂 known-issue**：

- **脚注内容整体 DROP**（Stage 7 F 取证升级）：`\footnote` 在 DROP_MACROS 内容整体丢弃，正文内容缺失（现库 3 处脚注内 \ref，读者看不到）。未修。
- **作者块残留边界**（Stage 7 MS2 记录不修）：单机构内 `\\` 换行会切两条（启发式有误判面）；`Name,\inst{1}` 逗号前置 \inst 不吸收；orphan `\affiliation` 占位；尾标点敏感去重；无标记逗号分隔作者不拆（与 "Last, First" 结构性歧义）；`\author{ \\ Inst X}` 产生伪作者（与 `\and \\` 修复形态结构不可区分）；printedToIndex 同号冲突后者静默赢；`\thanks` 前置 email 走 corr 匹配（碰巧命中别人会错挂）；无标记单 piece 尾部可能是第二作者（现判机构）。
- **1610.08981 重 label 假象**：`Eq:dSph2` 定义两次（:119/:180），first-wins 解析到 eq-5，附录 eq-7 永不被指向。立此存照。
- **5 篇 src-only 重摄入失败**（Stage 7 MS2b best-effort 结论）：0902.1039/1307.2657/1307.8124/2603.00229/astro-ph-9707253 缺 arXiv 自带类（aa.cls/emulateapj-rtx4.cls/aas_macros.sty 等），latexmk 编译步失败，阅读器仍 404。1307.8124 探针实证一旦能编译即 18 作者受益。修复方向（换类文件拷入 src/ vs infra shim 目录）未拍板。
- **re-upload 主位三边界**（Stage 7 MS3 审查记录）：从零 rebuild 丢主位（library.json 丢失时字母序播种，"upload 是主"无持久标记）；stale doc（IR .json 被删）在下次 rebuild 前全量曝光（版本列表 N 个 404 条目）；bridging 塌缩方向决定主位存亡（既有 bridging 语义）。
- **SICI 形态老 DOI 截断**（Stage 7 MS4 N4）：`10.1002/(SICI)…<…>3.0.CO;2-L` 含 `<>` 被 URL 正则截断建错 stub。边缘案例。
- **arxiv-latex 摄入的 2607.17040 正文 diff 归因**（MS2b 立此存照）：重摄入后正文大 diff = 旧 IR 垃圾段 `show]wanglong8@…`（`\email[show]` 签名 bug 残渣）消失引发 block id 级联，逐 token 对账非回归；深链接 block id（p-N）对该文已变。

## Stage 6（2026-09-09 关闭——MS1–MS4 + smoke R1 修复 landed、用户验收通过、已 push；定稿/里程碑/审查见 `2026-09-09-stage6-roadmap.md`）

**硬约束守住**：agent 侧输出逐字节不变（golden .md 零重冻、新 IR 字段 agent 不可见）。

1. **阅读器宽度不自适应** → 已修：流式 + 100ch 可读上限（MS1）。
2. **多引用罗列折行** → 已修：拆 per-ref chip、chip 间折行、各点各的 ref（MS1）。
3. **右边栏跳转定位不准** → 已修：图尺寸预留进 IR + jumpTo 停稳检测校正（MS2/MS4；机制两轮更替：定时器→scrollend→停稳检测，MS4 审查抓出并修掉 scrollend 取消面错配）。
4. **~~参考文献缺 title/authors/institution~~ → 重定义 = 当前文献作者块**（2026-09-09 Q8 用户拍板）：已修——authors + affiliation + email 从 LaTeX 源三族机械还原（AASTeX 顺序系/revtex·手写数学上标族/aa.cls 位置系），阅读列顶部折叠作者块（MS3）。"参考文献条目元数据填充（.bib 解析/ADS 富化）"系 memory 误读，**用户确认非其诉求、砍掉**；"搜索联动"澄清 = 就是第 3 项本身。

**smoke R1 顺带修复**：revtex 粘贴 .bbl 的宏汤引用（宏展开层跳过 thebibliography + cleanBblText revtex 词汇 + `\doibase` DOI）与 `\ensuremath` 公式（KaTeX 无此函数，web 恒等宏 shim）——重摄入 1609.05917/1610.08981/2607.17040。

**阶段重编号（2026-09-09 Q1）**：上方"代码遗存"与其他 known-issues 条目 → **Stage 7**；标记功能（渲染页面直接标记到精确位置、标记对 agent 可见）→ **Stage 8**。

## 已接受的行为边界（勿再当 bug 报）

- ~~**task.due 可以晚于 plan.due**~~（**2026-09-10 Stage 7 MS1 已拍板并落地 = 软警告 D3**：语义定为"计划延期是正当场景"，schema 不校验；TaskModal 在 task.due > plan.due 时显示非阻断提示）。

- 深链接锚点（`sec-N`/`fig-N`/`eq-N`/`ref-N`）= **管线结构 id**，非印刷节号。
- ~~TOC float 预览遇 caption 内 cite/xref 会显示 `[cite:…]` 展开记号~~（**2026-09-10 Stage 7 MS1 已修**：stripMath 把 cite token 替换为短文本、xref token 替换为编号，无编号降级 heading/preview）。
- ~~hyperlink-only xref（正文无 token，纯超链接发现）不产生右栏 float 卡~~（**2026-09-09 Stage 7 Q8 取证后关闭**：原始语义 = Stage 2 PDF/MinerU 时代的 PDF 超链接合成 occurrence，Stage 3.1 纯 LaTeX 后机制不存在；现库 8 篇 \ref→IR segment 逐一对账零丢失。拆记三条：①宏隐藏 `\ref`（现库零受害者；未来立项模板 = cite backstop `crossCheckCiteEvents` + argelander.sty 加 ref 事件，红线 = 不得往 segments 塞合成 xref segment）；②**脚注内容整体 DROP 升级为独立 known-issue**（正文内容缺失，比没卡严重，未修）；③section 引用不产卡 = 设计）。
- webui 笔记 tab 只读（写路径归 agent/CLI）；webui 右键色点仅会话级（持久化写路径是 CLI `label --label`）。
- `search` 的空 note hint 刻意打 stderr（stdout 保持纯 JSONL 可 pipe）。
- 上传超过 1800s 超时失败是预期行为；错误应显示在详情面板且刷新后仍在（失败探针在 Stage 3 验收中未实测——**已并入 Stage 3.1 MS2 验收**；MS2 后上传走本地 latex 管线，MinerU 超时语义不再适用）。
