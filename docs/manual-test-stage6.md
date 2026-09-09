# Stage 6 手动验收指南（阅读器四项修复：宽度自适应 / 多引用折行 / 右栏定位 / 作者块）

本指南验证 Stage 6 的全部用户可见变化：阅读器宽度自适应（①）、多引用 chip 折行（②）、
右栏跳转定位（③）、当前文献作者块（④），以及硬约束——agent 侧输出零变化。
每一步给出：**要做什么**、**应该发生什么**、**出现什么说明有 bug**。

> 约定：下文 CLI 一律写 `node packages/app/dist/bin.js`（repo 内的打包产物），在 **repo 根目录**运行。
> Stage 6 无新环境依赖（工具链同 Stage 5：TeX Live 必需；pdftocairo/gs 可选）。
> Stage 3/3.1/4/5 的验收指南留档作回归参照。

文中标 **（已预实测）** 的条目，是写本手册前在本机真实 Chrome（headless playwright 驱动
/usr/bin/google-chrome）跑过的验证；§1-§4 的关键预期全部连续 3 轮 9/9 通过。

---

## 0. 环境准备

**0a. 构建 + 起服务**

```bash
cd /home/wwu/project/bibgraph
corepack pnpm -r build
node packages/app/dist/bin.js serve --data-dir literatures --port 8000
# 浏览器开 http://localhost:8000
```

**0b. 迁移与备份说明（已于 2026-09-09 实跑）**

Stage 6 MS3 已对 7 篇 arXiv 文档做离线重摄入（带上 ③ 的图尺寸与 ④ 的作者块），
`library build --offline` 校验：36 篇既有 works 的 note/label/star/read/tags 逐字节零漂移、
零悬空 doc_ids；works 36→37（+1 = smoke R2 期间落在 output/ 的 latex-battery 首次入种子，非异常）。
备份 `literatures.stage6-backup.tar.gz`（225 MB）在 repo 根，**验收通过后用户可自行删除**。

**0c. 硬约束总览（已预实测）**

agent 侧输出本阶段**逐字节不变**：golden `.md`（`tests/golden/tex/*.md`）在三次重冻中
全部逐字节一致（管线测试锁死）；CLI `show`/`read`/`ref`/`bib`/`search`/`list` 的字段白名单
不含任何新增 IR 字段（`imgWidth/imgHeight`、`meta.authorDetails/affiliations/email` 对 agent 不可见）。
可用任一文档抽查：

```bash
node packages/app/dist/bin.js show arxiv-2501.17225 fig-1 --data-dir literatures
# 预期：JSON 里只有 doc_id/id/kind/number/label/caption/image/link —— 无 imgWidth/imgHeight
node packages/app/dist/bin.js ref arxiv-2501.17225 ref-1 --data-dir literatures | head -20
node packages/app/dist/bin.js read arxiv-2501.17225 --data-dir literatures | head -5
```

---

## 1. ① 阅读器宽度自适应

**1a. 收起侧边栏重排（已预实测：正文列 468 → 900px）**

打开 `arxiv-2501.17225`（文献页 → 文档，或直达 `/doc/arxiv-2501.17225`）。
把窗口拉到约 1200px 宽，然后依次点左栏「«」和右栏「»」收起两侧栏。

- 应该：正文列随侧栏收起实时变宽（有 0.24s 的宽度动画），文字重排到更宽的列里。
- bug：正文列纹丝不动、或收起后仍保持原宽度。

**1b. 超宽屏可读性上限（已预实测：2600px 视口列宽 900px 居中）**

把窗口拉到全屏/超宽（≥2400px），两侧栏展开或收起均可。

- 应该：正文列到达上限（约 900px，100ch 含内边距）后不再变宽，两侧等宽留白居中。
- bug：正文一直拉满全屏（行长失控）；或偏左不居中。

**1c. 分屏拖拽**

开两个文档窗格（右上角分屏），拖动中间分隔条。

- 应该：两个阅读列都实时重排。
- bug：内容溢出被裁剪或列宽不动。

**1d. 非阅读器页面不受影响**

计划页、文献看板版式与 Stage 4/5 一致（这两处本就不在修复范围）。

---

## 2. ② 多引用罗列折行

**2a. 长串多引用自然折行（已预实测：15 chip 跨 14 行）**

打开 `arxiv-2501.17225`，窗口拉到约 1100px。在 §1 Introduction 找长串引用
（如 "(Grillmair et al. (1995); Lehmann & Scholz (1997); …; Ibata et al. (2019))" 八连引）。

- 应该：长串引用在 **chip 之间**自然折行，单个 chip（如 "Grillmair et al. (1995)"）
  永不被从中间折断；整串可见文字与以前一模一样。
- bug：整串溢出正文列、不换行；或某个 chip 从中间断开成两行。

**2b. 每个 chip 各点各的文献**

点长串中间某个 chip（非第一个）。

- 应该：右栏聚焦的是**该 chip 对应的那一条**引用卡（不再是整串只跳第一条）。
- 悬停单个 chip：tooltip 显示该条文献的 raw 条目文本（不再是整串所有条目拼接）。

**2c. 未解析引用**

任一文档里若有 `[?]` 形态的未解析引用 chip：灰化、点不动；同组其它已解析 chip 不受影响、
各自可点（以前是整组一起灰）。

**2d. 其它 chip 面**

图注/表注里的 cite chip（右栏卡片展开区同款组件）折行行为一致；
xref chip（Fig./Table/Eq.）不受影响。

---

## 3. ③ 右栏跳转定位

**3a. 右栏卡片跳转落点精确（已预实测：落点误差 ≤0.4px）**

打开 `arxiv-2501.17225`，往下滚动让右栏出现图/表卡片（带 ⤴ 按钮的卡）。
点一张远端卡片（如附录 Table A.2）的 ⤴。

- 应该：平滑滚动结束后，目标块顶部精确停在阅读区顶部的留白线处
  （block 16px / 节标题 20px 的 scroll-margin），不再偏上/偏下；
  若滚动途中有偏移，会在滚动结束后被自动校正（可能看到一次小幅二次移动，属设计行为）。
- bug：落点明显偏离目标（隔着几个段落）；长距离跳转到附录表格时偏差最大曾是 ~2000px。

**3b. 侧栏过渡中跳转（已预实测：off=0.4px）**

收起或展开左/右侧栏，在宽度动画进行中点右栏卡片 ⤴。

- 应该：动画+校正收敛后落点同样精确。
- bug：落点偏移且不被校正。

**3c. 用户接管即停止校正**

点 ⤴ 跳转后**立刻**自己滚动（滚轮/触控板/键盘）或点左下 undo 圆钮。

- 应该：页面完全跟随你的操作，不再发生任何自动二次移动。
- bug：你滚到一半被拽回目标块。

**3d. 左栏 TOC 跳转**

点左栏目录条目跳转——行为与右栏一致（两者本就共用同一 jumpTo；本阶段修复的是
共同的落点机制）。深链接 `/doc/arxiv-2501.17225#tab-2` 直接打开也应精确落在 Table A.2。

**3e. 图预留位置（③ 的根因修复）**

打开任一文档快速往下滚动或长跳。

- 应该：图片在加载完成前其位置已被占好（不再看到文字先挤上去、图加载完又把内容推下去）。
- bug：滚动经过未加载的图时正文明显"弹跳"。

---

## 4. ④ 当前文献作者块

**4a. 折叠默认态（已预实测）**

打开 `arxiv-2501.17225`。正文列顶部（Abstract 标题之上）有一行小的作者行。

- 应该：默认折叠为 "▸ Dhanraj Risbud et al. (3 authors)"；不展开时不占首屏。
- bug：默认全量展开；或该行出现在 Abstract 之后。

**4b. 展开：上标机构 + email（已预实测）**

点作者行展开。应该看到：

- 完整作者列表：Dhanraj Risbud¹, Vikrant V. Jadhav², Pavel Kroupa²´³（上标为机构编号）；
- 编号机构列表 1-3（Rheinische Friedrich-Wilhelms-Universität Bonn 等三条）；
- 底部 ✉ s14drisb@uni-bonn.de（通讯邮箱，A&A 类挂文档级）。
- bug：人名里带 `1,2,3` 之类残渣；机构文本里混入邮箱；上标与机构列表对不上。

**4c. 手写 revtex 族（已预实测）**

打开 `arxiv-1610.08981` 展开作者块：

- 应该：Federico Lelli¹´²（✉ flelli@eso.org）、Stacy S. McGaugh¹、James M. Schombert³、
  Marcel S. Pawlowski¹´⁴，四条机构（Case Western / ESO / Oregon / UC Irvine）。
- 该论文的 `$^{1,2,\star}$` 手写标记曾被粘进人名——现已机械还原。

**4d. AASTeX 族**

打开 `arxiv-2012.05220` 展开：5 位作者、2 条机构
（Bailer-Jones/Rybizki/Fouesneau/Andrae→MPIA，Demleitner→ARI），无 email（源文注释掉了）。
打开 `arxiv-1804.10121` 展开：同样 5 位作者、2 条机构，但第 4 位是 **G. Mantelet**（→ARI），
不是 Demleitner（两篇是不同论文，勿混淆）。

**4e. 平铺降级（已预实测）**

打开 `arxiv-2603.03522`：作者块只有 "Mark D. Huisjes et al. (2 authors)"，展开后
Huisjes 带 ✉ m.huisjes@degoudsewaarden.nl，**无机构列表**——该论文把机构粘在
`\author` 的 `\\` 之后，属有界降级（不解析，不出错）。
单作者文档直接显示姓名、无 "et al."。

**4f. agent 不可见（硬约束，见 §0c）**

作者块数据只进 web 阅读器；CLI 输出不含 authorDetails（§0c 已实测）。

---

## 5. 回归面

**5a. Stage 4 计划页**：列表/看板/时间线/聚焦/弹窗/抽屉/note 数学渲染 与 Stage 4 一致
（本阶段未触碰；固定 max-width 版式是刻意保留）。
**5b. 文献看板**：label 色点/已读标识/note 只读 tab/搜索过滤 与 Stage 3 一致。
**5c. 深色模式**：四处在深色主题下各看一眼（作者块、chip、跳转 flash、图反色按钮）无异常。
**5d. 多窗格**：同一文档开两窗格，各自收起侧栏/跳转互不干扰（校正按窗格各自的 reader 作用域）。

---

## 6. 已知边界（本阶段不修，勿当 bug 报）

- 跳转校正采用**停稳检测**（scrollTop 停稳才校正）：极端慢的机器上若平滑滚动病理级
  超长，停稳等待最长约 900ms+8×250ms≈2.9s 后有界放弃校正（本机实测最长收敛 ~2.1s）；
  校正最多 2 次、会被用户滚动/undo/新跳转立即取消。
- 滚动条拖拽/中键 autoscroll 不在"用户接管"监听面（wheel/touchstart/keydown）——
  校正窗口内拖滚动条理论上可能被校正一次，窗口极窄。
- jpg/gif/webp 直通图没有尺寸预留（PDF/EPS→SVG 与 PNG 有；天文论文图几乎全是前者）。
- 作者块：`\affil` 乱序/跳号的手写块可能错配上标；单机构内含 `\\` 换行会被切成两条；
  `Name,\inst{1}` 逗号前置风格的上标归属可能不准；orphan `\affiliation` 会占一个机构位；
  机构去重对尾标点敏感（"Institute X" 与 "Institute X." 会列成两条，显示层小瑕疵）。
- 参考文献条目的 title/authors 元数据**本阶段不做**（grilling Q8 用户确认非其诉求）。
- TOC float 预览显示 `[cite:…]` 记号、tikz/pgfplots 不渲染——均推后到 Stage 7。
