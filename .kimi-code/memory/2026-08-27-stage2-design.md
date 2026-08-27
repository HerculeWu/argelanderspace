# Stage 2 设计定稿（2026-08-27，11 问全部拍板）

## 用户场景（再次确认）

terminal 里跑 pi-agent 基底的科研助手 + 与 AI 写作；ArgelanderSpace webui 是图形化看板与阅读原文载体（"不剥夺用户看论文的权利"）。

## 关键背景事实（拷问前调研）

**pi 核心刻意不支持 MCP**（作者 Mario Zechner：MCP 每轮灌工具 schema 进上下文，token 税高；原生方式是 CLI + skills；MCP 只能靠社区 pi-mcp-adapter）。因此 Stage 1 时代"MCP 为中心"的预设被推翻。

## 决策（11 项）

1. **接入形态：CLI + skills**。CLI 补齐 agent 向子命令；skills 三件套改写为调 CLI 的薄 prompt 层。不做 MCP（以后要做只是在 service 层加薄壳）。
2. **权限：全读写**。agent 可查/读/ingest/写 note/打标签。
3. **付费路径：完全自动**。OCR 不挂锁；MinerU 日限 1000 页够用；配额风险写进 README。
4. **读纸形态：LLM 友好 markdown 渲染器**。Document JSON 现算 → markdown（`[ref: ...]`/`[cite: ...]` token 风格同 skills 的 article_llm.md）+ refs/bib manifests。这个渲染器即 Stage 3「渲染管道 SOT 共用」的雏形。
5. **检索：agent 判断**。search 返回全库紧凑 index 行（id/title/year/note/tags），不做服务端预过滤。
6. **命令粒度：中等**。约 8 个子命令：search / read / show / ref / ingest / note / label / list。
7. **note 纪律：每篇必问，agent 先给建议稿**（用户确认或修改）。
8. **深链接：四级锚点** doc / section / 浮动体(fig/tab/eq) / 参考文献。URL 形态 `/doc/<id>#<anchor>`（SPA fallback），CLI 输出带链接（端口取 config 的 port，默认 8000）。
9. **主动推送：不做**。只有被动链接（WS navigate 通道留给未来）。
10. **skills 归属：repo 内 `skills/`，前缀 `argelander-`**（argelander-paper-ingest / argelander-read-paper / argelander-query-paper-library）。pi 发现机制：`~/.pi/agent/skills/` 或 `.pi/skills/`（symlink/拷贝）。旧 literature-library-skills/ 方法论吸收完后由用户决定删除。
11. **验收：自动化测试（agent 视角 CLI 层）+ 用户手动 pi 验收**，交付时附详细手动测试指南。

## 实施分解（里程碑）

- **MS1 渲染器 + agent CLI**：core 渲染器（Document→llm markdown + manifests）；cli 新子命令 search/read/show/ref/note/label/list + 深链接输出。
- **MS2 web 深链接**：DocPane 支持 `/doc/<id>#<anchor>` 路由定位（块元素补 anchor id）。
- **MS3 skills 重写 + README（配额风险）+ 手动测试指南**。
- 每步验收：pnpm -r build/test/typecheck/lint 全绿 + 对应专项测试。
