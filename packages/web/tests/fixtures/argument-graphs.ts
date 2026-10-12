/**
 * Synthetic argument graphs for the layout and canvas tests and the browser checks.
 * The data is fictional and synthetic: the paper, its claims, numbers and sources are invented (no real
 * literature or user data); only the shapes follow what the approved design called for. Three graphs: well-formed (11), flawed (13: a cycle,
 * an incomplete argument, an End that is used again, a Native with an in-edge, an orphan) and large (28).
 */
import type { Argument, ArgumentEdge, ArgumentEdgeRole, ArgumentGraph, ArgumentKind } from "@argelanderspace/contracts";

type Kind = ArgumentKind;
type Role = ArgumentEdgeRole;
interface Source { text: string; target?: { docId: string; anchor?: string; page?: number } }
type Draft = Partial<Omit<Argument, "id" | "title" | "kind" | "sources" | "warrant_implicit">> & { warrantImplicit?: boolean; sources?: Source[] };

const L = "arxiv-0000.00001";
const P = "pdf-7c1e-synthetic";
const src = (text: string, anchor?: string): Source => (anchor ? { text, target: { docId: L, anchor } } : { text });
const arg = (id: string, title: string, kind: Kind, f: Draft): Argument => ({
  id,
  title,
  kind,
  claim: f.claim ?? "",
  grounds: f.grounds ?? "",
  warrant: f.warrant ?? "",
  backing: f.backing ?? "",
  qualifier: f.qualifier ?? "",
  rebuttal: f.rebuttal ?? "",
  warrant_implicit: f.warrantImplicit ?? false,
  sources: (f.sources ?? []).map((s) => ({
    text: s.text,
    ...(s.target ? { target: { doc_id: s.target.docId, ...(s.target.anchor ? { anchor: s.target.anchor } : {}), ...(s.target.page ? { page: s.target.page } : {}) } } : {}),
  })),
});
const e = (from: string, to: string, role: Role): ArgumentEdge => ({ from, to, role });
const graph = (rev: number, args: Argument[], edges: ArgumentEdge[]): ArgumentGraph => ({
  version: 1,
  rev,
  work_id: "arxiv:0000.00001",
  arguments: structuredClone(args),
  edges: structuredClone(edges),
});

const CLEAN_ARGS: Argument[] = [
  arg('n1', 'Gaia DR3 的自行精度足够', 'native', {
    claim: 'Gaia DR3 对 $G<18$ 的恒星给出的自行与视差，足以把潮汐尾成员从场星中分辨出来。',
    grounds: 'Gaia DR3 发布文档给出的自行不确定度为 $0.02$–$0.1\\,\\mathrm{mas\\,yr^{-1}}$。',
    warrant: '测量不确定度小于星团内禀速度弥散对应的自行时，成员可以被分辨。', warrantImplicit: true,
    sources: [src('Section 2.1', 'sec-3'), src('Table 1', 'tab-1')],
  }),
  arg('n2', '收敛点法能识别共动恒星', 'native', {
    claim: '收敛点法可以在没有视向速度的情况下识别共动恒星。',
    grounds: '前人工作对多个邻近星团的应用结果（引文）。',
    warrant: '具有共同空间运动的恒星，其自行指向天球上的同一个收敛点。',
    backing: '该方法在毕星团等邻近星团上被独立验证过。',
    sources: [src('Section 3.2', 'sec-5'), src('Equation 2', 'eq-2')],
  }),
  arg('n3', 'N 体模型预测 S 形潮汐尾', 'native', {
    claim: '在银河系潮汐场中，瓦解中的星团会形成沿轨道延伸的 S 形潮汐尾。',
    grounds: '已发表的 N 体模拟（引文）。',
    warrant: '模拟采用的银河系势与本文星团的轨道参数范围一致。', warrantImplicit: true,
    sources: [src('Section 1', 'sec-1')],
  }),
  arg('n4', '银河系模型给出场星密度', 'native', {
    claim: '银河系恒星计数模型给出了该天区、该星等范围内的场星面密度。',
    grounds: '公开的银河系模型及其校准（引文）。',
    warrant: '模型在相邻对照天区与观测计数相符。',
    sources: [src('Section 4', 'sec-6'), { text: 'Page 9', target: { docId: P, page: 9 } }],
  }),
  arg('m1', '候选成员样本', 'normal', {
    claim: '在 $d<300\\,\\mathrm{pc}$ 内选出了 1 243 颗与星团共动的候选成员。',
    grounds: '本文对 Gaia DR3 星表施加的收敛点筛选，阈值见式 (2)。',
    qualifier: '仅限 $G<18$。',
    sources: [src('Section 3.2', 'sec-5'), src('Figure 1', 'fig-1'), src('Equation 2', 'eq-2')],
  }),
  arg('m2', '成员延伸到潮汐半径之外', 'normal', {
    claim: '候选成员在天球上延伸到约 $4\\,r_t$，远超星团的潮汐半径。',
    warrant: '超出潮汐半径的共动恒星不再被星团引力束缚。', warrantImplicit: true,
    sources: [src('Figure 2', 'fig-2'), src('Section 4', 'sec-6')],
  }),
  arg('m3', '尾部样本的污染率', 'normal', {
    claim: '尾部样本中的场星污染率约为 $20\\%$。',
    warrant: '在同一筛选条件下，模型预测的场星数与样本数之比即污染率。',
    qualifier: '只对 $G<17$ 成立；更暗处模型未经校准。',
    sources: [src('Table 2', 'tab-2')],
  }),
  arg('m4', '尾部形态与模型一致', 'normal', {
    claim: '观测到的尾部形态与 N 体模型预测的 S 形一致。',
    rebuttal: '若污染率远高于估计值，场星的随机分布也可能拼出类似的延伸结构。',
    sources: [src('Figure 3', 'fig-3'), src('Section 5', 'sec-7')],
  }),
  arg('m5', '尾部质量函数更平', 'normal', {
    claim: '尾部的现今质量函数斜率比核心更平，$\\alpha_\\mathrm{tail}=1.1\\pm0.2$ 对 $\\alpha_\\mathrm{core}=1.8\\pm0.1$。',
    warrant: '低质量恒星在两体弛豫中优先获得能量并逃逸。',
    rebuttal: '尾部样本在低质量端不完备，会使斜率看起来更平。',
    sources: [src('Figure 4', 'fig-4'), src('Equation 7', 'eq-7')],
  }),
  arg('e1', '星团正在瓦解', 'end', {
    claim: '该星团已失去约一半的初始质量，正处于瓦解阶段。',
    warrant: '潮汐尾的存在与质量分层的逃逸特征，共同指向持续的质量损失。',
    qualifier: '质量损失比例依赖于所取的初始质量函数。',
    sources: [src('Section 6', 'sec-8')],
  }),
  arg('e2', '方法可用于其他邻近星团', 'end', {
    claim: '本文的筛选流程可以直接用于 $300\\,\\mathrm{pc}$ 内的其他疏散星团。',
    warrant: '流程只依赖 Gaia 天体测量，不依赖本星团特有的数据。', warrantImplicit: true,
    sources: [src('Section 6', 'sec-8')],
  }),
];
const CLEAN_EDGES: ArgumentEdge[] = [
  e('n1', 'm1', 'grounds'), e('n2', 'm1', 'warrant'), e('m1', 'm2', 'grounds'), e('n4', 'm3', 'grounds'), e('m1', 'm3', 'grounds'),
  e('m2', 'm4', 'grounds'), e('n3', 'm4', 'warrant'), e('m3', 'm4', 'rebuttal'), e('m1', 'm5', 'grounds'),
  e('m4', 'e1', 'grounds'), e('m5', 'e1', 'grounds'), e('m4', 'e2', 'grounds'), e('n2', 'e2', 'backing'),
];

const FLAWED_ARGS: Argument[] = [
  ...CLEAN_ARGS.map(a => a.id === 'm5' ? { ...a, warrant: '' } : a),
  arg('m6', '星团年龄估计', 'normal', {
    claim: '由瓦解时标反推，星团年龄约为 $600\\,\\mathrm{Myr}$。',
    warrant: '质量损失率恒定时，已损失质量除以损失率给出年龄。', warrantImplicit: true,
    sources: [src('Section 5', 'sec-7'), { text: 'Appendix B（正文已删除）', target: { docId: 'upload-removed-doc', anchor: 'sec-12' } }],
  }),
  arg('x1', '光度函数的转折', 'normal', {}),
];
const FLAWED_EDGES: ArgumentEdge[] = [
  ...CLEAN_EDGES,
  e('m4', 'm1', 'warrant'), // members were selected using the predicted shape: a cycle m1 → m2 → m4 → m1
  e('e1', 'm6', 'grounds'), // an End argument used again
  e('x1', 'n1', 'backing'), // a Native argument resting on one of this paper's own arguments
];

const LARGE_TITLES = [
  '光度校准零点', '选择函数完备', '距离模数可靠', '消光改正成立', '金属丰度先验', '双星比例假设',
  '样本无偏', '背景扣除稳健', '速度弥散测量', '轨道积分收敛', '势模型适用', '年龄等时线拟合',
  '质量光度关系', '潮汐半径估计', '逃逸率测量', '核心坍缩迹象', '质量分层显著', '尾部密度轮廓',
  '轨道相位确定', '近心点通过时间', '盘面冲击影响', '初始质量估计', '瓦解时标', '动力学年龄',
  '与模拟定量相符', '剩余寿命预测', '形成环境推断', '对星团族群的推广',
];
function large(): { args: Argument[]; edges: ArgumentEdge[] } {
  const rows = [6, 6, 6, 5, 3, 2];
  const args: Argument[] = [], edges: ArgumentEdge[] = [], byRow: string[][] = [];
  let k = 0;
  rows.forEach((n, r) => {
    byRow.push([]);
    for (let i = 0; i < n; i++, k++) {
      const id = 'g' + k, kind: Kind = r === 0 ? 'native' : r === rows.length - 1 ? 'end' : 'normal';
      args.push(arg(id, LARGE_TITLES[k]!, kind, { claim: `${LARGE_TITLES[k]}（合成的大图节点，用于观察密度）。`, grounds: r === 0 ? '外部引文。' : '', warrant: '合成内容。', sources: [src('Section 4', 'sec-6')] }));
      byRow[r]!.push(id);
      if (r > 0) {
        const prev = byRow[r - 1]!;
        edges.push(e(prev[(i * 2 + r) % prev.length]!, id, 'grounds'));
        if ((i + r) % 2 === 0) edges.push(e(prev[(i * 3 + 1) % prev.length]!, id, (['warrant', 'backing', 'rebuttal'] as Role[])[(i + r) % 3]!));
        if (r > 1 && i % 3 === 0) edges.push(e(byRow[r - 2]![i % byRow[r - 2]!.length]!, id, 'backing'));
      }
    }
  });
  // every non-End argument must feed something, otherwise the audit list drowns the density check
  for (let r = 0; r < rows.length - 1; r++) for (const id of byRow[r]!) if (!edges.some(x => x.from === id)) edges.push(e(id, byRow[r + 1]![0]!, 'grounds'));
  return { args, edges };
}


export type ArgumentFixtureKey = "clean" | "flawed" | "large" | "empty";
export const ARGUMENT_FIXTURES: Record<ArgumentFixtureKey, () => ArgumentGraph> = {
  clean: () => graph(7, CLEAN_ARGS, CLEAN_EDGES),
  flawed: () => graph(3, FLAWED_ARGS, FLAWED_EDGES),
  large: () => {
    const g = large();
    return graph(4, g.args, g.edges);
  },
  empty: () => graph(0, [], []),
};
