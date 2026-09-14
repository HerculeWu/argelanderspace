# Stage 9 立项 grilling：webui 文案集中化 + 中英切换

- Session：stage9-i18n-grilling
- 创建：2026-09-14T10:56:05+02:00
- 更新：2026-09-14T12:10:00+02:00（约值，按会话时序记录）
- 工作状态：进行中（M1–M3 实施完成，M4 收尾与浏览器验证中）
- 归并状态：未归并
- 范围与授权：已授权按批准方案实施 M1–M4（代码/测试/四门/浏览器验证）；未授权 commit/push；不操作真实 literatures/ 数据

## 已确认决策

### D1 — 阶段定位与流程（Q6）
- 决策时间与来源：2026-09-14，用户第一轮"按推荐"。
- 结论：立项 **Stage 9：webui 文案集中化 + 中英切换**。流程沿用既有模式：grilling 共识 → 实施方案落 `.pi/memory-reference/` 标"待批准" → 用户批准 → 明确授权后实施 → 四门 + 真实浏览器验证 → 用户 smoke → 用户授权后 commit/push。

### D2 — 范围边界（Q1、Q2、Q12）
- 决策时间与来源：2026-09-14，用户第一轮"按推荐"。
- 结论：范围为 `packages/web/src` 全部用户可见文案（按钮/标签/空状态/错误提示/toast/确认对话框/placeholder/title/aria-label/枚举 label 映射）+ `index.html`（lang 改 `zh-CN`，title 保持 ArgelanderSpace）。
- zh-CN 文案**零行为变化原样搬迁**（含 ~20 条英文残留与中英混排原样保留）；打磨统一留后续阶段。
- server 的 detail/job.error 本阶段不动（含 web 端现有改写逻辑原样迁入）；server 消息中文化/错误码化单独立项。CLI 输出属冻结契约，不在范围。
- 覆盖：无（新范围决策）。重新讨论条件：用户明确扩大范围。

### D3 — 载体与库（Q3、Q4、Q7）
- 决策时间与来源：2026-09-14，用户第二轮"确认 MIT license 就可以按推荐"，随后核实通过。
- 结论：**i18next 26.4.2 + react-i18next 17.0.14**（已核实均 MIT；peer 兼容 React 18.3/TS 5.5）。文案存 `packages/web/src/locales/zh-CN.json`（唯一真相源，嵌套 JSON，非代码文件）+ `src/i18n.ts` 初始化模块 + `i18next.d.ts` 类型增强（key 与插值变量编译期检查）。不用 namespace 拆分；不用 paraglide/自研 loader。
- key 规范：按域嵌套 + 英文语义名（`library.refDetail.copyButton`、`plan.status.todo`）；域名沿用代码目录（library/plan/annotation/doc/shell/common）。
- 覆盖：无。

### D4 — 本阶段做中英切换（Q4 修订、Q14、Q16、Q10）
- 决策时间与来源：2026-09-14，用户第三轮主动扩大范围（"我希望本阶段可以做一个切换"），第四轮"全按推荐"确认机制细节。
- 结论：本阶段交付可用的 zh-CN/en 切换，入口在 **TweaksPopover 新增"语言"分段按钮**（中文/English，复用主题 seg 样式），偏好并入 `Tweaks` 存同一 localStorage key；`i18n.ts` 从 localStorage 初始化，`set("language")` → `changeLanguage` + `<html lang>` 同步；即时切换不刷新；**默认 zh-CN，不做浏览器自动检测，不引入 languagedetector**。
- 日期走 Intl（Q10 选 b）：zh 保持 `M月D日`/`2026年9月` 现状；en 用 en-US 短格式 `Sep 14` / `Sep 2026`。
- en.json 由 agent 起草全套 ~220 条，用户 smoke 时整体审校；术语表（Plan/Task/Library/Annotation/References/Document/Workbench/Today/Overdue…）与 sentence case 风格约定已确认，写入方案。
- Q11 枚举映射壳在可切换下改为**渲染期取 t()** 的函数形式，不能是初始化常量。
- 覆盖：D2 的"纯集中"边界扩为"集中 + 切换"；zh 零变更原则不变，en 为新增内容。

### D5 — 插值、枚举与测试（Q5、Q8、Q9、Q11、Q13、Q17）
- 决策时间与来源：2026-09-14，用户多轮"按推荐"。
- 结论：插值用 `{{var}}` 命名占位，整句一个 key，逻辑分支留代码（嵌套三元拆独立 key）。枚举 label 迁入 JSON 嵌套对象，代码侧保留显式类型化映射（渲染期取值）。
- 测试：现有 12 个按中文文本断言的测试文件**一律不改**，作为零回归证据；新增中文硬编码扫描测试（vitest，扫 src 下 ts/tsx，白名单制，随迁移收缩至仅剩 locales/ 与 i18n.ts）；M3 加 zh/en key 完备性对拍测试。英文硬编码防回潮靠 review，不自动化。
- 里程碑：**M1 基建**（依赖/locales 骨架/i18n.ts/类型增强/扫描测试）→ **M2 zh 逐域搬迁**（shell/components→doc→annotations→library→plan，全程四门绿）→ **M3 en 与切换**（en.json 全套、Tweaks 语言 UI、Intl 日期、lang 同步、key 对拍）→ **M4 收尾**（白名单清空、index.html、四门 + 真实浏览器含切换 round-trip 巡查）。
- 覆盖：无。

### D6 — 方案批准与实施授权
- 决策记录时间：2026-09-14T11:20:00+02:00（约值，按会话时序记录）。
- 来源：用户审阅方案后明确"开工"。
- 结论：[Stage 9 方案](../memory-reference/2026-09-14-stage9-i18n-plan.md)由待批准转为**已批准、执行中**；授权按 M1–M4 实施（代码/测试修改、四门、真实浏览器验证）。**不**含 commit/push 授权（留待用户 smoke 后单独授权）。
- 覆盖：Q1"待批准与实施授权"→ 已批准并授权实施。

### D7 — 用户 smoke 通过与提交推送授权
- 决策记录时间：2026-09-14 傍晚（约值，按会话时序记录）。
- 来源：用户明确"smoke通过，commit+push"。
- 结论：Stage 9 用户 smoke 通过；授权提交本轮全部改动（源码/测试/locales/配置 + 本 inbox 与方案两份 .pi 文档）并正常 push origin main，不强推。不归并正式记忆，不开启新阶段。
- 覆盖：F2/F3 与交接中的"待 smoke、未授权 commit/push"→ 已通过、已授权。

## 已验证事实

### F1 — 文案现状调查（explore subagent，2026-09-14，main@3e50860 干净树）
- packages/web：React 18.3 + Vite 5 + TS 5.5，自研组件，无 i18n 基建（grep 零命中）。
- ~200 条中文 + ~20 条英文文案硬编码于 31 个文件；分布：library ~70 / plan ~53 / annotations ~33 / shell ~27 / doc ~11 / components ~7。~14 处插值模板；3 处枚举 label map（plan/model.ts、annotations/model.ts、theme.ts）。
- server 英文 detail/job.error 直接流入 UI 显示（RefDetail/api 层）；CLI 零中文且输出冻结。
- 12 个 web 测试文件按可见中文文本断言。tsconfig 开 resolveJsonModule；biome 对 web 关 formatter/organizeImports。
- Tweaks 机制（theme.ts）：localStorage `argelander.tweaks` JSON 持久化，打到 `<html>` data 属性；fmtDate=`M月D日`（plan/model.ts:71），时间线刻度 `2026年9月`。
- npm registry（2026-09-14 查询）：i18next 26.4.2 / react-i18next 17.0.14 / languagedetector 8.2.1，三者均 MIT；react-i18next peer：react≥16.8、i18next≥26.2、TS ^5+。

### F2 — M1–M4 实施完成（2026-09-14，main@3e50860 未提交树）
- M1（父代理亲自）：i18next 26.4.2 + react-i18next 17.0.14 入 web 依赖（pnpm 自动把 react-i18next@17.0.14 加入 pnpm-workspace.yaml 的 minimumReleaseAgeExclude——供应链策略的机械放行，知悉）；locales 双 JSON 骨架、i18n.ts、i18next.d.ts（类型增强经负例探针验证生效：错误 key 编译报错）、main.tsx/vitest setupFiles 接线、no-hardcoded-copy 扫描测试（初始白名单 31 文件）。
- M2 四域（4 个 coder 子代理串行，各自 web 三门绿）：shell+components → doc+annotations → library → plan；zh-CN.json 七节 305 叶子（含父代理预加的 shell.tweaks.language.* 3 条）；WHITELIST 清空为 `[]`。判断点：枚举 label 均为渲染期取值的类型化映射/函数（labelKey/switch 两种先例）；通用串入 common.*；server detail 透传未动；注释中文译英（扫描含注释，白名单须能清空）。
- M3 两个并行子代理：en.json 305/305（key 集/层级/顺序与 zh 一致，locale-parity 测试 4 断言）；TweaksPopover 语言组 + theme.ts `language?: AppLanguage`（**可选字段**——必填会迫使改动 8 个存量测试 fixture，违反零改动约束，可选+`?? DEFAULT_LANGUAGE` 兜底，真实路径行为无差异）+ useTweaks effect 同步 changeLanguage 与 `<html lang>`；fmtDate/timelineScale 月刻度 Intl 化（父代理实测 Node full-ICU zh-CN 输出与旧手写格式逐字节一致；M2 的 \u 转义临时形态随之删除）；plan-date-locale 测试（zh 恒等 + en 格式）。
- M4（父代理）：index.html lang="zh-CN"。

### F3 — 最终验收（2026-09-14 下午）
- 四门在最终树各自 exit 0：build ✓ / test ✓（web 24 文件 289 用例；contracts 53 / core 271 / infra 60 / server 182 / cli 51 全绿无 skip）/ typecheck ✓ / lint ✓（244 文件）。既有 12 个文本断言测试文件零改动。
- 真实浏览器验证（coder 子代理，headless Chrome 150 + raw CDP + 真实生产构建 server + /tmp 合成数据，未碰真实 literatures）：**7/7 场景通过**——zh 默认、切 en 即时不刷新、刷新偏好保持、切回中文、文献/文档空态双语、console 零错误、插值真实填充无字面 `{{`。截图 12 张与 report.json 在 `/tmp/stage9-verify-IpInsT/`（临时证据）。
- 环境怪癖（非回归）：headless Chrome 的 getComputedStyle 对 oklch 返回原始字符串，强调色探针的正则兜底把五色都算成 #004800——theme.ts 探针与 TweaksPopover 色板渲染路径本阶段**零改动**（diff 实证），真实浏览器不受影响；如实告知用户。
- 数据边界确认：英文模式下「我的文献库」仍为中文——它是 server 端生成的库名**用户数据**（core/library/store.ts），不属于 UI 文案范围；如需本地化另立议题。

## 待确认事项（用户 smoke 时审校）

- en.json 全文审校；M3A 报告的术语表外新造词：扩展 Extensions / 外观设置 Appearance settings / 信息密度 Density / 已精读 Read in depth / 推荐 Suggested / 已收录·未收录 In library·Not in library / 图例被引量 Citations / 已入库 Ingested / 源码包 (LaTeX) source package / 状态圆钮 status dot / 聚焦·取消聚焦 Pin·Unpin / 引用键 Citation key / 反爬墙 Anti-scraping wall 等（全表在 M3A 交付报告，en.json 与 zh-CN.json key 顺序一致便于对照）。→ **用户 smoke 通过（D7），如有文案修订属后续打磨，不走本阶段。**

## 交接状态

- **已提交并推送**：`42d52e3`（48 文件，+1947/−414），origin/main 已更新（`3e50860..42d52e3`）。推送用一次性 `git -c credential.helper='!gh auth git-credential'`（gh 已登录 HerculeWu，keyring），未落配置。工作区干净。
- Stage 9 关闭：方案已标"已关闭"；本 inbox 记录随提交入 Git。
- 提醒：epoch-review 与 mem-31b251a 两份旧 inbox 仍未归并（加上本份共 3 份，未达 8 份阈值；阶段已交界，建议近期安排一次归并整理授权）。
