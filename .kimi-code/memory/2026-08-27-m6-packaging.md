# M6（非破坏部分）完成：单包 bundle + config.toml + LICENSE + README 重写（2026-08-27）

决策 #21/#22/#23 落地。Python 树**未动**（删除在用户人工冒烟后单独做）。验收全绿：`corepack pnpm -r build|test|typecheck|lint`；测试 contracts 17 + core 78 + infra 90 + server 65 + cli 12 = **262**（M5 的 241 + 21 条 config 新测）。

## 单包 bundle（决策 #22）：`packages/app`

- 新 workspace 包 `packages/app`，名字独占 **`argelanderspace`**（根 package.json 改名 `argelanderspace-workspace` 让位；根仍 private，不发布）。version 0.1.0，license MIT，bin `./dist/bin.js`，files 仅 `dist`。
- **tsup 单文件 ESM bundle**（`dist/bin.js`，4.4MB）：cli+server+core+infra 及全部 npm 依赖内联。技巧：workspace 包放 **devDependencies**（tsup 只自动 external `dependencies`/`peerDependencies`），`dependencies` 只留 `mupdf: 1.28.0`（精确锁，决策"版本钉死"）。
- **mupdf 必须 external，两条独立理由**：① 其 WASM loader 用 `import.meta.url` 定位 `mupdf-wasm.wasm`（emscripten `new URL("mupdf-wasm.wasm", import.meta.url)`），inline 后 URL 指向 bundle 文件、旁边没有 .wasm 必挂；② mupdf 是 **AGPL-3.0**（Artifex），作为独立 npm 依赖安装与我们 MIT 包的关系同 Python 版依赖 PyMuPDF 一致；inline 进 MIT tarball 才是许可事故。README License 节已写明。
- **esbuild CJS→ESM 坑**：`safer-buffer`（cheerio 的 iconv-lite 链）用 eval 藏 `require("buffer")`，esbuild 静态改写不了 → 运行时 `Dynamic require of "buffer" is not supported`。tsup `shims: true` **只**注入 `__filename/__dirname`，不管 require；必须自己加 banner：`import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`（esbuild 的 `__require` shim 检测到顶层 `require` 存在就会用它）。`ws` 的可选原生依赖（bufferutil 等）动态 require 在 try/catch 里，有真 require 后走 JS fallback，正常。
- web SPA：`scripts/copy-assets.mjs` 把 `packages/web/dist` 拷到 `dist/web`；server 的 `resolveServerConfig` web-dist 候选改为 **`<bundle文件>/web`（import.meta 相对，packed 布局）→ `<cwd>/packages/web/dist`（repo dev）**，pre-M5 的 `web/dist` 候选已删（M5 leftover 清账）。app 对 `@argelanderspace/web` 的 devDep 纯为 `pnpm -r build` 拓扑排序。README.md/LICENSE 也由该脚本从根拷入（npm 只 auto-include 包根的文件；两份拷贝已 gitignore）。
- 版本号：CLI `.version("0.1.0")` 与 app package.json 手工对齐（无单一来源，改动时两处一起）。

## config.toml（决策 #23）

- `packages/infra/src/config.ts`：`configFilePath`（**XDG_CONFIG_HOME 优先**，空值视为未设，否则 `~/.config`）/ `parseConfigToml` / `loadConfigFile`（ENOENT→{}，其他读错误/malformed→`ConfigError` 带路径，**从不回显值**）/ `getConfig()`（每次现读磁盘，无 memo——一次小同步读，不值得缓存+失效钩子；测试用 `$XDG_CONFIG_HOME` 指向 tmp 密封）。
- **TOML 库选 smol-toml@^1.8**：零依赖纯 ESM、全 spec；手写"平坦子集"解析器在字符串转义上迟早踩坑。bundle 时被内联。
- 键：`data_dir`(string) / `port`(int 0–65535) / `mineru_api_key` / `openalex_api_key` / `ads_dev_key`（全可选；**未知键忽略**——前向兼容；已知键类型错→报错点名键名）。
- 优先级一律 **flag > env > config > 默认**。接线点：`resolveDataDir`（cli）、`resolveServerConfig`（server，新增第 4 参 `config`，可注入）、`mineruApiKey(env, config)`、`readAdsToken(env, home, config)`（链：env > config > `~/.ads/dev_key`）、`OpenAlexClient`（`opts.apiKey ?? $OPENALEX_API_KEY ?? config`）。env 名未动。
- **测试密封性**：用户本机很快就会有真 config 文件——会读盘的默认参数路径上的既有测试已加固：`mineru.test.ts` missing-key 测试 pin 空 XDG；`sources.test.ts` readAdsToken 传显式 `{}`。新测：infra/tests/config.test.ts（12）+ server/tests/config.test.ts（6）+ cli/tests/config.test.ts（3）。

## 打包冒烟实录（tarball + 安装全在 /tmp，未入仓）

```
cd packages/app && npm pack --pack-destination /tmp/...   # 66 files, 2.1MB / 7.1MB unpacked
npm install --prefix /tmp/.../install <tarball>           # added 2 packages (argelanderspace + mupdf)
```

- `--help` / `--version`(0.1.0) ✓
- `serve --port 0`：`/api/papers` 200 ✓；`/` SPA 200 含 `<title>ArgelanderSpace</title>` ✓（serve 日志 `web dist: .../node_modules/argelanderspace/dist/web` 证明 import.meta 候选生效）；SPA fallback `/library` 200 ✓；WS `{"type":"hello","jobs":[]}` ✓；SIGTERM exit 0 ✓
- config 优先级（packed bin 实测）：config port 8123 → env 8124 → flag 8125；config `data_dir` 生效（jobs/ 落在配置目录）；malformed TOML → exit 1 + `error: invalid TOML in <path>/config.toml:` ✓
- **mupdf WASM（最大打包风险）**：ingest born-digital fixture `2603.03522.pdf`，种 `<outDir>/mineru/content_list.json` 缓存（literal 名，cache probe 才命中——uuid 名不命中是 bug-for-bug 保留），MINERU_API_KEY 擦除、key 由 config.toml 的 `mineru_api_key` 供给 → exit 0，summary `textfix: repaired 35/43 ?-gaps`（mupdf 文本层/textfix 实跑）、`crossrefs 29 (21 resolved)`（mupdf 链接采集实跑）✓
- latex fixture ingest（pandoc 在 astro env bin，加 PATH）exit 0 ✓

## 留给用户/后续

- **repo URL 占位**：packages/app/package.json `repository.url = git+https://github.com/<you>/argelanderspace.git`——发布前改真地址。
- **LICENSE 版权人占位**："ArgelanderSpace contributors"，2026——可改真名。
- **npm publish 未做**（任务禁止）；发布动作 = `cd packages/app && npm publish`（包非 scoped，默认 public）。
- Python 树删除（M6 破坏部分）待人工冒烟后；删时可一并清 AGENTS.md 的 Python 环境条、`.gitignore` 的 Python 段。
- 已知不一致（接受的 drift）：cli 包 version 字段仍 0.0.0（private 无所谓）；CLI `--version` 与 app version 手工对齐。
