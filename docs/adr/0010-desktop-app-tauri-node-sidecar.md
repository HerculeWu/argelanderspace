---
status: accepted
---

# 桌面应用是 Tauri 壳加 Node sidecar，页面经本地 HTTP 加载

工作台以桌面应用的形式分发时，Tauri 只做外壳：开窗口、选项目文件夹、启停一个 Node 进程、菜单。这个 Node 进程运行的就是现有的本地 server，窗口里的页面直接从它的 `http://127.0.0.1:<端口>` 加载，与浏览器形态完全相同。业务逻辑不进 Rust，也不改走 Tauri 的进程间调用。

这样选是因为 server、CLI 和页面共用同一套 TypeScript 代码，其中 CLI 的输出与数据保护规则是冻结的契约。桌面应用若另走一条业务通道，这些规则就要在两处各守一遍。

用 Tauri 是用户在 Copilot 阶段（票 33）已定的方向，本决定没有重新比较 Electron。

## Considered Options

- 把前端打进 Tauri 的资源，页面经 Tauri 调用或跨源请求访问业务：server 的 CSRF 守卫只放行本地 HTTP 来源，自定义来源的写请求会被拒绝；放宽守卫或再造一套入口都会让桌面形态和浏览器形态分叉。
- 把业务逻辑搬到 Rust：CLI 与 server 共用的代码和冻结输出要维护两份。
- 把 server 做成单文件可执行（Node SEA、bun compile）：钥匙串原生模块、PDFium WASM 与 Pi SDK 都在 bundle 之外，`argelander.sty` 和页面资源靠相邻文件定位，走不通。桌面包因此自带 Node 运行时和一小份依赖目录。

## Consequences

- 系统 webview（WebKitGTK、WKWebView、WebView2）成为页面实际运行的引擎，而此前所有真实浏览器证据只来自 Chrome。用户决定不为此设验收门，问题随时反馈；“在浏览器中打开”指向同一个 server，是现成的退路，也是日常开发与找 `data-ui` 的主要方式。
- Rust 侧不放业务逻辑，桌面壳不进四门；新的业务功能不需要动 Rust，仍在 `serve` 加浏览器下开发和验收。
- 页面必须从本地 server 的 HTTP 地址加载，不能打进壳的资源里。
- 桌面应用没有有意义的当前目录，项目根由用户“打开文件夹”决定；CLI 仍以当前目录为项目根。两者用同一条相对路径规则找项目数据。
- CLI 输出的深链接指向配置的端口，所以桌面应用也用配置的端口；被占用时本次改用空闲端口并明确告知这些链接本次打不开。
- 关闭窗口即退出并优雅关停 server，单实例，不驻留托盘。
- TeX 不随包；没有编译沙箱的平台（macOS、Windows）上 Copilot 不触发编译，见 [writer](../writer.md)。（2026-10-16 由 [ADR 0011](0011-copilot-file-and-command-tools.md) 修订：后半句不再成立，没有编译沙箱的平台上 Copilot 也能触发编译；TeX 不随包不变。）

来源：2026-10-13 桌面应用设计访谈，用户对 Q2、Q3、Q20、Q24、Q32、Q35 的明确答复。本决定规定方向，尚未实施。
