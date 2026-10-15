# 工程指南与验证教训

2026-09-21 从 `46093915:.pi/memory/engineering.md` 迁移。这里保留不易从配置看出的惯例、陷阱和证据范围；历史验证不代表本次重测。原始本机依赖、凭据位置与外部服务观测保留在私有 `.scratch/memory-migration/local-environment.md`，不作为新机器环境保证。

## 运行与验收

- 本机 Node v24+ / npm 11+；项目 pnpm 11.24.0，经 **`corepack pnpm`** 调用，裸 pnpm 不在 PATH。Node 的 pnpm 下限历史记录为 ≥22.13，本项目环境仍以 v24+ 为工作基线。
- 常规代码验收四门以 [AGENTS.md](../AGENTS.md) 的工程入口为准。无 per-package lint，不用 `-r lint`。纯文档迁移做保真/引用/范围检查，不默认重跑产品四门。
- TeX Live 全家在 `/usr/bin`：latexmk/pdflatex/xelatex/bibtex/biber，是摄入前提；真编译测试 `HAVE_LATEXMK` 类 gating，缺工具会 skip，不能把 skip 当实测通过。
- 图转换可选依赖 poppler-utils（pdftocairo）与 ghostscript（gs，EPS）；不再需要 pandoc/mupdf/dvisvgm。不要把整个 astro conda bin 前置 PATH，它的 node v20 会抢系统 node；旧 pandoc shim 无需重建。
- repo CLI 可跑 `node packages/app/dist/bin.js`。app 包名是 `argelanderspace`，不是 `@argelanderspace/app`，pnpm filter 勿写错。
- 无 CI 是截至 Stage 8 的工程观测，不因后续记忆未提及就冒充本次已重新核实。阶段历史里的独立审查/自动 commit 授权已结束；当前审查与工具治理按当次授权执行。

## 子代理实施限时与主代理介入

2026-09-24 用户将此前仅适用于一轮 PDF 票据的临时做法升级为**此后的正式工程规范**。凡由 subagent 承担的实施任务（含逐票实施），按其**每次独立运行**而不是整张票累计计时；此规则不改变已结束任务的历史记录，也不授予额外执行、迁移或提交权限。

- 主代理派发时为单次运行设置 **120 分钟硬 timeout**；运行快到期时尽可能提前约 5 分钟请求 checkpoint，交代已改文件、测试/证据、仍未完成的工作与风险。工具不支持直接设置时，主代理必须用可执行的外层限时和停止机制实现同等单次上限，不得无期限放任执行。Claude Code 的子代理没有墙钟 timeout 参数（`maxTurns` 只限轮数）：主代理以后台方式派发、记录开始时间，按有界间隔检查，约 115 分钟时用 `SendMessage` 要 checkpoint，120 分钟仍未返回则用 `TaskStop` 停止并按下一条介入。该做法首次实际使用时须核验可行并记录结果。
- 到时仍未完成，**主代理主动介入**：核对真实运行状态、工具/测试日志、部分工作区改动及残留进程，不能自动续时、自动标完成或启动后续票。终止运行也不等于可以丢弃未验收改动或触碰真实用户数据。
- 仅当确实是本票工作量不足以在单次运行内完成，且没有工具卡住、失败循环、红测试、数据风险或待用户决定的事，主代理才可明确批准同票 continuation/同角色交接；新的单次运行仍限 120 分钟。否则由主代理先定位、修复或请用户裁决，记录阻塞及证据，不能用“任务量大”掩盖故障。
- 子代理按时返回也只是交接；完成与否仍由主代理核对验收条件。顺序票据另遵循[本地 tracker 的逐票停止点](agents/issue-tracker.md#implement-顺序票据的委派约定)。

## 顺序实施与证据收口纪律

2026-10-01 用户验收本轮图标/按钮正式界面后，明确要求保存本轮工程纪律，后续无需重复提醒。以下是今后的默认工作方式；当次用户明确指定的模型或流程优先，不能据此自动取得实施、提交或推送授权。

- **角色模型与 effort**（2026-10-02 局部修订：原 2026-10-01 规则“实施、验证、独立审查统一用 `openai-codex/gpt-6.1-sol` + `medium`”随 harness 迁到 Claude Code 失效；本条只替换模型分配，本节其余纪律不变。理由：实施 token 量最大，用较便宜模型；审查是最后一道门且输出短，加码收益高；仓库约束已足够强，规划不常驻最高档。）角色定义在 `.claude/agents/`：
  - 主会话（grilling、spec、拆票、父代理验收）：Opus 5.5，high；难的架构/ADR 决策可临时切 Fable 5.1。
  - 研究 `researcher`：Sonnet 5.5，medium。
  - 实施 `implementer`：Sonnet 5.5，medium；同票两轮修复仍不过，升级 Opus 5.5 重派。
  - 逐票审查 `reviewer`：Opus 5.5，high；整条分支收口审查派同一角色并显式指定 Fable 5.1。
  - 派发时模型以角色定义为准，升级/降级须显式写明。模型不可用或运行器失败先报告，不擅自更换模型/执行协议。子代理不再派子代理；Standards/Spec 双轴审查由父代理分别派发 `reviewer`。
- **逐票交付与父代理验收**：遵循[tracker顺序委派约定](agents/issue-tracker.md#implement-顺序票据的委派约定)。每票 fresh-context、同一工作区仅一个 writer，父代理核对实际 diff、测试与浏览器证据后才推进；子代理返回/绿门不自动等于完成。暂停决策保留 checkpoint，不让工作流误开后票。单次运行与 continuation 按[120分钟限时规则](#子代理实施限时与主代理介入)。
- **有界验证，不为凑绿扩范围**：在已确认的公共接缝做 TDD，实施中定向测试/类型检查，收口跑完整四门，并做 fresh-context Standards/Spec 双轴审查。只迁移批准原型明确列出的属性；未列控件默认保留。矩阵与真实浏览器要求仍以[原型还原门](#已批准-ui-原型到正式应用的还原门)为准。
- **区分产品偏差与探针限制**：先保存失败原图、日志和完整状态，再做有明确假设的有界单变量诊断；探针修正记录原因，不反复采样挑绿、不扩大像素容差或重冻基线掩盖偏差。同节点重绘只有在焦点、hover、tooltip、几何、属性和计算样式端态等价时才支持因果判断；截图有差不自动证明产品回归，computed相同也不等于像素已获批准。动画/栅格/未锁定残差分别披露；实验截图不能替代正式验收图，不为探针加生产重绘补丁。
- **既有缺陷不顺手修、不静默豁免**：原基线不满足票据验收时，区分新引入回归与旧缺陷，记录证据并请用户裁决；只按明确局部范围修订继续。独立推后事项保留在本地票据，不宣称已修复或已通过。
- **保全与交付边界**：开始时记录已有工作区改动；保留用户字节、原型及失败证据，用隔离/合成数据验证，不操作真实用户数据。只清理有明确所有权的进程和临时 profile，不碰外部服务。获提交授权后核对实现与必要基线的提交范围，不混入无关配置/skills/私有材料；用户另有授权前不 push、打包发布或迁移数据。技术验收与用户正式应用验收分别记录，未测组合不因用户满意被改写成实测通过。

## 测试与前端验证

- 网络测试用 fetchImpl 注入离线 stub；config 测试 `$XDG_CONFIG_HOME` 指 tmp。ADS token 自 desktop-app 票 12 起只从凭据存储读（`$ADS_DEV_KEY`、config 的 `ads_dev_key`、`~/.ads/dev_key` 都不再生效），所以要 ADS 有 token 的测试把它放进凭据存储：进程内注入假的钥匙串后端（`createCredentialStore({ purpose: "ads", backend })`，server 经 `createServer` 的 `adsCredentials`），spawn 的 CLI 则在子进程的全局数据目录里写一份经同意的后备文件（`cli/tests/ads-token.test.ts`）；什么都不放就是 no-token。shell 里导出的 `OPENALEX_API_KEY` 等变量不被清除，仍会带进测试和子进程。**测试不碰真实钥匙串**：隔离脚本（下一条）同时把 `DBUS_SESSION_BUS_ADDRESS` 指向临时根下一个不存在的 socket、`XDG_RUNTIME_DIR` 指到临时根、删去 `DISPLAY` / `WAYLAND_DISPLAY`，默认后端连不上用户的 Secret Service，报「钥匙串不可用」。三个包的守卫测试（`isolation-guard.test.ts`，经 `user-dirs-guard.ts`）断言的是这些环境变量已被改写；默认后端在这种环境下确实读不到 token，由 infra `config.test.ts` 的「readAdsToken: only the credential store…」断言。测试要写 `~/.ads` 时先断言 `homedir()` 在临时目录下（server 的 ADS 接口测试改用 `createServer` 的 `adsDevKeyPath` 指向临时文件，不写主目录）。spawn 子进程时要么继承这份环境，要么同样显式设置——只留 `PATH`/`HOME` 的子进程环境不够（D-Bus 库可能按 `/run/user/<uid>/bus` 找到用户的总线）。
- **测试隔离用操作系统的用户目录变量**（desktop-app 票 04）：infra / server / cli 的 Vitest `setupFiles` 第一项都是 `packages/infra/tests/isolate-user-dirs.ts`，逐测试文件建临时根，把 `HOME`/`USERPROFILE`、`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`、`APPDATA`/`LOCALAPPDATA` 指到其下；工作台自己的环境变量已不再被读取（desktop-app 票 05），隔离只靠这些系统变量，需要把全局目录指到别处的测试用 config 键或注入的 `config`/`dataDir`。env-paths 在导入时固定 homedir，所以该脚本不导入任何产品模块、必须排在其他 setup 之前，包自己的 setup（如 server 的 `setup-isolation.ts`）排其后。各包的 `isolation-guard.test.ts`（共用 `user-dirs-guard.ts`）断言默认解析出的全局数据、全局缓存目录都在临时根下，且只剩 HOME 时仍成立；它红了说明隔离失效，其余测试可能在读写真实目录，先修它。新增的用户级目录加进守卫的目录表；新包的测试若会解析用户级目录，接同一个 setup 与守卫。大量测试在用例里把 `process.env` 整体换成只含 `PATH`/`HOME`/`XDG_CONFIG_HOME` 的普通对象：这不改变进程的真实环境，所以 env-paths 仍读它导入时拿到的原 `process.env`（含临时 `XDG_*`），调用时才取 `os.homedir()` 的代码（`config.toml` 路径、ADS key 文件、Copilot 配置目录）得到的也是隔离脚本设的临时 HOME，而不是用例自己写进新对象的 `HOME`；导入时固定的临时 homedir 是变量被原地删除时的兜底，守卫的第二条测的就是它。隔离依赖 Vitest 默认的 forks 池：换成 threads 池时 worker 里写 `process.env` 到不了真实环境，守卫会红。CLI 的 spawn 测试跑的是构建后的 `packages/cli/dist/bin.js`：dist 若是票 05 之前构建的，旧二进制仍会读 shell 里导出的 `ARGELANDERSPACE_*`，所以先 build 再跑（四门的顺序本就如此）。**用户日志目录已在守卫的目录表里**（desktop-app 票 06，三个包的 `isolation-guard.test.ts` 都断言 `resolveLogDir()` 在临时根下）。最近项目文件同样在表里（desktop-app 票 18，`resolveRecentProjectsPath()`）。测试服务器默认没有日志：`createServer` / `createApp` 不传 `log` 就不记录、不创建日志目录，既有的约 90 个起真实 server 的测试文件因此不写任何日志文件；要断言日志的测试自己传一个 logger，写到临时目录（`openLogFile`）或写到内存（测试辅助 `packages/infra/tests/log-memory-sink.ts` 的 `createMemorySink`，不是产品导出，server / cli 的测试按路径引用），或调 `startServer`（它写到隔离后的默认日志目录，`packages/server/tests/logging.test.ts` 用完即删）。带 log 的 server / app 会把 Writer 沙箱探测的结果记进日志：探测是一个异步的子进程，结果进入它在途期间问过它的每一个 server 的日志（可能是几个，也可能是已经关闭的），而一旦得到「可用」的结果就被缓存，同一个测试 worker 里后起的 server 一条都没有——所以某个测试的日志里有没有这条记录取决于时序；按条数断言日志的测试文件先用 `__setWriterSandboxForTests(false)` 把探测关掉（`packages/server/tests/logging.test.ts` 的做法），或只按事件名筛选后再断言。`packages/cli/tests/logging.test.ts` 里进程崩溃的用例跑的是 `tests/fixtures/crash.mjs`，它导入构建后的 server 与 infra，同样要先 build。
- `skills/argelander-find-papers/scripts/` 在 workspace 之外，四门与 biome 都不覆盖；其离线测试单独运行：`node --test skills/argelander-find-papers/scripts/ads.test.mjs`（fetch 与 HOME 注入，不触网、不读真实 key）。
- `--offline` 自 Stage 7 起 gate ADS/Crossref/OpenAlex，缓存仍可读。迁移声称离线仍应核实所走路径，不将 env 恰有 token 当测试前提。
- web Vitest ^3 与 Vite 5 配套，其余包 Vitest 4；独立 vitest.config 不加载 React 插件。happy-dom 全局 URL 不是 Node URL，读文件用 `node:url` 的 fileURLToPath；IntersectionObserver 需 stub。
- happy-dom 无布局：rect/selection/scroll 相关测试“绿”不能证明真实像素正确。Stage 8 selbar-y 钳制测试零 rect 恒过，真实 Chrome 双轴探针才是证据。测试局限不是产品缺陷。
- SVG 忠实性真值：pdftoppm 位图 + 真实 Chrome 截图；不要用 ImageMagick MSVG 作裁判，其渲染器也会丢特性。
- **真实 fixture 必须覆盖文字、内嵌位图、尺寸**：glyph use、image 存在及 viewBox 对 pdfinfo。三角 stub 曾放过 dvisvgm 真实图丢全部文字/位图，不能重走该路线。现 infra `fig-text.pdf` / `fig-imshow.pdf` / `fig-text.eps` 回归覆盖。
- Stage 8 证据：offset round-trip 2080 组、web/CLI 标注排序 500 轮对拍、真实 Chrome 选区/重叠/归档/删除探针；这是历史验证范围，不是对所有浏览器/构造的全称保证。临时截图与 raw-CDP 脚本不保证仍存在。
- reader epoch 真浏览器验证必须真实替换 IR/正文/图，不能只变 fingerprint mock；正常合成 zip 上传→latexmk→job.done→自然 library.changed 才证明真实通知链。CDP composition 不等于 OS 输入法，fetch 取消也不穷举 decode/onLoad 全时序。最终 17 个受测用例通过的范围与局限在历史原文，不抹掉中途失败。
- Stage 11 有 65 组合成 citation 与 PDF/pdftotext 对拍及发布包真实 Chrome/CDP 证据，**不推翻用户 Report citation 未通过**。四门绿、合成 smoke、用户 smoke、阶段关闭是不同结论。
- Stage 12 四门 1066 passed + 1 可选 skip；真实 Chrome/CDP 探针验证显式渲染（打开/输入/暂停 0 编译、Shift+Enter 恰好 1 次、Render 按钮有效），导出 zip 产物 latexmk 自编译 EXIT=0；用户 smoke 通过，I030/I031 关闭。CDP 教训：`Runtime.evaluate` 的 returnByValue 不能序列化 DOM 节点（waitFor 表达式需 `Boolean()` 包裹）；点击类 evaluate 返回值序列化偶发 -32000，用效果断言代替调用成功。IME 全角逗号是真实用户输入风险，按 Stage 12 决定属用户语法责任（I034）。
- **latexmk 稳定缓存在编译失败后曾死锁**：“Nothing to do”+“previous invocation error”，坏 bbl 阻断 bibtex 重跑；Stage 12 起 compileTex 失败路径清理 aux/bbl/blg/fdb_latexmk/log（输入不动），下次编译自愈。desktop-app 票 08 起，完整日志的另存发生在这次清理之前（`tex/failure-log.ts`），清理的文件集合不变；`infra/tests/tex-failure-log.test.ts` 钉住「失败后被清掉的文件」与「同一份源立即重试能重新编译」。
- web Vitest 经 workspace **dist** 解析；改 contracts/core 后先 build 再跑下游测试，否则可能误报旧实现故障。CodeMirror 的 happy-dom selectionchange 同步重入用测试 shim，不当真实浏览器证据。Shift-Enter 高优先级及 compositionStarted 防 IME 误提交是当前集成教训。
- biome web legacy override 关闭了部分格式/导入/a11y；不要对旧前端文件盲目 `--write` 全量重排。新代码保持 clean；parse 级错误不能靠 override 关闭，真实 HTML 夹具当年需 files.includes 排除。

### 交互回归教训

- 中文 IME Enter：提交处守 `isComposing`；原生 required 不在 form 内不形成有效守门，业务 valid guard 仍需测试。
- dnd-kit 拖动时指针下恒为被拖行：禁落 cursor/hover 反馈须打在被拖行及其子元素或 overlay，打目标组不可见。全局 button cursor 会覆盖继承值。
- 列表跨组“机制拒绝”不等于“用户感知拒绝”；需要变暗、禁落光标和 nudge，而非只静默回弹。
- jumpTo：平滑滚动途中的 instant 校正会被吞，scrollend 监听取消面曾元素错配造成 undo 后拽回。最终用 scrollTop 停稳检测，≤2 校正/≤8 re-arm；取消覆盖 wheel/touchstart/keydown/undo/新 jump。不退回固定定时器/scrollend 旧中间态。
- WS union 新增消息必须给 web dispatcher 显式分支；else 假定全为 job 事件曾在 Stage 4/8 打断编译。
- deeplink flake：先区分 effect flush（waitFor）与真正循环；Stage 8 openView 幂等 + mock 真正清 pendingAnchor 根治了无限 effect，不只加 timeout。
- 注入文件权限失败时 root 可绕过 chmod；file-where-dir 才可稳定模拟失败。
- 暂停 JS 导航不等于禁浏览器原生 hash 滚动：reader sync/error 保旧正文时撤原生 id、保 data-block-id/DOM 节点，避免 pending hash 提前滚动；不通过改 URL 协议或 scroll 锁掩盖。延迟 ref focus/timer 必须检查当前 generation，discard 草稿同时清局部编辑态。
- best-effort 滚动验收要看真实 wheel 接管、视口相对位置与无回拉；DOM 直接赋 scrollTop 或苛求布局变化后精确旧 px 不是相同行为。
- **CitationGraph 位置表只在首挂载初始化的潜伏崩溃**（Stage 13 探针抓获）：payload 刷新带来新节点 id → 渲染期 `P.current[id].x` undefined → React 整树卸载。修复为渲染期 heal（新节点就地初始化，邻点播种），回归测试须可证伪（去 heal 必败）。教训：ref 型一次性初始化面对 WS 驱动的数据更新不安全；真实浏览器探针先于用户 smoke 抓获。
- `resolveWork` 的 fill() 原本不填 title：摄入/bib 路径 work 恒有标题故无受害；手动建裸标识符 stub 时标题空、UI 拿 id 当标题（Stage 13 探针抓获）。fill 现含 title，仅填空白，对存量无行为变化。

## 前端交互规范

以下是工作台 Web 的现行设计原则（2026-09-24 用户确认）；具体组件、主题与原型审阅门见 [Web design](../packages/web/DESIGN.md)。

- **UI 不负责解释和教学**：不要把长篇概念解释、操作教程常驻界面；用清晰布局、操作反馈和按需展开让用户完成当前任务。但风险范围、不可逆后果、失败原因、恢复办法及必要的状态说明必须清楚可见，不以“精简”为由省略安全与无障碍信息。
- **能用图标的就不要用文字**：动作可由清晰、可区分的图形表达时，优先只显示图标，名称放在可访问名称和键盘/指针可用的 tooltip 中，不把图标和文字并排当默认模式。提交/不可逆确认、包含动态对象的操作及图标语义含混的操作应保留可见文字；文字按钮不强加图标。可点击的文献、图节点等内容主体不因本原则变为图标按钮。

## 已批准 UI 原型到正式应用的还原门

原型在 [Web design](../packages/web/DESIGN.md#ui-consensus-and-prototype-gate) 中是已审阅的设计证据，不能只把它当作风格参考。实施含 UI 的票据时，在对应**本地私有票据**记录「原型控件/状态或截图 → 正式 `data-ui` → 按钮显示模式/可访问名称 → 实际尺寸、排列、展开位置与失败态 → 自动测试和真实浏览器证据」的对照矩阵；不适用项注明理由。获批准的原型与正式实现若有实质偏离，先请用户重新确认，不能凭旧 CSS 与新 CSS 的一组相似度替代原型核对或用户正式应用验收。

- 图标/纯文字/经单独批准的混合按钮逐个检查 DOM 内容、tooltip/ARIA、disabled/busy 与业务回调；不能只证明 `data-ui` 存在。图标 SVG 在 `icons.json` 按操作 `data-ui` 定位，有状态变化时在同键下列出变体；无资源或危险资源的回退必须可见。
- 对应真实运行界面的 1440 与 1024 桌面、深浅主题和代表性密度，用浏览器测 `getBoundingClientRect()` 与截图核查按钮宽高、正圆色点/菜单、同排对齐、滚动可达性和浮层是否遮挡/下推；happy-dom、构建成功、旧样式对拍不能作为像素结论。尤其要测打开浮层及列表接近视口底部时是否全部可用。
- 工程核查通过只表示已测组合，**用户本人的正式应用终验仍是独立停止点**；未通过要将用户按 `data-ui` 指出的每项问题重新列入该票，并在修复后重复上面的矩阵与实际浏览器检查。

## Web i18n 维护

Stage 9 已关闭。`i18next 26.4.2` + `react-i18next 17.0.14`，MIT；`src/locales/zh-CN.json` 是 key/中文源，`en.json` 同层级 key/插值对拍。`src/i18n.ts` 初始化，`i18next.d.ts` key 类型增强曾用错误 key 负例验证。纯 JSON、每语言单文件，不按域拆 i18next namespace；`writer.*` 是域 key 而非新 loader。

- 英文语义域 key、`{{var}}` 整句命名插值；条件分支留代码、拆 key；枚举在渲染期取 t，不能模块初始化固化语言。
- 语言与其余界面偏好的权威位置是 `config.toml` 的 `[ui]`（desktop-app 票 10），经设置接口读写，机制见 [architecture](architecture.md#设置接口文件监视与界面偏好desktop-app-票-10)；浏览器本地存储里的 `argelander.ui` 只是页面写下的副本，旧键 `argelander.tweaks` 不再读取。默认 zh-CN，不用 languagedetector，changeLanguage 同步 html lang，无刷新。language 类型可选是当轮保持旧 fixtures 不动的实现兼容，实际默认有兜底。组件测试里页面的语言由（假的）设置接口决定：要让页面保持英文，就让它返回 `ui.language = "en"`（`packages/web/tests/settings-fake.ts`），只调 `i18n.changeLanguage("en")` 会在设置读到后被配置的语言盖掉。
- Intl：zh 保原 `M月D日`/`YYYY年M月`，en 用 en-US 短月；有日期恒等回归。index.html 静态 zh-CN，title ArgelanderSpace 不变。
- `no-hardcoded-copy` 扫 src ts/tsx 中文（含注释），白名单已空；locale-parity 检 key/插值。英文硬编码靠 review。Stage 9 既有 12 份中文断言测试零改动是迁移证据，不是永不准改测试的契约。
- Stage 9 安装曾机械增加 react-i18next 的 minimumReleaseAgeExclude；不是以后依赖可任意绕过供应链策略的授权。headless Chrome oklch 强调色探针误算是当轮工具局限，不作为产品颜色 bug。

## 打包与配置（不要当冗余清掉）

- **createRequire banner 必须保留**：esbuild 内联 CJS `ws` 后运行期 require(events)，移除 banner 实测启动炸。不是已删除的 cheerio/safer-buffer；tsup shims 只管 filename/dirname。
- **删除源文件后清相应 dist 再 build**：tsc 不清旧产物，app 曾把已删 raster.js 再内联回来。清理范围限生成 dist，不碰用户数据。
- **dist/argelander.sty 必须随 app 包**：bundle 内 import.meta.url 指向 app/dist，copy-assets.mjs 负责复制；缺失会静默干净编译、丢事件而不是崩溃。npm pack + 干净安装摄入需要验证 sty 存在且确有事件流。
- web-dist 查找：bundle 旁 web → cwd/packages/web/dist（dev）；静态 index/SPA fallback no-cache，hashed assets immutable，排除 stale bundle 验收干扰。
- **版本号只在 `packages/app/package.json` 的 `version` 改**（desktop-app 票 16；旧状态是 CLI `.version(...)` 与 app package.json 两处手工对齐）。CLI 包的 build / pretest / typecheck 先跑 `packages/cli/scripts/app-version.mjs`，把它写成 `packages/cli/src/generated/app-version.ts`（被 Git 忽略，不手改；版本不是 `x.y.z` 形态时构建失败）；CLI 的 `--version`（输出格式不变）、`serve` 启动记录的 `version`、诊断包环境报告的 `app.version` 都取自它，app 的 bin.js 随 CLI 一起内联。改版本后重新 build 才生效；新克隆在第一次 build 或 typecheck 之前编辑器会报找不到这个模块。`cli/tests/version.test.ts` 断言三处都等于 app 包的版本（并用临时 package.json 验证生成脚本跟随改动），`app/scripts/version.test.mjs` 断言打包后的 bin.js 也是（所以 app 包的 `test` 要先 build cli 与 app，单跑 `--filter argelanderspace test` 前先 build；只 build app 而不 build cli 会把旧版本打进 bin.js，这条测试会抓住）；`smoke-pack.mjs` 的离线锁条目取 `npm pack` 报告的版本。其余 workspace 包的 `version`（`0.0.0`，web 的 `0.1.0`）是不发布的私有包占位，不被任何地方显示。对外请求的 User-Agent 里的 `0.1`（infra 的 Crossref / OpenAlex `ArgelanderSpace/0.1`、arXiv 下载 `bibgraph/0.1`）是固定的请求标识，不随版本号变，改它另需决定。
- config.toml 使用 smol-toml，CLI 命令每次现读无缓存；未知键忽略，类型错点名键，不回显值；`data_dir` 写绝对路径同样是点名键的 `ConfigError`（在解析处拒绝，所以带了 `--data-dir` 的命令也会报）。`serve` 例外：宽松读取、坏键用默认值照常启动，需重启的键（含两个全局目录）在启动时固定（desktop-app 票 10，见 [architecture](architecture.md#设置接口文件监视与界面偏好desktop-app-票-10)）。默认端口只有 contracts 的 `DEFAULT_PORT` 一处，web 的 `vite.config.ts` 也从它取，所以跑 `vite` 前 contracts 要先 build。
- Stage 11 app 收集 20 个编辑器运行依赖 MIT notices；uiw 两个 npm 包缺 LICENSE，采用与官方 v4.25.11 原文逐字节一致的版本限定副本（packages/app/licenses）。升版本须重核，不能静默沿用旧版权。最终包曾离线安装验证 sty/web/notices 齐全，不含 aa.cls/aa.bst。
- Copilot 交付（票 31）：Pi SDK、`@embedpdf/engines|pdfium`（含 PDFium WASM，经 `import.meta.resolve` 找）与 `@napi-rs/keyring`（钥匙串原生 `.node`，无法内联；缺失或无 Secret Service 时按“钥匙串不可用”处理）是 app 的**运行时 `dependencies`（不打进 bin.js）**，随 `npm install` 安装；版本化 instruction 文本内联在 bin.js（单一 resourceLoader，不读文件系统/`.pi`）。`@resvg/resvg-js` 是未安装的可选渲染器，经变量说明符动态加载，缺失时 `read_svg_image` 如实答 `unsupported`。KaTeX/marked 打进 bin.js 与 SPA，其 MIT 声明由 copy-assets 写入 `dist/THIRD-PARTY-BUNDLED-NOTICES.txt`（及 `dist/web/`）；其余被打包的 MIT/ISC 依赖（hono、zod、react 等）尚无逐包声明，是已知缺口。tarball 内容策略在 `packages/app/scripts/pack-contents.mjs`（`pnpm --filter argelanderspace test` 覆盖其规则）；`prepack`（`scripts/check-pack.mjs`）对真实 pack 清单跑同一策略，`npm pack`/`publish` 违规即失败。`node packages/app/scripts/smoke-pack.mjs [--offline-lock pnpm-lock.yaml] [--private-net] [--mutate-default-loader]` 做本地 pack＋临时目录干净安装＋隔离 HOME/XDG 的会话/恢复/PDF 渲染/工具动作冒烟，**不属于四门**：子进程用环境白名单（临时 HOME/XDG/npm cache、空 npmrc）、安装一律 `--ignore-scripts`、服务用 `--port 0` 并在任何写入前核对是自己的临时实例；它**不是**完全隔离——会读仓库、真实 corepack home，`--offline-lock` 还读（必要时可能写入索引）真实 pnpm store；`--private-net` 在新网络命名空间内整体运行；`--mutate-default-loader` 是对照（改临时安装副本使用 Pi 默认 resourceLoader，诱饵检查应变红，退出码 1 为预期）。无网络时 `--offline-lock` 用仓库 lockfile 固定版本从本机 store 安装，因此不验证 registry 对依赖范围的重新解析。`npm pack` 默认把 tarball 写进当前目录；用 `--pack-destination` 指向临时目录，产物不入库（`packages/app/*.tgz` 已忽略，旧的被跟踪 tgz 按用户签收移除）。
- **许可证检查与 Mail 声明（Mail 票 10）**：新增或升级依赖后运行 `node scripts/license-scan.mjs [--list] [--root <dir>]`（离线、只读；先 `corepack pnpm install`；已纳入 biome lint；测试 `packages/app/scripts/license-scan.test.mjs` 用临时 lockfile＋假 `.pnpm` 目录覆盖退出码）。它读 `pnpm-lock.yaml` 的依赖闭包（生产：各 workspace 包 dependencies/optionalDependencies 的传递闭包，同 name@version 的 peer 变体合并边，解析 `alias: real@ver` 别名；dev 单列）与 `node_modules/.pnpm` 里各包 package.json 的 license 字段。SPDX 表达式按 OR < AND < WITH 优先级与括号求值（AND 任一不可接受即不可接受，OR 取可接受分支；`X WITH 例外`一律 unknown，除非显式列入）。
  - **生产闭包是允许清单**：MIT、MIT-0、ISC、BSD-2/3-Clause、Apache-2.0、0BSD、Unlicense、CC0-1.0、BlueOak-1.0.0、OFL-1.1（字体）；清单外一律 unknown（退出码 1），新增须人工判断后改脚本清单。**dev 闭包是禁用清单**，清单外的非常见许可（MPL、CC-BY 等）列出供人工看。
  - **禁用**：GPL、AGPL、LGPL、仅 EUPL、SSPL、BUSL、非商业（CC-BY-NC 等）、商业/源码可见（Elastic、Commons Clause、PolyForm、UNLICENSED、SEE LICENSE IN）；禁用版本：imapflow 1.0.28–1.0.63（曾 AGPL）、nodemailer 3.x（曾 EUPL），生产与 dev 闭包都检查；禁止依赖**或复制代码**：EmailEngine（商业源码可见）、Mailspring / Mailspring-Sync（GPL-3.0）、Nylas sync-engine（AGPL）、Inbox Zero（AGPL）。**复制源码类扫描发现不了，只能靠评审。**
  - **退出码**：0 干净；1 有禁用/未知/清单外/禁用版本；2 缺锁文件或 `node_modules/.pnpm`（什么都没检查）。锁文件里的包若本机没装，只有 lockfile 声明 `optional: true` 且带 `os`/`cpu`/`libc` 限定者才作“平台可选包”豁免（列出名单，license 未检查）；其余缺失计 unknown。
  - 当前选择：`@zone-eu/mailsplit` `(MIT OR EUPL-1.1+)` 选 MIT，`dompurify` `(MPL-2.0 OR Apache-2.0)` 选 Apache-2.0。已知局限：只信 package.json 的 license 字段，不核对 LICENSE 文本是否一致，不扫描包内嵌的第三方代码；未安装的平台包的 license 由人工核（记录见票 10）。
  - **发布包声明**：`packages/app/scripts/copy-assets.mjs` 生成 `dist/THIRD-PARTY-MAIL-NOTICES.txt`（及 `dist/web/`，已列入 pack-contents 必需文件）。根为 infra 的 dependencies（去掉 workspace 包与 `@napi-rs/keyring`，新增依赖自动纳入；因此也含 smol-toml）加 web 的 dompurify，取传递生产闭包；keyring 经 app 的 require 解析，作为外部运行时依赖单独声明。取舍：tsup 内联的精确集合需要把 metafile 放进发布的 dist/，故**整闭包声明并标“dependency closure (may be partially inlined)”**（多声明少于漏声明），不声称每项都内联进 bin.js。许可证不在构建内允许表（MIT、MIT-0、ISC、BSD、Apache-2.0）内时构建失败，须人工决定后再改 `mailAllowed`/`mailElected`。katex/marked 另见 `THIRD-PARTY-BUNDLED-NOTICES.txt`；其余内联的 hono、zod 等仍属上条所述已知缺口。
- Writer 内置模板为 contracts TS 单源，不按旧 Stage 10 方案寻找 dist/templates/*.json。稳定 latexmk 缓存须保未变文件 mtime；显式刷新仍让 latexmk 核系统依赖，不能以 main.tex hash 相同直接返回旧投影。

## 桌面壳（desktop-app 票 20）

`packages/desktop/` 是 Tauri 2 的 Rust 工程，不是 pnpm 包，**不进四门**（硬契约见 [contracts](contracts.md)）：`pnpm -r` 不碰它，biome 排除 `packages/desktop`，`target/` 与 tauri-build 生成的 `gen/` 被 `.gitignore` 忽略。机制见 [architecture](architecture.md#桌面壳desktop-app-票-20)。

- **前提**：Rust（`~/.cargo/bin` 的 cargo/rustc，本机 1.96）；Linux 上 `libwebkit2gtk-4.1-dev` 与 `libgtk-3-dev`；首次构建从 crates.io 下载依赖。开发形态的壳运行仓库里构建好的 `packages/app/dist/bin.js`，所以先 `corepack pnpm -r build`；node 取 `PATH` 上的（本机 v24）。
- **构建与测试**（在 `packages/desktop/` 下）：`cargo build`（调试版，产物 `target/debug/argelanderspace-desktop`）、`cargo test`（行协议解析与按上限读行、退出后的决定与崩溃对话框的状态机、窗口建不出来与被拦的导航、壳的日志文件与级别、单实例与 socket 归属、启动参数与宿主的进程组）。另可 `cargo clippy --all-targets`（也带 `--features smoke-probe` 跑一次）与 `cargo fmt --check`。打包（`tauri build`、deb/AppImage）是票 23。
- **运行**：`packages/desktop/target/debug/argelanderspace-desktop`。它会读写你真实的全局目录（配置、最近项目、日志）并按最近项目打开真实的 Project；只想看看壳时用下面冒烟的隔离环境（临时 `HOME`/`XDG_*`、`XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS` 指向不存在的 socket，只保留 `DISPLAY`/`XAUTHORITY`）。单实例的 socket 在 `$XDG_RUNTIME_DIR` 下，所以隔离环境里的壳与真实会话里的互不影响。
- **测试构建**：`cargo build --features smoke-probe` 多出一个只用于冒烟的探针：每次页面载入后在页面里跑一段固定脚本（有没有 `__TAURI__`、`__TAURI_INTERNALS__`、`window.ipc`、Tauri 命名的全局量、WebKit 的 `ipc` 消息处理器，试一次 `invoke` 与一次裸 `ipc://` 请求），把结果追加到 `ARGELANDERSPACE_SHELL_PROBE` 指定的文件；`ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1` 时不去掉 Tauri 的入口，用来证明调用本身也被拒。`ARGELANDERSPACE_SHELL_PROBE_NAVIGATE=<地址>` 时页面随后试着导航到那里并报告片刻之后自己在哪（验证导航被拦）。票 21 加：`ARGELANDERSPACE_SHELL_PROBE_CONTROL=<文件>` 时壳读这个文件里追加的行——`menu <id>` 等同点了那个菜单项，`js <脚本>` 在页面里运行并把结果以 `{"js":…}` 追加到探针文件，`devtools?` 追加开发者工具是否打开；`ARGELANDERSPACE_SHELL_PROBE_SAVE_TO=<目录>` 时页面的下载不弹保存对话框、直接存到那里（用来核对文件内容；对话框本身另测）。它与普通构建共用 `target/debug/` 下的同名产物，冒烟后重新 `cargo build` 一次。发布构建不得带这个 feature：`--release` 带它编译不过（`compile_error!`）。
- **升级 tauri / wry 之后必须重跑探针冒烟**：`page_guard.rs` 去掉 Tauri 入口的做法依赖 wry 0.57 放入脚本的方式（WebKit 用户脚本与 `ipc` 消息处理器）；升级后它可能静默失效，只有探针在页面里的检查（下条自动冒烟里页面内的 Tauri 入口检查与入口保留时 `invoke` 被拒的检查）能发现。
- **自动冒烟**：私有 `.scratch/desktop-app/checks/20/scripts/run.sh <临时目录>`（构建探针版与一个只发 `WM_DELETE_WINDOW` / `_NET_ACTIVE_WINDOW` 的 X 小工具，再跑 `smoke.sh`）：隔离环境、合成文件夹、假的 `xdg-open`（只记录被要求打开什么）、真实显示器。覆盖：首次启动欢迎页与上次文件夹不在；页面里没有 Tauri 入口；第二次启动不另开窗口（「提到前面」本身要人看）；单实例 socket 的归属（第二次启动不删第一个壳的 socket 文件、关窗退出后删去、占着位置的不是本用户的 socket 时不动它）；页面导航到本地地址以外被拦；宿主独占进程组、关窗限时到后连同它的子进程一起被强制结束；四种原生请求与选文件夹对话框（关掉即取消）；打开最近项目后壳以 `--project` 起下一个宿主、窗口换成新页面；切换目标在两次启动之间消失时回到欢迎页、不弹崩溃对话框；杀宿主出现崩溃对话框、关掉它即退出；杀壳后宿主自行退出、端口释放；关窗后宿主收到 `quit`、端口释放；入口保留时 `invoke` 被拒；壳的记录里没有路径与文件夹名；结束时隔离环境里没有残留进程。截图用 `import -window`，截图前先把窗口提到前面，截完人工看一遍只有合成数据。
- **票 21 的自动冒烟**：私有 `.scratch/desktop-app/checks/21/scripts/run.sh <临时目录>`（同票 20 的隔离环境与 X 小工具，小工具多一个 `key`：用 XSendEvent 只向壳自己的窗口发一次按键，隔离环境设 `GDK_CORE_DEVICE_EVENTS=1` 让 GTK 收这种核心按键事件，只用于测试）。覆盖：桌面形态没有装饰性窗口按钮；`target=_blank`、`window.open`、主窗口站外导航三种外链经假 `xdg-open` 记录、窗口仍在本地页面且只有一个窗口，`file:`/`mailto:` 不交出；菜单「在浏览器中打开」「开发者工具」（菜单项与 F12）「关于」（中文、改配置后英文，版本等于 CLI `--version`）「打开文件夹…」（菜单项与 Ctrl+O）；最近项目菜单项切到另一个 Project；保存对话框（起始于下载文件夹、页面给的文件名、3 秒后按 Return 保存内容完整；关掉即取消、不落任何文件）；设置页导出诊断包（真实按钮，桌面文案，探针直存后解包核对）；日志里没有地址与文件名；结束时无残留进程。
- **手动冒烟清单**（本机没有输入注入工具，以下要人操作；在隔离环境或一个可丢弃的 Project 上做）：
  1. 首次启动（空的全局目录）见欢迎页；点「打开文件夹…」，系统对话框里选一个空文件夹 → 窗口换成该 Project 的工作台。
  2. 再次启动应用（双击或命令行）→ 不出现第二个窗口，已有窗口被提到前面（最小化时恢复）。
  3. 设置页「打开其他文件夹…」与最近项目各切换一次 → 窗口显示新 Project；有运行中的任务时先出切换提示（票 19）。
  4. 「打开配置文件」「显示日志文件夹」（设置页与诊断分组）→ 系统编辑器 / 文件管理器打开对应位置；配置文件还不存在时页面浮层说明还没有配置文件、改任何一项就会建立，不发请求、不建文件。
  5. 关窗 → 应用退出，`ss -ltn` 上端口释放，没有残留的 `desktop-host` 进程。
  6. `kill -9` 宿主 → 崩溃对话框；分别试「重新启动」（回到同一 Project）、「显示日志文件夹」（打开后对话框再出现）、「退出」（应用退出）。
  7. `kill -9` 壳 → 宿主几秒内自行退出、端口释放。
  8. 在页面上右键「检查元素」或按 F12 打开 Web Inspector（票 21 起发布构建也带开发者工具），控制台里 `typeof window.__TAURI_INTERNALS__`、`typeof window.ipc` 都是 `"undefined"`，`window.isTauri` 不存在。
  9. 日志目录里能看到 `shell.*` 记录（宿主日志里或 `*-shell-<pid>.jsonl`），没有路径与文件夹名。
  11. 票 21：真的用鼠标点菜单各项（最近项目子菜单、灰掉的不存在条目点不动）；在 Reader 里点 DOI 链接（`target=_blank`）与 PDF 内嵌链接（`window.open`）→ 系统浏览器打开、窗口不变；PDF 原件下载、Writer 稿件导出、诊断包导出各存一次（保存对话框里换个位置、覆盖已有文件时的确认、取消）；发布构建（`cargo build --release`）里 F12 能打开开发者工具；把磁盘写满或选只读目录时的「没能保存文件」对话框。
  10. 02 探路列出的未验证项（中文输入法、原生下拉、文件选择框、剪贴板、右键菜单、触控板手势、窗口缩放与多显示器）在用户终验里看。

## 兼容实现：仍有实际作用

- core 的 pyOr/pyTruthy/pyRe 保留有意移植的 Python 真值/Unicode 词边界语义；退出重构期不等于这些防御语义都是死代码。
- `core/src/acquire/latexenc-data.ts` 是 bibtexparser 1.4.4 的 2394 对机械替换表，勿手改；`@retorquere/bibtex-parser` 10.0.1 发布缺声明，本地最小类型在 core/src/types/bibtex-parser.d.ts。
- sources 缓存键通过 infra/lib/pyjson.ts 字节复现 `sha1(path + "?" + json.dumps(params, sort_keys=True))`（ensure_ascii/分隔符），存量缓存复用依赖此派生，不因旧 Python 删除而更换。（2026-10-14 局部修订，desktop-app 票 11。旧定位：Crossref / OpenAlex 的 params 含 `mailto`〔当时写死的地址〕。新结论：这两个来源的新键的 params 不含联系邮箱；新键查不到且设了联系邮箱时，再按「params 加当前邮箱作 `mailto`」的旧键〔派生逐字节同上〕查一次，命中则按新键另存一份、旧文件不删；没设联系邮箱时不查旧键。源码里不写任何地址。ADS 的键不变。原因：联系邮箱改为用户自己的可选设置，答复与邮箱无关，换地址不该丢缓存，又要让既有缓存继续命中——用户 2026-10-14 裁决「新键加旧键回退」。机制见 `infra/src/sources/cache.ts` 的 `readKeyed`。）
- `statSync(p).mtimeNs` 在普通 stats 不存在，须 `{bigint:true}`；PaperCache/watcher 指纹依赖它。
- canonical annotation text 在 **contracts** 而非旧 roadmap 字面的 core：web runtime 只依赖 contracts，需要共享纯函数。这是落地位置修订，不是 bug。

## 用户数据操作与迁移教训

历史迁移不是现在可直接执行的操作授权。未来若获批迁移：先备份、记录回滚，再变更；检查 note/label/star/read/tags 等用户字段与 doc 引用，不靠总数断言安全。

- Stage 5/6/7 用 tarball 备份、缓存离线重摄入、library build、元数据 parity 和零悬空 doc_ids；验收后备份已删，不能按旧日志假定 tarball 还在。
- works 数变化未必 drift：Stage 5 Palomar 正典 work 显现、Stage 6 battery 首次播种都有来源；须逐条解释，不强制复制旧数字。
- 2607.17040 修 email 签名后垃圾段消失导致 block id 级联；去垃圾后逐 token 正文一致，refs 88 不变，已归因非回归。
- **Stage 8 后迁移还必须考虑 annotations**：同指纹保留，不同归档、无法算指纹不碰。旧迁移“清 JSON+assets”的一次性脚本不能无条件复用；不要直接操作真实库做探针。
- `literatures/` 不是整体 gitignore；Stage 8 专门补 annotations/ 规则。不要因历史文字声称“全忽略”而盲目 git add；status/、备份规则也需实际检查。
- 不把 `/tmp` 原型、临时备份、截图当持久回滚源。texToHTML 原型曾可能只有 /tmp 孤本，找不到应问用户是否有备份，而不是声称现存。

## Writer 依赖与调研勘误

- 本机安装的模板依赖不等于随包可分发或其他环境已具备。许可未核清的 aa.cls/aa.bst 不随 npm 分发；不绕过 TLS 解决下载证书问题；补模板文件也不等于旧摄入失败已修。具体本机版本/hash 与历史访问结果留私人环境记录。
- 原网络 child 因 unavailable tools（fetch_content/get_search_content/source_check）失败，顶层 complete 不代表全调查成功；用户明确授权父代理直接核官网后才补齐证据。不能照抄 partial 报告或悄悄换 runner。
- 已纠正的关键调研误判：Texifier 外部引擎支持 auto-typeset，并非仅内嵌 live 引擎能自动；CM/stex 高亮不含语义补全；存在 LaTeX Workshop MIT snippet 数据但非 CM 即插即用；KaTeX 支持 tag/tag*，Writer 旧无号不能归咎库不支持。GPL/AGPL 的内联/进程/聚合分发不同，不能笼统说任何复用都改整个项目许可。
- 有限 make4ht 合成探针曾证明 natbib HTML 可行；mathjax 选项却缺真号/有 CDN 依赖，源码行注释不证明 cell 映射。探针不是选型理由；该默认路线已由用户共享 IR 决定替代。官方证据 URL/探针过程留原 writer-deps inbox 的 Git 历史，不继续当研究待办。

## 服务集成与真实浏览器探针

- 外部服务可用性必须有观测日期和环境；旧鉴权失败、免费配额或 provider READY 状态不构成当前可用性承诺。OCR 仍在封存分支，不将其凭据或旧配置字段恢复成 main 能力。
- ADS export 与 discovery 已有受测样本证据，见 [history](history.md)；这不替代当前操作前的必要核实。配置键以实际 schema 为准（包括 Stage 15 的 auto_ingest_arxiv），类型错点名键而不回显值。
- **真实浏览器探针教训（Stage 14）**：来源白名单现在按 server 实际绑定的端口逐请求判断（desktop-app 票 05，`packages/server/tests/origin-guard.test.ts`），`createServer` 用 `port: 0` 时同源 POST 与 `/ws` 都放行，探针不必再先用 net 探空闲端口（Stage 14 时白名单只含写死的端口与传入的 `0`，同源 POST 会 403）；直接用 `createApp` 而不起 server 的测试要自己经 `boundPort` 给出端口，否则只放行开发来源。合成 PointerEvent 无活跃 pointerId，`setPointerCapture` 会抛（GraphCanvas 已加 try/catch 防御）；shell 默认落地是计划页，探针须先点文献 nav；`Runtime.evaluate` 取值为 `result.result.value` 双层嵌套。
- **探针教训（Stage 15）**：点按文本需子串+最紧匹配（导入菜单项是嵌套 span，精确 textContent 永不命中）；job 断言按 `payload` 过滤，不能按 jobs 目录 readdir 顺序（不按时间）；server 探针要在 import server 前把 `XDG_CONFIG_HOME` 指到隔离目录（`getConfig()` 现读真实 config）。**交互调试先验后端再疑前端**：真实库 API 直调先验证 work 创建与 job 提交，再排 UI 选择器。
- **infra `ingestTexSource` 的 `fetchImpl` 曾声明不透传**（Stage 15 修复）：ArxivFetcher 构造丢了该选项，stub 测试会静默走真实网络；端口参数要核实确实传到实现。Stage 15 确认 `ArxivFetcher` `useCache:false` 语义即「不读缓存、下载成功覆写」（Stage 15 恒新鲜下载复用此路径，零改动下载器）。
- **web 测试 mock 单 listener 限制**：`vi.mock` 的 ws 模块只捕捉一个 `onJobEvent` 回调时，组件内第二个订阅会顶掉第一个（Stage 15 曾因此打断 upload 进度测试）；RefDetail 的 job 订阅合并为单个按 kind 路由（现在 `library/work-jobs.ts` 的 `useWorkJobs`，票 48）。组件多次订阅是真实 ws 支持的，但测试 mock 要幺支持集合、要幺组件合并订阅。`packages/web/src/api/ws-bus.ts` 的 `createFakeBus()` 用真实分发表（`emit(type, msg)`），以后用它逐步替换手写 ws mock。
- **Stage 15 验收规模**：四门全绿（build/typecheck/lint；test **1216 passed + 1 可选 skip**——Stage 14 基线 1173+1）；真实 Chrome + 真实网络探针 **26/26**（真实 arXiv 下载编译、真实 ADS、失败重试与 JSONL 日志断言，/tmp 脚本临时证据，关键结论见 session inbox F4）。
- **摘要显示**：文献/探索摘要不是 Markdown——provider HTML 白名单清洗 + 文本节点 KaTeX（`web/src/lib/abstract.tsx`），texmath 边界与 mdWithMath 同规则；不要再把 ADS 摘要当纯文本直渲。
- Git 凭据环境解法不是 push 授权；历史登录状态需重新核实，不把具体凭据或完整敏感日志写进公开文档。
- 日常文献技能验收曾用 `pi -nc` 排除开发仓库 context 污染；这是历史手动方法，不是开发 session 跳过现行硬契约的许可。
