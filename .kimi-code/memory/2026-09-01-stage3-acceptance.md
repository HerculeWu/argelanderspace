# Stage 3 验收结论（2026-09-01，用户手动验收基本通过）

按 `docs/manual-test-stage3.md` 六组执行。总体判定"基本成功，剩余问题可接受"，Stage 3 关闭。

## 各组结果

1. **存储统一**（CLI 写入 → webui 免 F5）✅
2. **webui 缺口** ✅（一处观察）：笔记全文/label 色点通过；**已读标识用户一开始没找到**——后来自行发现未读蓝点（标已读后消失）。功能在但可见性存疑：`· 已读` meta 与标题灰化不够显眼。→ 列入 3.2 复查项。
3. **upload** ⚠️ 环境失败非代码失败：进度流水出现（"extracting MinerU…" 闪动 = 进度通道工作），随后报 `HTTP 401 {"msgCode":"A0202","msg":"user authenticate failed"}`——**MinerU API key 鉴权失败**（env 层，~/.zshrc 的 MINERU_API_KEY 待用户自查）。**失败可见性反而得到实测**：错误显示在面板。失败探针未测。
4. **阅读器回归** ✅：`#sec-4` 落在 section 2.1——**核实为正确行为**：`sec-N` 是结构 id 非印刷节号（2501.17225 实测：Abstract=sec-1、1 Introduction=sec-2、2=sec-3、2.1=sec-4）。**深链接锚点语义 = 结构 id，勿与印刷节号混淆，勿再当 bug 查**。
5. **agent 独立环境冒烟全过**（/tmp/aspace-stage3-demo + 绝对路径 CLI + `pi -nc`）：
   - 5a 摄入 ✅（2607.17040；无 `--data-dir`、cwd 正确、note 建议稿流程正常）；
   - 5b 查询 ✅——**空 note 主动提示修复生效**（agent 引用 stderr hint "1/1 works have empty notes" 并主动提出回填；Stage 2 遗留缺陷关闭）；
   - 5c 阅读 ✅（`read --manifest refs` + `--section` 用法正确；回答带 8043 端口深链接）；
   - 5d 维护 ✅（label/tags 生效；agent 再次提醒空 note）。
   - **全程未见读源码行为**（skills 强硬条款生效）。

## 验收新发现（进 Stage 3.2）

- **公式编号全丢（数据层实锤）**：2607.17040（LaTeX 源）5 个 equation block 的 `number` 全 absent——管线提取阶段就没产出，与 IR/web 无关。**用户决策：未被交叉引用的公式也要保留编号**（编号是人-agent/人-人交流的"坐标"）。原设计疑似只给被引用公式编号。
- **公式丢失（数据层实锤）**：§2.2 第一个 "To study…" 段落（sec-5）后应有公式，doc 里下一块却是 `p-11` 段落且段文本无 `$…$`——公式在 pandoc AST → walk 提取阶段丢失（疑似未编号环境 `equation*` / `\[...\]` 的间隙）。stats：n_equations=5、n_crossrefs 49 仅解析 29。
- 已读标识可见性复查（见第 2 组）。

## 战略决定（用户拍板）

**OCR/PDF/出版商 HTML 摄入降级为"开发中"**：当前阶段只接受 LaTeX 源摄入（arXiv）。用户论据：~9 成文章 arXiv 有与出版版一致的内容；剩余 1 成中过半有出版商 PDF；老论文扫描件极少；出版商反爬（DataDome/Cloudflare/Radware）越来越强；OCR 拖慢发布。例外论文用户自行转 LaTeX。OCR 实现后续整理进专门模块备用。

## 状态

Stage 3 完成：3 个 commit（`18d4d58`/`f23e0e1`/`ace4d9f`）+ memory commit，已 push origin main（2026-09-01）。
