# 工程指南与验证教训

2026-09-21 从 `46093915:.pi/memory/engineering.md` 迁移。这里保留不易从配置看出的惯例、陷阱和证据范围；历史验证不代表本次重测。原始本机依赖、凭据位置与外部服务观测保留在私有 `.scratch/memory-migration/local-environment.md`，不作为新机器环境保证。

## 运行与验收

- 本机 Node v24+ / npm 11+；项目 pnpm 11.24.0，经 **`corepack pnpm`** 调用，裸 pnpm 不在 PATH。Node 的 pnpm 下限历史记录为 ≥22.13，本项目环境仍以 v24+ 为工作基线。
- 常规代码验收四门以 [AGENTS.md](../AGENTS.md) 的工程入口为准。无 per-package lint，不用 `-r lint`。纯文档迁移做保真/引用/范围检查，不默认重跑产品四门。
- TeX Live 全家在 `/usr/bin`：latexmk/pdflatex/xelatex/bibtex/biber，是摄入前提；真编译测试 `HAVE_LATEXMK` 类 gating，缺工具会 skip，不能把 skip 当实测通过。
- 图转换可选依赖 poppler-utils（pdftocairo）与 ghostscript（gs，EPS）；不再需要 pandoc/mupdf/dvisvgm。不要把整个 astro conda bin 前置 PATH，它的 node v20 会抢系统 node；旧 pandoc shim 无需重建。
- repo CLI 可跑 `node packages/app/dist/bin.js`。app 包名是 `argelanderspace`，不是 `@argelanderspace/app`，pnpm filter 勿写错。
- 无 CI 是截至 Stage 8 的工程观测，不因后续记忆未提及就冒充本次已重新核实。阶段历史里的独立审查/自动 commit 授权已结束；当前审查与工具治理按当次授权执行。

## 测试与前端验证

- 网络测试用 fetchImpl 注入离线 stub；config 测试 `$XDG_CONFIG_HOME` 指 tmp。spawn 测试 `HOME=<tmp>` 才能逼 ADS no-token；空 `ADS_DEV_KEY` 会被忽略并回退真实 key 文件。
- `--offline` 自 Stage 7 起 gate ADS/Crossref/OpenAlex，缓存仍可读。迁移声称离线仍应核实所走路径，不将 env 恰有 token 当测试前提。
- web Vitest ^3 与 Vite 5 配套，其余包 Vitest 4；独立 vitest.config 不加载 React 插件。happy-dom 全局 URL 不是 Node URL，读文件用 `node:url` 的 fileURLToPath；IntersectionObserver 需 stub。
- happy-dom 无布局：rect/selection/scroll 相关测试“绿”不能证明真实像素正确。Stage 8 selbar-y 钳制测试零 rect 恒过，真实 Chrome 双轴探针才是证据。测试局限不是产品缺陷。
- SVG 忠实性真值：pdftoppm 位图 + 真实 Chrome 截图；不要用 ImageMagick MSVG 作裁判，其渲染器也会丢特性。
- **真实 fixture 必须覆盖文字、内嵌位图、尺寸**：glyph use、image 存在及 viewBox 对 pdfinfo。三角 stub 曾放过 dvisvgm 真实图丢全部文字/位图，不能重走该路线。现 infra `fig-text.pdf` / `fig-imshow.pdf` / `fig-text.eps` 回归覆盖。
- Stage 8 证据：offset round-trip 2080 组、web/CLI 标注排序 500 轮对拍、真实 Chrome 选区/重叠/归档/删除探针；这是历史验证范围，不是对所有浏览器/构造的全称保证。临时截图与 raw-CDP 脚本不保证仍存在。
- reader epoch 真浏览器验证必须真实替换 IR/正文/图，不能只变 fingerprint mock；正常合成 zip 上传→latexmk→job.done→自然 library.changed 才证明真实通知链。CDP composition 不等于 OS 输入法，fetch 取消也不穷举 decode/onLoad 全时序。最终 17 个受测用例通过的范围与局限在历史原文，不抹掉中途失败。
- Stage 11 有 65 组合成 citation 与 PDF/pdftotext 对拍及发布包真实 Chrome/CDP 证据，**不推翻用户 Report citation 未通过**。四门绿、合成 smoke、用户 smoke、阶段关闭是不同结论。
- Stage 12 四门 1066 passed + 1 可选 skip；真实 Chrome/CDP 探针验证显式渲染（打开/输入/暂停 0 编译、Shift+Enter 恰好 1 次、Render 按钮有效），导出 zip 产物 latexmk 自编译 EXIT=0；用户 smoke 通过，I030/I031 关闭。CDP 教训：`Runtime.evaluate` 的 returnByValue 不能序列化 DOM 节点（waitFor 表达式需 `Boolean()` 包裹）；点击类 evaluate 返回值序列化偶发 -32000，用效果断言代替调用成功。IME 全角逗号是真实用户输入风险，按 Stage 12 决定属用户语法责任（I034）。
- **latexmk 稳定缓存在编译失败后曾死锁**：“Nothing to do”+“previous invocation error”，坏 bbl 阻断 bibtex 重跑；Stage 12 起 compileTex 失败路径清理 aux/bbl/blg/fdb_latexmk/log（输入不动），下次编译自愈。
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

## Web i18n 维护

Stage 9 已关闭。`i18next 26.4.2` + `react-i18next 17.0.14`，MIT；`src/locales/zh-CN.json` 是 key/中文源，`en.json` 同层级 key/插值对拍。`src/i18n.ts` 初始化，`i18next.d.ts` key 类型增强曾用错误 key 负例验证。纯 JSON、每语言单文件，不按域拆 i18next namespace；`writer.*` 是域 key 而非新 loader。

- 英文语义域 key、`{{var}}` 整句命名插值；条件分支留代码、拆 key；枚举在渲染期取 t，不能模块初始化固化语言。
- Tweaks 的 `argelander.tweaks` localStorage 存 language；默认 zh-CN，不用 languagedetector，changeLanguage 同步 html lang，无刷新。language 类型可选是当轮保持旧 fixtures 不动的实现兼容，实际默认有兜底。
- Intl：zh 保原 `M月D日`/`YYYY年M月`，en 用 en-US 短月；有日期恒等回归。index.html 静态 zh-CN，title ArgelanderSpace 不变。
- `no-hardcoded-copy` 扫 src ts/tsx 中文（含注释），白名单已空；locale-parity 检 key/插值。英文硬编码靠 review。Stage 9 既有 12 份中文断言测试零改动是迁移证据，不是永不准改测试的契约。
- Stage 9 安装曾机械增加 react-i18next 的 minimumReleaseAgeExclude；不是以后依赖可任意绕过供应链策略的授权。headless Chrome oklch 强调色探针误算是当轮工具局限，不作为产品颜色 bug。

## 打包与配置（不要当冗余清掉）

- **createRequire banner 必须保留**：esbuild 内联 CJS `ws` 后运行期 require(events)，移除 banner 实测启动炸。不是已删除的 cheerio/safer-buffer；tsup shims 只管 filename/dirname。
- **删除源文件后清相应 dist 再 build**：tsc 不清旧产物，app 曾把已删 raster.js 再内联回来。清理范围限生成 dist，不碰用户数据。
- **dist/argelander.sty 必须随 app 包**：bundle 内 import.meta.url 指向 app/dist，copy-assets.mjs 负责复制；缺失会静默干净编译、丢事件而不是崩溃。npm pack + 干净安装摄入需要验证 sty 存在且确有事件流。
- web-dist 查找：bundle 旁 web → cwd/packages/web/dist（dev）；静态 index/SPA fallback no-cache，hashed assets immutable，排除 stale bundle 验收干扰。
- CLI `.version(...)` 与 app package.json 两处手工对齐，没有版本单一来源。
- config.toml 使用 smol-toml，每次现读无缓存；未知键忽略，类型错点名键，不回显值。
- Stage 11 app 收集 20 个编辑器运行依赖 MIT notices；uiw 两个 npm 包缺 LICENSE，采用与官方 v4.25.11 原文逐字节一致的版本限定副本（packages/app/licenses）。升版本须重核，不能静默沿用旧版权。最终包曾离线安装验证 sty/web/notices 齐全，不含 aa.cls/aa.bst。
- Writer 内置模板为 contracts TS 单源，不按旧 Stage 10 方案寻找 dist/templates/*.json。稳定 latexmk 缓存须保未变文件 mtime；显式刷新仍让 latexmk 核系统依赖，不能以 main.tex hash 相同直接返回旧投影。

## 兼容实现：仍有实际作用

- core 的 pyOr/pyTruthy/pyRe 保留有意移植的 Python 真值/Unicode 词边界语义；退出重构期不等于这些防御语义都是死代码。
- `core/src/acquire/latexenc-data.ts` 是 bibtexparser 1.4.4 的 2394 对机械替换表，勿手改；`@retorquere/bibtex-parser` 10.0.1 发布缺声明，本地最小类型在 core/src/types/bibtex-parser.d.ts。
- sources 缓存键通过 infra/lib/pyjson.ts 字节复现 `sha1(path + "?" + json.dumps(params, sort_keys=True))`（ensure_ascii/分隔符），存量缓存复用依赖此，不因旧 Python 删除而更换。
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
- **真实浏览器探针教训（Stage 14）**：createServer 用 `port: 0` 随机端口时 guardCsrf 白名单不含实际绑定端口，同源 POST 403——探针须先用 net 探空闲端口再起 server；合成 PointerEvent 无活跃 pointerId，`setPointerCapture` 会抛（GraphCanvas 已加 try/catch 防御）；shell 默认落地是计划页，探针须先点文献 nav；`Runtime.evaluate` 取值为 `result.result.value` 双层嵌套。
- **探针教训（Stage 15）**：点按文本需子串+最紧匹配（导入菜单项是嵌套 span，精确 textContent 永不命中）；job 断言按 `payload` 过滤，不能按 jobs 目录 readdir 顺序（不按时间）；server 探针要在 import server 前把 `XDG_CONFIG_HOME` 指到隔离目录（`getConfig()` 现读真实 config）。**交互调试先验后端再疑前端**：真实库 API 直调先验证 work 创建与 job 提交，再排 UI 选择器。
- **infra `ingestTexSource` 的 `fetchImpl` 曾声明不透传**（Stage 15 修复）：ArxivFetcher 构造丢了该选项，stub 测试会静默走真实网络；端口参数要核实确实传到实现。Stage 15 确认 `ArxivFetcher` `useCache:false` 语义即「不读缓存、下载成功覆写」（Stage 15 恒新鲜下载复用此路径，零改动下载器）。
- **web 测试 mock 单 listener 限制**：`vi.mock` 的 ws 模块只捕捉一个 `onJobEvent` 回调时，组件内第二个订阅会顶掉第一个（Stage 15 曾因此打断 upload 进度测试）；RefDetail 的 job 订阅合并为单个按 kind 路由。组件多次订阅是真实 ws 支持的，但测试 mock 要幺支持集合、要幺组件合并订阅。
- **Stage 15 验收规模**：四门全绿（build/typecheck/lint；test **1216 passed + 1 可选 skip**——Stage 14 基线 1173+1）；真实 Chrome + 真实网络探针 **26/26**（真实 arXiv 下载编译、真实 ADS、失败重试与 JSONL 日志断言，/tmp 脚本临时证据，关键结论见 session inbox F4）。
- **摘要显示**：文献/探索摘要不是 Markdown——provider HTML 白名单清洗 + 文本节点 KaTeX（`web/src/lib/abstract.tsx`），texmath 边界与 mdWithMath 同规则；不要再把 ADS 摘要当纯文本直渲。
- Git 凭据环境解法不是 push 授权；历史登录状态需重新核实，不把具体凭据或完整敏感日志写进公开文档。
- 日常文献技能验收曾用 `pi -nc` 排除开发仓库 context 污染；这是历史手动方法，不是开发 session 跳过现行硬契约的许可。
