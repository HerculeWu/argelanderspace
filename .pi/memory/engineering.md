# 工程、环境与验证教训

整理：2026-09-13。环境结论取自已有验证，不代表每次启动已重探测；涉及当前外部服务可用性时保留观测日期。

## 运行与验收

- 本机 Node v24+ / npm 11+；项目 pnpm 11.24.0，经 **`corepack pnpm`** 调用，裸 pnpm 不在 PATH。Node 的 pnpm 下限历史记录为 ≥22.13，本项目环境仍以 v24+ 为工作基线。
- 常规代码验收四门：`corepack pnpm -r build`、`corepack pnpm -r test`、`corepack pnpm -r typecheck`、根 `corepack pnpm lint`。无 per-package lint，不用 `-r lint`。纯记忆整理做文档检查，不默认重跑全四门。
- TeX Live 全家在 `/usr/bin`：latexmk/pdflatex/xelatex/bibtex/biber，是摄入前提；真编译测试 `HAVE_LATEXMK` 类 gating，缺工具会 skip，不能把 skip 当实测通过。
- 图转换可选依赖 poppler-utils（pdftocairo）与 ghostscript（gs，EPS）；不再需要 pandoc/mupdf/dvisvgm。不要把整个 astro conda bin 前置 PATH，它的 node v20 会抢系统 node；旧 pandoc shim 无需重建。
- repo CLI 可跑 `node packages/app/dist/bin.js`。app 包名是 `argelanderspace`，不是 `@argelanderspace/app`，pnpm filter 勿写错。
- 无 CI 是截至 Stage 8 的工程现状，不意味着不需要本地验收。阶段历史里的独立审查/自动 commit 授权已结束；当前审查与工具治理按当次授权执行。

## 测试与前端验证

- 网络测试用 fetchImpl 注入离线 stub；config 测试 `$XDG_CONFIG_HOME` 指 tmp。spawn 测试 `HOME=<tmp>` 才能逼 ADS no-token；空 `ADS_DEV_KEY` 会被忽略并回退真实 key 文件。
- `--offline` 自 Stage 7 起 gate ADS/Crossref/OpenAlex，缓存仍可读。迁移声称离线仍应核实所走路径，不将 env 恰有 token 当测试前提。
- web Vitest ^3 与 Vite 5 配套，其余包 Vitest 4；独立 vitest.config 不加载 React 插件。happy-dom 全局 URL 不是 Node URL，读文件用 `node:url` 的 fileURLToPath；IntersectionObserver 需 stub。
- happy-dom 无布局：rect/selection/scroll 相关测试“绿”不能证明真实像素正确。Stage 8 selbar-y 钳制测试零 rect 恒过，真实 Chrome 双轴探针才是证据。测试局限不是产品缺陷。
- SVG 忠实性真值：pdftoppm 位图 + 真实 Chrome 截图；不要用 ImageMagick MSVG 作裁判，其渲染器也会丢特性。
- **真实 fixture 必须覆盖文字、内嵌位图、尺寸**：glyph use、image 存在及 viewBox 对 pdfinfo。三角 stub 曾放过 dvisvgm 真实图丢全部文字/位图，不能重走该路线。现 infra `fig-text.pdf` / `fig-imshow.pdf` / `fig-text.eps` 回归覆盖。
- Stage 8 证据：offset round-trip 2080 组、web/CLI 标注排序 500 轮对拍、真实 Chrome 选区/重叠/归档/删除探针；这是历史验证范围，不是对所有浏览器/构造的全称保证。临时截图与 raw-CDP 脚本不保证仍存在。
- biome web legacy override 关闭了部分格式/导入/a11y；不要对旧前端文件盲目 `--write` 全量重排。新代码保持 clean；parse 级错误不能靠 override 关闭，真实 HTML 夹具当年需 files.includes 排除。

### 交互回归教训

- 中文 IME Enter：提交处守 `isComposing`；原生 required 不在 form 内不形成有效守门，业务 valid guard 仍需测试。
- dnd-kit 拖动时指针下恒为被拖行：禁落 cursor/hover 反馈须打在被拖行及其子元素或 overlay，打目标组不可见。全局 button cursor 会覆盖继承值。
- 列表跨组“机制拒绝”不等于“用户感知拒绝”；需要变暗、禁落光标和 nudge，而非只静默回弹。
- jumpTo：平滑滚动途中的 instant 校正会被吞，scrollend 监听取消面曾元素错配造成 undo 后拽回。最终用 scrollTop 停稳检测，≤2 校正/≤8 re-arm；取消覆盖 wheel/touchstart/keydown/undo/新 jump。不退回固定定时器/scrollend 旧中间态。
- WS union 新增消息必须给 web dispatcher 显式分支；else 假定全为 job 事件曾在 Stage 4/8 打断编译。
- deeplink flake：先区分 effect flush（waitFor）与真正循环；Stage 8 openView 幂等 + mock 真正清 pendingAnchor 根治了无限 effect，不只加 timeout。
- 注入文件权限失败时 root 可绕过 chmod；file-where-dir 才可稳定模拟失败。

## 打包与配置（不要当冗余清掉）

- **createRequire banner 必须保留**：esbuild 内联 CJS `ws` 后运行期 require(events)，移除 banner 实测启动炸。不是已删除的 cheerio/safer-buffer；tsup shims 只管 filename/dirname。
- **删除源文件后清相应 dist 再 build**：tsc 不清旧产物，app 曾把已删 raster.js 再内联回来。清理范围限生成 dist，不碰用户数据。
- **dist/argelander.sty 必须随 app 包**：bundle 内 import.meta.url 指向 app/dist，copy-assets.mjs 负责复制；缺失会静默干净编译、丢事件而不是崩溃。npm pack + 干净安装摄入需要验证 sty 存在且确有事件流。
- web-dist 查找：bundle 旁 web → cwd/packages/web/dist（dev）；静态 index/SPA fallback no-cache，hashed assets immutable，排除 stale bundle 验收干扰。
- CLI `.version(...)` 与 app package.json 两处手工对齐，没有版本单一来源。
- config.toml 使用 smol-toml，每次现读无缓存；未知键忽略，类型错点名键，不回显值。

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

## 外部服务与凭据（带观测日期）

- **2026-09-01 MinerU**：401 `user authenticate failed` A0202；这是当时鉴权失败，不是永久状态。OCR 在封存分支，启用前自查 key/服务。旧免费配额约 1000 页/天也不是当前承诺。
- **2026-08-26 出版商反爬实测**：A&A DataDome、OUP Cloudflare、IOP Radware、APS Cloudflare，403/人机；ADS 扫描偶发 504。当前 main 唯一全自动远程正文源为 arXiv LaTeX，不把旧 HTML READY 当真实可达。
- ADS token `~/.ads/dev_key`；OPENALEX_API_KEY、旧 MINERU_API_KEY 曾在 `~/.zshrc`；main config 的活跃 keys 为 data_dir/port/openalex_api_key/ads_dev_key。不要声称已裁剪的 mineru config 键仍被 main 接受；不读取/记录实际秘密值。
- **git push 凭据历史教训**：HTTPS credential.helper=cache 无热凭据会报 cannot read Username；当时 gh 已登录，可用一次性 `git -c credential.helper='!gh auth git-credential' push origin main`，不落配置。该命令只是环境解法，**不是 push 授权**，当前登录需实际核实。
- 日常文献技能验收曾用 `pi -nc` 排除开发仓库 context 污染；这是历史手动方法，不是开发 session 跳过本记忆协议的许可。
