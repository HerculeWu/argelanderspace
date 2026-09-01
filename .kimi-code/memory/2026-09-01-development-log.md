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

## 下一步

Stage 3.1（已合并原 3.2）：OCR 代码隔离进 `ocr-features` 分支 + 空 stub pane 移除 + 公式编号/丢失修复 + 已读标识复查——详见 `2026-09-01-stage3x-roadmap.md`。远期 Stage 4（计划页面 + agent 操作）/Stage 5（论文写作）。
