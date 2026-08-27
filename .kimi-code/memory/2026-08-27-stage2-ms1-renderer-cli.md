# Stage 2 / MS1 完成：渲染器 + agent CLI（2026-08-27）

实现决策 4（渲染器）、5（search 全量 index 行）、6（中等粒度命令）、8（深链接）、2（读写）。全量验收绿：`pnpm -r build/test/typecheck/lint`（测试总数 262 → 323；core +42，cli +19）。

## 产物

- **渲染器 `packages/core/src/documents/render.ts`**（纯函数、零依赖、确定性；Stage 3 渲染管道 SOT 雏形）：
  - `renderDocMarkdown(doc, opts?)` / `renderSectionMarkdown(doc, sectionId, opts?)`（后者含子树；未知 section 抛错并列可用 id）。
  - `renderRefsManifest(doc)` → `RefManifestRow[]`（section 行在前、float 行在后，均按阅读序）；`renderBibManifest(doc)` → `BibManifestRow[]`。返回行对象，CLI 负责 JSONL 序列化。
  - 辅助导出：`citeShort(ref)`（"Bok 1934" 风格）、`renderInlineText(text, doc)`、`FloatBlock` 类型。
  - `RenderOptions.previewLength`（默认 80）；manifest context 截断 200 字符。
- **CLI `packages/cli/src/agent.ts`**：`search / read / show / ref / note / label / list`，经 `registerAgentCommands(program)` 挂到 program.ts。
- **`packages/cli/src/common.ts`**：从 program.ts 抽出的 `resolveDataDir` / `withDataDir` / `fail`（program.ts re-export `resolveDataDir`，config.test.ts 导入路径不变）。
- 测试：`packages/core/tests/render.test.ts`（42 例，6 篇 golden）；`packages/cli/tests/agent.test.ts`（19 例，spawn 构建后 bin）。

## 关键格式（与 skills 的 article_llm.md 对齐）

- `[[cite:ref-6]]` → `[cite: ref-6 | Bok 1934]`（有 title 时追加 `| title: …`）；组引用每 ref 一个 bracket 紧邻；`[[cite:?]]` → `[cite: ? | unresolved]`。
- `[[xref:fig-1]]` → `[ref: fig-1 | figure | number: 1 | <caption 摘要>]`；未解析的 `[[xref:figure-3?]]` → `[ref: figure-3 | unresolved]`（**剥掉 `?`**——unresolved 段已表意，保留会妨碍 grep/manifest 查找）。
- 图/表：`[Figure omitted | id: fig-1 | number: 1 | caption: <全文> | path: /images/<docId>/<img_path>]`。
- 公式：`$$…$$` + 下一行 `[ref: eq-1 | equation | number: 1 | <latex 摘要>]` 锚点；代码/算法：锚点行 + fenced body。
- 嵌套安全：markdown 内联预览一律 `stripTokens` + 去 `|[]`（caption 全文也一样）；token 展开版 caption 只放 refs manifest 的 `content`（JSON 字符串无嵌套问题）。

## 简报范围内的自决项

1. **深链接端口**：agent 命令无 `--port` flag，链 = `ARGELANDERSPACE_PORT` env > config.toml `port` > 8000（serve 链减去 flag 层）。
2. **JSONL 纯净度**：`search` 与 `read --manifest` 的 stdout 保持纯 JSONL，doc 头 + 深链接打到 **stderr**；markdown/JSON 输出（read/show/ref/list）链接内联在 stdout。
3. **`show`/`ref` 输出为 pretty JSON**，`link` 字段携带深链接（同时满足"机器友好"与"带链接"）。
4. **manifest 函数返回行数组**而非 JSONL 字符串（程序化复用更方便；CLI 一行 map 序列化）。
5. `renderDocMarkdown` 不含文档级标题头——标题/链接头由 `read` 命令打印（`# <title>` + `> doc: … | link: …`），渲染器只管正文。
6. `note` 的 text 用 commander variadic `[text...]`（agent 免引号）；`ref` 除 id 外也按 `label`/`keys` 精确匹配。
7. 错误格式：`error: unknown <kind> "<query>" — closest matches: …`（子串匹配）或 `available: …（前 12 个 + 总数）`。

## 已知数据怪相（非渲染器 bug，bug-for-bug 源数据）

- golden 里 references 普遍无 `title`（如 arxiv-2501.17225 76 条全缺）→ `[cite: …]` 多数只有两段。
- 个别作者字段残缺（`R\ 2019`、`K\ 2008`）与正文 "moving groups from ."（未解析超链接未留 token）均源自 Python 管线冻结数据。
- web 端 `/doc/<id>#<anchor>` 路由在 MS2 才实现；MS1 只保证 CLI 输出该形态链接。

## 后续（MS2/MS3）

- MS2：DocPane 路由 + 块元素 anchor id（锚点形态已定：doc id / section id / float id / ref id，与 JSON 内 id 一致）。
- MS3：skills 三件套改写调 CLI（`search/read/show/ref/note/label/list` 即其操作面），README 补 MinerU 配额风险，手动测试指南。
