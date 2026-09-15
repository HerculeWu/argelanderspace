# Stage 10 手动验收指南(Writer:cell 化 LaTeX 稿件编辑器 + 编号求真 + 导出 zip)

本指南验证 Stage 10 的完整闭环:稿件管理 → cell 编辑 → 编号编译求真 → 引用/交叉引用 → 图片 → 导出 zip。
每一步给出:**操作**、**应该发生什么**、**出现什么说明有 bug**。

> 约定:CLI 一律写 `node packages/app/dist/bin.js`(或全局 `argelanderspace`)。
> 编号编译依赖本机 pdflatex(TeX Live);失败不阻塞编辑,只会让编号显示"未更新"。

---

## 0. 准备

```bash
cd /home/wwu/project/bibgraph
corepack pnpm -r build
node packages/app/dist/bin.js serve   # 默认 8000 端口
```

浏览器打开 `http://localhost:8000`,左侧导航应有 **写作**(计划/文献/文档/写作/扩展)。

## 1. 稿件管理

1. 进入"写作"→ 应见稿件列表(空态有引导)。**操作**:新建稿件 → 弹窗里不选模板时"创建"应禁用;选 Generic Report → 创建。
   - 应发生:直接进入编辑器,空态提示 + 常显 ＋ 按钮。
2. 返回列表(顶栏 ‹),再新建一篇 A&A;列表应按更新时间倒序显示两篇。删除一篇:有二次确认。
   - 有 bug 的表现:无确认直接删;删除后列表残留。

## 2. cell 编辑(核心交互)

1. 空态点 ＋ → 菜单只含当前模板的 types(report:LaTeX/Figure/Table/Code);选 LaTeX → 直接进入编辑态。
2. 粘贴:`\chapter{First}\n\label{ch:one}\n\n\section{Intro}\n\label{sec:intro}\n\nText with \citep{Belokurov2006}.\n\n\begin{equation}\n  v_c^2 = GM(r)/r\n  \label{eq:vc}\n\end{equation}`(可多行输入)。
   - 应发生:源码区有**语法高亮**(命令强调色/花括号/注释/数学区分);Shift+Enter 或"渲染"后,正文区 section 成标题、cite 上色、**公式被 KaTeX 排印**。
3. 行间 ＋ 再插一个 Figure cell:caption 填字、label 填 `fig:x`,上传一张图片。
   - 应发生:图片显示在 figure 框里(走资产接口,不是 dataURL);caption 带 Figure 1 编号。
4. 类型菜单把 Figure 转成 LaTeX(序列化保留),再转回来(数据重置=有损,预期行为)。
5. 换模板(顶栏下拉)到 Letter:不支持的 cell 类型应显示"保留但模板不支持"提示,内容不丢。

## 3. 编号求真(D14 核心)

1. §2.2 粘贴后等 ~4 秒(autosave + 后台编译)。
   - 应发生:左栏 Outline 出现 **1.1 Intro**(report 章节化编号)与 **1.1 eq:vc**;Crossrefs 面板同步。顶栏有刷新编号按钮(⟳)。
2. 再编辑一句话 → 保存后片刻,编号状态应变 **stale → 编译后恢复 ok**(REST `GET /api/writer/manuscripts/<id>/numbering` 可看 status;stale 时面板有"编号未更新"标记)。
3. 把公式改到编译不过(如 `\unknowncmd`)→ 保存。
   - 应发生:编号停在**上次成功**的结果 + stale 标记,不打断编辑;改回来后恢复。
4. A&A 模板稿件:若 `literatures/templates/aa.deps/aa.cls` 不存在,编号编译应报"缺依赖"(stale + lastError 提到 aa.cls),其余功能不受影响。
   - 把 aa.cls 放入该目录后点 ⟳ → 应恢复真编号。

## 4. 引用与交叉引用

1. 右栏 References:搜索真实文献库,点 ＋ 往当前编辑光标插 `\cite{key}`。
2. Outline/Crossrefs 对无 label 的目标点插入:自动补 `\label` 再插入;**公式的 label 补在 `\begin{...}` 行后**(不是 cell 末尾)。
3. `\eqref{eq:vc}` 在正文渲染为 xref 样式。

## 5. 导出

1. 点"导出":下载 `<标题>.zip`。
   - 解压应有:`manuscript.tex`(单文件,含 preamble+front matter+全部 cell)、`references.bib`(**只有被引条目**)、`assets/` 图片。
   - 引用了库里没有的 key 时:toast 提示缺失数,bib 里有 `% missing:` 注释。
2. manuscript.tex 可独立编译(可选):`pdflatex` 两遍能出 PDF(report 模板;aa 需要 aa.cls)。

## 6. 同步与多窗格

1. 多开一个 pane 同时看同一稿件:一边编辑,另一边经 `writer.changed` 收敛(rev 冲突时载入最新并提示)。
2. 外部改 `literatures/manuscripts/<id>/manuscript.json`(agent 场景):web 端自动重取。
3. 中英切换(Tweaks)与明暗主题下,写作界面文案/高亮/公式渲染正常。

---

通过标准:以上无"有 bug 的表现",且 `GET /api/writer/manuscripts/<id>/numbering` 在编辑后能从 stale 自动回 ok。
