# 遗存问题与外部服务状态（2026-09-01 合并版）

## 外部服务

- **MinerU**：2026-09-01 实测 **401 `user authenticate failed`（A0202）**——`~/.zshrc` 的 `MINERU_API_KEY` 失效/鉴权问题，启用 OCR 前用户自查。免费档约 1000 页/天。
- **出版商全线 bot 墙**（2026-08-26 实测）：aanda.org（DataDome）、academic.oup.com（Cloudflare）、iopscience（Radware）、journals.aps.org（Cloudflare）全 403/人机验证。HTML 适配器是待命能力（Stage 3.1 起隔离到 `ocr-features` 分支）。**arXiv 是当前唯一全自动摄入源**；ADS 扫描件半可用（偶发 504）。
- keys 位置：`MINERU_API_KEY`/`OPENALEX_API_KEY` 在 ~/.zshrc，ADS token 在 `~/.ads/dev_key`；也可写 `~/.config/argelanderspace/config.toml`（env 优先）。
- Crossref/OpenAlex 的 UA 仍是 `HubbleSpace/0.1`（改名前的旧 UA，行为层遗留；改它会影响线上请求指纹，顺手时可改）。

## 代码遗存（低优先级，立此存照）

- **MinerU `use_cache` 死代码**：缓存探测用字面量 `content_list.json`，真实解包是 `<uuid>_content_list.json` → 短路从不命中，重摄入必重跑全流程（烧配额）。OCR 模块复活时修。**（2026-09-01 Stage 3.1 起随 `ocr-features` 分支迁出 main）**
- **MineruClient 构造即解析 API key**（而非首次调用时）：暖缓存 + 无 env 场景直接 throw。**（同上，已迁出 main）**
- ~~subequations 被 pandoc 合并成一条 DisplayMath~~（**2026-09-08 随 pandoc 删除关闭**）：该机制（pandoc 3.1.3/3.9 合并 subequations 为单条 DisplayMath、丢 `\label`）不再适用。新管线经 amsmath 通道出 subequations 逐条公式与真号（3a/3b 实测正确，MS1 `tex/hyperref` fixture 锁死；xref/eqref 亦正确）。
- **TikZ/pgfplots 图不渲染**（2026-09-04 Stage 5 grilling Q9 用户拍板，明确记为遗留问题）：旧管线（pandoc RawBlock 被 walk 静默丢弃）与新管线（不做独立物化）均不渲染 tikz 图——streamView 中此类图不可见，功能不增。未来若要支持需对 tikz 环境做独立编译物化（如 standalone 编译 + pdftocairo）。
- **`enrichAndPlan` 每次 rebuild 无条件重排 `cite_key`**——会覆盖用户可见键。
- **attachPdf 两个隐患**（已实锤）：① 目标 work 无 doi/arxiv 时 seed 退用提取标题算 canonical id，标题失配则 doc 落到新建重复 work，且返回前不校验 `doc_ids`；② `upload-<slug>` 截 48 字符有 docId 撞车风险。**Stage 3.1 MS2 修复**：stamp 焊死目标 work 身份（无 doi/arxiv 时 work.title 覆盖 doc meta.title）+ 直挂 `doc_ids` + 返回前校验 + 幂等 docId `upload-<slug44>-<hash6>`。
- acquire planner 的 EDP/A&A `READY` 标记与现实脱节（站全墙）；plan 输出的 journal_html READY 不可信。**（Stage 3.1 MS1 随 HTML 面裁剪）**

## Stage 6（2026-09-09 grilling 定稿完成，三轮 Q1–Q13；执行中——定稿全文见 `2026-09-09-stage6-roadmap.md`）

**硬约束（用户指定）：agent 侧输出字节冻结**——CLI/skills 命令面、markdown token、bib/ref JSON、深链接逐字节不变；golden .md 不重冻、当冻结守卫。

1. **阅读器宽度不自适应** → 流式 + ~90-100ch 可读上限，只动阅读器（MS1）。
2. **多引用罗列折行** → 拆 per-ref chip、chip 间折行（MS1）。
3. **右边栏跳转定位不准** → 图尺寸预留进 IR + 落地有界重校正（MS2）。注：用户曾疑左右栏跳转模块不同——实为同一 `store.jumpTo`，差异来自目标类型（右栏跳图/表块、图异步加载推偏），用户已认可可能看错。
4. **~~参考文献缺 title/authors/institution~~ → 重定义 = 当前文献作者块**（2026-09-09 Q8 用户拍板）：authors + affiliation + email，arXiv HTML 式，数据全部来自 LaTeX 源（现 meta 抽取刻意丢弃的 `\affiliation`/`\email` 等）。"参考文献条目元数据填充（.bib 解析/ADS 富化）"系 memory 误读，**用户确认非其诉求、砍掉**；"搜索联动"澄清 = 就是第 3 项本身。

**阶段重编号（2026-09-09 Q1）**：上方"代码遗存"与其他 known-issues 条目 → **Stage 7**；标记功能（原 Stage 7 预告：渲染页面直接标记到精确位置、标记对 agent 可见）→ **Stage 8**。

## 已接受的行为边界（勿再当 bug 报）

- **task.due 可以晚于 plan.due**（2026-09-02 Stage 4 smoke 发现，用户拍板**本阶段不修、记为未解决问题**）：TaskModal 与 PUT schema 都不校验任务截止日期 ≤ 所属计划截止日期。语义未定（计划延期的正当场景 vs 数据错误），未来若要约束需先拍板语义，校验点 = TaskModal submit + contracts schema。

- 深链接锚点（`sec-N`/`fig-N`/`eq-N`/`ref-N`）= **管线结构 id**，非印刷节号。
- TOC float 预览遇 caption 内 cite/xref 会显示 `[cite:…]` 展开记号（cosmetic，暂不修）。
- hyperlink-only xref（正文无 token，纯超链接发现）不产生右栏 float 卡（IR 数据边界）。
- webui 笔记 tab 只读（写路径归 agent/CLI）；webui 右键色点仅会话级（持久化写路径是 CLI `label --label`）。
- `search` 的空 note hint 刻意打 stderr（stdout 保持纯 JSONL 可 pipe）。
- 上传超过 1800s 超时失败是预期行为；错误应显示在详情面板且刷新后仍在（失败探针在 Stage 3 验收中未实测——**已并入 Stage 3.1 MS2 验收**；MS2 后上传走本地 latex 管线，MinerU 超时语义不再适用）。
