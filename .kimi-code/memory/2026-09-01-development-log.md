# 开发日志（2026-09-01 合并版）

重构期 20+ 份逐-milestone 细录已缩减进本日志 + `pitfalls.md` + `known-issues.md` + `product-and-architecture.md`（用户指示：项目脱离重构期，bug-for-bug 等重构期基线/规则删除）。原始文件在 git 历史（最后存在于 commit `021ddde` 的树中）。

## Stage 1（2026-08-26→27）：Python→TS 重构

- 分层模块化单体落 pnpm workspace（contracts/core/infra/server/cli/web + app 单包 bundle），M0–M6 共 10 个 commit（`ts-migration` 分支，已合 main）。
- 验收：262 测试绿；6 篇 golden（LaTeX×2/PDF×2/HTML×2）与 Python 版逐字段 0 diff；npm pack 干净安装冒烟过。Python 树删除；改名 HubbleSpace→ArgelanderSpace；config.toml / MIT / 单包 bundle 收尾。

## Stage 2（2026-08-27）：agent 接入

- 设计 11 决策拍板：CLI+skills（无 MCP）、agent 全读写、8 子命令、四级深链接、note 每篇必问（agent 先给建议稿）、skills 归 repo `skills/argelander-*`。
- MS1 LLM markdown 渲染器 + agent CLI；MS2 web 深链接 `/doc/<id>#<anchor>`（复用 jumpTo/focusReference）；MS3 skills 三件套 + README + 手动指南。
- 验收：334 测试绿；用户 pi 手动验收五组通过。遗留三件（空 note 不主动提示 / 已读标识不可见 / pi 爱读源码）→ Stage 3 全部关闭。

## Stage 3（2026-09-01）：存储统一 + 渲染 SOT 共用 + webui 补齐

- 设计 grilling 3 轮拍板：项目级 `./literatures`（仅 cwd 相对，否决向上查找）；完整 IR 共用；note tab 只读；MinerU 超时 300s→1800s；全局库留未来。
- MS1 存储统一（默认 `./literatures` + server 轮询指纹广播 + repo `data/`→`literatures/` 迁移）；MS2 渲染 IR 三端共用（`buildDocIr` → `/api/paper/:id/ir` → web/CLI；web 147 行类型镜像 + richtext.tsx 退役；6 golden markdown 逐字节不变，HEAD 对拍验证）；MS3 webui 缺口（note 全文 / label 色点 / 已读标识）+ upload 修复（超时、进度通道、失败可见——冒烟"attach 失败"实锤为 MinerU 上传 300s 硬超时）；MS4 skills 契约（项目根裸跑、不读源码硬条款、空 note 升 numbered step + search stderr hint）+ 文档。
- 验收：426 测试绿、lint 零 warning；用户手动验收基本通过（MinerU 401 = env 问题；`sec-N` 语义澄清 = 结构 id；新发现公式编号全丢 + 单公式丢失 → 进 3.1）。
- commit：`18d4d58`（MS1）/`f23e0e1`（MS2+3）/`ace4d9f`（MS4）/`021ddde`（memory），已 push origin main。

## Stage 3.1 设计定稿（2026-09-01，grilling 三轮 Q1–Q18）

- 5 路子代理取证翻盘两条 Stage 3 验收观察：公式"丢失/无编号"真根因 = 验收环境 pandoc 3.1.3 剥环境外壳（`ENV_RE` 失效 + 误咬内层 cases 削残 eq-3）；`deluxetable`/`table*` 表格丢失独立成立（两版 pandoc 皆降级）。item 5 改案为表格修复，item 6 已读标识撤销（用户：现状满意）。
- 关键决策：webui 上传只收 zip（复用 infra `extractZip`，零新依赖）+ attach-only + 幂等 docId + 身份焊死/直挂/校验；公式全量顺序编号（\tag 优先、不推进计数器、`\nonumber` 尊重）；pandoc 硬下限进管线入口；documents/ 抠 5 符号；golden 全换 latex；`/images` MinerU 分支删。
- 定稿全文（MS0–MS4 切分、取证存档、推后事项）见 `2026-09-01-stage3x-roadmap.md`。

## Stage 3.1 执行（2026-09-01→02，全部 landed + push；待用户手动验收）

- **MS0**：`ocr-features` 分支从 `5c0e93e` 建出 + 封存说明 `9f0efce`，push origin（一次性快照，不维护）。
- **MS1 隔离 `954b0c2`**：−49881 行、270 测试绿。documents/ 抠 5 符号（新 `geom.ts` + `ARXIV_RE/DOI_RE` 内联 references.ts；`readBbox` 因 parseReferences 唯一消费者被删而无需抠留）；`raster.ts` 内联 openMupdf/pageSizeOf；planner 裁 HTML 适配器（journal_html 永标 needs_adapter）；contracts golden 断言改 2 颗 latex；deeplink/ir/render 测试换 latex fixture；依赖净删 22 包（cheerio 系/domhandler/htmlparser2/core devDep mupdf）。
- **MS2 zip 上传 `0a22d1e`**：302 绿。server 端点重建（PK 魔数 + extractZip 试解）；`attachLatexZip`（核心在 `core/src/acquire/upload.ts`）：幂等 docId `upload-<slug44>-<hash6>`、stamp 焊死（无 doi/arxiv 时 work.title 覆盖 doc meta.title）、直挂 doc_ids + 返回前校验；`LatexAcquisitionPort` 加可选 docId 参；失败探针自动化（job error 持久化 + WS hello 回放红字）。顺手修 deeplink unknown-anchor flake（`clearPendingAnchor` 是 useEffect 异步 flush → 断言包 waitFor）。
- **MS3 公式/表格/下限 `4982451`**：313 绿。walk 全量顺序编号（一切 display-math 发号、labelMap 不再写 null、渲染层零改动自动跟随）；`\tag` 提取为显示号/剥出 body/不推进计数器；ENV_RE 加 `^\s*` 锚点；新 `aastex.ts` 机械预处理（deluxetable(*)→table+tabular 保 caption/label/表头、table*→table、tablecomments 降级尾随段；裁决：`\startdata` 身兼表头终止符，header 无 `\\` 结尾时补 ` \\`）；pandoc ≥3.9 硬下限（infra `latex/pandoc.ts` `assertPandocVersion`，管线入口在 acquire 联网前调用；测试 helper 低版本即抛错）；golden 2012.05220 重冻 +48/−16（tab-1 caption 恢复、2 处 tab xref 转 resolved），2501.17225 零 diff；**2607.17040 端到端：crossref 34/49→49/49、11 表全成表、eq 1-5 完整**；3.1.3 负测拦截报错。
- **MS4 收尾 `fc80aa7`**：stub pane 移除（Shell NAV 两行 + CommandPalette 两条 + CSS 注释；terminal 图标实无独立定义可删）+ `docs/manual-test-stage3.1.md`（278 行，§0-8，关键预期全部预实测过）。323 测试绿、lint 零警告。
- **遗留边界**（拍板不修/后续再议）：subequations 合并丢 label（known-issue）；align 内 tag 行与自动号混排时块级 number 呈 `"A1–1"` 区间串（行级 label 精确，真实论文极罕见）；pathological 空归一化标题的 title-only work 上传会在 seed 侧产生重复 work（直挂保证原 work 拿到 doc，无事故）。
- **手动验收（2026-09-02）**：§1/§2/§4/§5/§6/§7 全部通过，§3a/3b 通过；§3c 暴露缺陷——上传按钮只在 `doc_id` 为空时渲染，上传成功后无法重传（传错文件/更新版无路）。**验收修复**：doc 来自 zip 上传（`upload-` 前缀）的条目在"附件" tab 同时显示文档链接与"重新上传 LaTeX 源码包（zip）"按钮（覆盖语义；arXiv 摄入条目不显示，attach 保持补缺口）；补 2 个 web 用例（325 测试绿），手册 §3/§3c 同步。

## Stage 3.1 关闭（2026-09-02）

- 手动验收全部通过（含 §3c/3d 复测），re-upload 修复 `bfac790` + memory `9c7d1f3` 已 push。Stage 3.1 正式关闭。
- 验收遗留两个开放问题（用户拍板记录、**不挡 Stage 4/5**，详见 roadmap 推后事项节）：① re-upload 应推广到**所有条目**——arXiv 先发、后出正式出版版、arXiv 自身也更新，更新通道必须保留；② **webui 定位 = 独立应用**（非纯看板、不与 agent 强绑定，无 agent 用户也要能操作）——影响后续写路径设计（label 持久化/note 写入等现归 CLI）。（② 同日升级为项目级定位：**科研工作台 + 用户与 AI agent 协作的 interface**，取代"文献工具"表述——见 `2026-09-01-product-and-architecture.md`。）

## Stage 4（2026-09-02）：计划页面

- 设计 grilling 三轮 Q1–Q17 拍板（定稿 `2026-09-02-stage4-roadmap.md`）：两层 plans→tasks、plan.due 必填/task.due 必填（deadline 语义；task 级为 smoke R1 改判）、聚焦=pin+派生组、时间线只读、链接只到 doc_id、note markdown+数学（编辑/展示分离）、粗粒度 GET/PUT+rev 乐观锁、`status/plans.json` 与 literatures 平级。**定位升级同步全 memory：产品 = 科研工作台 + 用户与 AI agent 协作的 interface**（取代"文献工具"）。
- 执行：MS1 `eea2c9c`（contracts+core plans store）→ MS2 `2747197`（server GET/PUT+planLock+watcher 双子指纹）→ MS3 `84ed5ec`（web 全家桶：列表/看板/时间线/聚焦/抽屉/弹窗复用/@dnd-kit/marked+mdWithMath + landing 改计划页）→ MS4（smoke 手册 429 行）。**新流程首航**：每 MS 四道门 + subagent 独立对抗审查后自行 commit（用户授权，不逐次问）。审查战绩：MS1 1 阻断（WS union 打断 web 编译）、MS2 0 阻断（15 项 boot 对抗全过）、MS3 3 阻断（mdWithMath 腐蚀两轮——code/货币/URL、IME Enter 误提交、noop 拖拽死代码）、MS4 0 阻断（~40 处手册文案逐字核对）。测试 325→**444 绿**（web 44→102）。
- **待用户手动 smoke**（`docs/manual-test-stage4.md` §0-12）；push 待 smoke 通过后确认。
- **smoke 第 1 轮（2026-09-02）**：§0-11 大部通过；2 阻塞修复（`8804470`，审查 0 阻断）——① **task.due 改必填**（推翻定稿"可选"；创建唯一入口 = 新建任务弹窗，QuickAdd 组件/看板列底移除，旧无 due 任务 load 迁移补 plan.due）；② 列表跨组拖拽拒绝失效（根因 = dnd-kit 多容器碰撞检测 + 边界落点误判；修 = sameGroupCollision 过滤 + dropPoint 命中测试）。`.gitignore` 补 `status/`；手册同步修订（§0c 可跳过标注、§3 重写、§11d DevTools 步骤、§12 迁移说明）。测试 444→448。
- **smoke 第 2 轮（2026-09-02）**：用户报"跨组拖拽还是没有被拒绝"。真实 Chrome 复现证明机制拒绝已生效（0 PUT），真缺口 = **拒绝不可感知**（行跟手进别组、源组让位，静默回弹读作"没拒绝"）。修复（`24c77ac`，审查 0 阻断）：拖动时其他组变暗 + 禁落光标 + 被拒落点 nudge 提示；加固静态缓存头（index `no-cache`、hashed assets `immutable`）。新未解决问题记录：**task.due 可晚于 plan.due**（本阶段不修，known-issues 已收）。测试 448→449。
- **smoke 第 3 轮（2026-09-02）**：用户确认列表拦截生效，但①问看板跨列不拦截是否故意——**是**（定稿 Q11 不对称语义：列表拖拽只调序、看板拖拽即改状态，手册 §5b/§12-3 已写精确）；②**看不到禁落光标**——真 bug：no-drop 打在目标组元素上，但拖拽中被拖行恒覆盖指针正下方，浏览器显示最上层元素的光标，组级规则实际不可见。修复（`8f5338d`，审查 0 阻断）：`onDragMove` 跟踪指针是否离开本组 → root `plan-nodrop-active` → **禁落光标打到被拖行及其子元素**（含状态钮/pin 钮——全局 `button{cursor:pointer}` 的声明值需 `*` 选择器覆盖，审查抓的窄残余）。真实 Chrome 验证：本组内 cursor=pointer、越界=no-drop、drop 后复位。测试 449（mid-drag 用例原地扩展）。**拖拽教训沉淀**：dnd-kit 拖拽中"指针下的元素"永远是被拖行——任何想给用户看的 hover 反馈（光标/高亮）必须打到被拖行或用 overlay，打在落点目标上不可见。
- **Stage 4 关闭（2026-09-02）**：smoke 三轮全部通过，用户确认收尾，全部 push origin main。commit 序列见 `2026-09-02-stage4-roadmap.md` 状态节。

## Stage 5 重定义（2026-09-04，用户拍板）

- 原 Stage 5（论文写作）**删除**，不顺延。新 **Stage 5 = LaTeX 解析线路重构（IR 化）**：废弃 pandoc/mupdf，改走 latexmk 编译产物（.aux/.bbl/.toc/.fls + 自写插桩 .sty 的 jsonl）+ unified-latex 源码树的双通道融合出新 IR；**IR 即存储形式**，streamView 与 agent markdown 均从 IR 渲染；UX 不增不减；编号改**印刷忠实**（未编号公式不再带自产 (N)）。
- grilling 三轮 Q1–Q13 全锁定（2026-09-04 用户确认），定稿/里程碑/取证存档见 `2026-09-04-stage5-roadmap.md`。prototype（原 /media/wwu/MyPassport/texToHTML）已全量转移至 `/tmp/texToHTML` 备参考（⚠️ 其自身 git 未追踪核心代码，/tmp 副本可能是孤本且会被系统清理）。

## Stage 5 执行记录（MS1–MS4b 全部 landed，Stage 5 代码侧完成；待用户 smoke + commit 拍板）

- **MS1 编译执行层**（2026-09-04 landed，commit `d91471d` + memory `edd8fb6`）：`pipelines/tex` ports+facts、infra tex/（workspace/latexmk/argelander.sty/dvisvgm）；mathnum 插桩实测成立；一轮 BLOCK 审查全修复。测试 541→610。
- **MS2 融合层**（2026-09-04 landed）：unified-latex 源树 + 有界宏展开 + 编号/cite/xref 锚定 + TexDocIr schema + 两 golden 重冻至 `tests/golden/tex/`（人工抽查对 ar5iv 全对）；一轮 BLOCK 审查（B1 表注丢失/B2 center 空表体/B3 comment 混 code）全修复。测试 core 177→228、contracts 32→39。
- **MS3a 存储切换+消费侧重接**（2026-09-08 landed）：CLI/acquire/upload/server/agent/seed 全链路改吃新 IR；`/api/paper/:id/ir` 落盘即读 + raw 路由删除；warnings 进 job log；顺带修出行尾注释空格丢失 bug。测试 core 228→229。
- **MS3b 旧管线全删+依赖清理**（2026-09-08 landed）：`pipelines/latex/`、infra latex{pandoc,pipeline,assets}、infra/pdf、documents{annotate,citations,crossrefs,geom,document}、旧套件/旧 golden 全删；mupdf 依赖移除（tsup banner 保留，活人 = `ws`）；**pandoc shim 退役**。测试 622→511。
- **MS4a 发布打包修复+文档换代+memory 收尾**（2026-09-08 本项）：app bundle 随包 `dist/argelander.sty`（copy-assets.mjs，缺失=插桩静默降级已实测）；npm pack 复验（67 文件、零 mupdf、banner 在、sty 在、pristine prefix 摄入带事件）；README/skills/AGENTS.md/web README 的 pandoc→TeX Live 换代；product-and-architecture/pitfalls/development-log/known-issues 同步。
- **MS4b 存量迁移+fallback 删除+smoke 手册**（2026-09-08 本项）：备份 `literatures.stage5-backup.tar.gz`（358MB）→ 清旧 `.json`+`assets/`（留 `src/`+`.latexcache`）→ 缓存离线重摄入：arxiv 12 颗 7 成功 / 5 编译失败按缺失附件（根因逐个诊断：老 aa.cls×现代 natbib、emulateapj-rtx4/aa.cls 不在 TeX Live、aas_macros 缺、plain TeX 非 LaTeX）；28 颗非 LaTeX 时代残留（pdf 5/html 21/upload 2）同按缺失附件。`library build --offline`（两轮）零悬空 doc_ids、works 35→36（+1=Palomar 正典 work 显现，非 bug）、8 work 带 doc（7 文档全覆盖）、works 元数据（note/label/star/read/tags）逐字节 parity。fallback 删除：contracts `document.ts`（Reference 移入 doc-ir.ts）+ core `documents/{ir,tokens,traverse}` + 桥 fixtures + server/cli 两回退点（→ 404/throw）。手册 `docs/manual-test-stage5.md`。测试 511→455。
- **smoke R1 修复：图转换器 dvisvgm → pdftocairo/gs**（2026-09-08）：用户 smoke 实锤 `dvisvgm --pdf` 在真实 figure PDF 丢全部文字+内嵌位图（Chrome 实证；Q9 原结论只验过无文字 stub）。infra `tex/figures.ts` 改 `pdftocairo -svg`（EPS = gs pdfwrite + pdftocairo 两步），测试换带文字/位图的真实 matplotlib fixture（glyph `<use>` 计数+viewBox 对 pdfinfo+`<image>` 断言），golden assets 与 7 颗存量文档 72 个 SVG 同名集重物化，Chrome 对 pdftoppm 真值抽验全对；Q4/Q9 决策加修订注记。测试 455→457。
- **Stage 5 关闭（2026-09-09）**：smoke R2 用户复验通过（含图片修复），迁移备份 tarball 已删，全部 push origin main。遗留 4 项进 known-issues「下一阶段重点」：①阅读器宽度不自适应（侧栏收起不重排）②多引用罗列折行缺陷 ③右栏跳转定位不准 ④参考文献缺 title/authors/institution（补全候选 = .bib 结构化解析 / ADS·Crossref 富化）。

## 下一步

**Stage 6（2026-09-09 grilling 定稿完成，三轮 Q1–Q13 全锁定，用户确认开工）**：修复 4 项阅读器问题——①宽度自适应 ②多引用折行 ③右栏定位 ④**当前文献作者块**（④ 经 Q8 重定义："参考文献元数据填充"系 memory 误读，用户确认砍掉）。**硬约束 = agent 侧输出字节冻结**。MS 切分：MS1 = ①+②（纯 web）/ MS2 = ③（图尺寸预留+落地校正）/ MS3 = ④ + 存量离线重摄入迁移 / MS4 = smoke 手册 + memory。定稿/决策/取证见 `2026-09-09-stage6-roadmap.md`。**阶段重编号**：其余 known-issues → **Stage 7**；标记功能（原 Stage 7 预告）→ **Stage 8**。Stage 4.1（agent 操作计划页面：CLI/skills 读写 `status/plans.json`）**推后**——数据层已预留：稳定 `p_/t_` id、pretty JSON、watcher 覆盖、`plan.changed`、CRUD 纯函数。推后事项/开放问题见 `2026-09-01-stage3x-roadmap.md` 推后事项节 + `2026-09-01-known-issues.md`（task.due 可晚于 plan.due 等）。
