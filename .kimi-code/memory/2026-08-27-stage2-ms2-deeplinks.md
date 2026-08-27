# Stage 2 / MS2 完成：web 阅读器深链接（2026-08-27）

实现决策 8（`/doc/<id>#<anchor>` 四级锚点：doc / sec-N / fig-N·tab-N·eq-N·code-N·alg-N / ref-N）。全量验收绿：`pnpm -r build/test/typecheck/lint`（测试 323 → 334，web 新增 11 例——web 包此前零测试）。

## 设计

- **唯一新模块 `packages/web/src/lib/deeplink.ts`**（无 react-router，单路由手卷）：
  - `parseDocRoute(pathname, hash)` → `{docId, anchor} | null`（`/doc/<id>[/<trail slash>]`，percent-decode，畸形编码返回 null）。
  - `docRouteUrl(docId, anchor?)` / `replaceDocUrl(...)`（replaceState，清 query）。
  - `applyAnchor(store, anchor)`：**复用 chip 机制**——块/section 锚走 `store.jumpTo`（滚动+flash，同 xref chip）；ref 锚先 `jumpTo` 到第一个引用它的正文块（右栏卡片只在其引用块进入阅读带时才渲染），850ms 后再 `store.focusReference`（同 cite chip 的高亮）。未知锚返回 false，doc 照常打开。
- **Shell.tsx**：papers 加载后若有 `/doc/...` 路由 → `openDoc(docId, anchor)`（id 不在列表里也开，DocPane 404 显示正常 error 态）；否则维持旧的 `?doc=` 兼容 + 首篇逻辑。`popstate`/`hashchange` 监听重走路由（经 `openDocRef` 拿最新 openDoc）。URL 同步改为写 `/doc/<id>`：UI 切换论文清 hash；路由驱动的 openDoc 保留 anchor。
- **Workspace 扩展**：`openDoc(docId?, anchor?)`、`pendingAnchor`、`clearPendingAnchor`。
- **DocPane.DocWorkspace**：effect 消费 `pendingAnchor` → `applyAnchor`（此时 Reader 块已挂 DOM；同 doc 换锚也生效，因 effect 依赖 anchor）。
- **锚点 DOM id**：块/section 本就齐全（`id={b.id}` + `data-block-id`）；补了引用卡 `id={ref-N}`（RefCard，仅 citation 卡，避免与正文浮动体 id 重复）。scroll-margin-top 本就有（`.block` 16px / `.sec` 20px），补 `.refcard` 8px。
- **store.jumpTo 简化**：手算 delta+`root.scrollTo` 改为 `el.scrollIntoView({block:"start"})`（JUMP_PAD 删除，scroll-margin 顶替），与 RightPanel 的滚动方式统一，深链接与 chip 行为一致。

## 测试（`packages/web/tests/deeplink.test.tsx`，vitest 3 + happy-dom + RTL）

- parse/URL 单元 7 例；组件 4 例（golden `aa39341-20.json`，mock fetch）：`#fig-1`/`#sec-2` 断言元素存在且 scrollIntoView 以它为 target + flash 类；`#ref-6` 断言先跳 p-14（首个引用块）再 focus 右栏卡片；未知锚 `#fig-999` 照开不滚动。
- 坑：① vitest 4 要求 vite 6+，web 仍 vite 5 → web 用 **vitest ^3**（core 等维持 vitest 4，互不干扰）；② vitest.config.ts 独立于 vite.config.ts（不载 react 插件，esbuild 按 tsconfig `jsx: react-jsx` 转 JSX）；③ happy-dom 环境下全局 URL 是 happy-dom 的，node fs 拒收 → 用 `node:url` 的 `URL`+`fileURLToPath` 读 golden；④ IntersectionObserver 需 stub（一律报 intersecting 让右栏渲染全部卡片）。

## 手动验收已过

`node packages/cli/dist/bin.js serve --data-dir ./data --port 8041`：`curl /doc/aa39341-20` → 200 SPA index.html；`/` → 200；`/api/nope` → 404 JSON；bundle 含 `/doc/` 路由逻辑。

## 后续（MS3）

skills 三件套改写调 CLI、README 补 MinerU 配额风险、手动测试指南。深链接形态与 MS1 CLI 输出一致，可直接用 `read`/`show`/`ref` 打印的链接验收浏览器跳转。
