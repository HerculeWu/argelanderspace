/**
 * The audit as a list of findings (ticket 04): one entry per finding, in the order the audit reports them. The text
 * is built by the view (i18n); this only says what each finding is and which arguments it names. Pure, from
 * `auditArgumentGraph`.
 */
import type { ArgumentAudit, ArgumentIncompleteField } from "@argelanderspace/contracts";

export type Finding =
  | { kind: "cycle"; ids: string[] }
  | { kind: "noEnd"; ids: [] }
  | { kind: "noPathToEnd"; ids: [string] }
  | { kind: "endWithOutEdge"; ids: [string] }
  | { kind: "nativeWithInEdge"; ids: [string] }
  | { kind: "incomplete"; ids: [string]; missing: ArgumentIncompleteField[] };

export function listFindings(audit: ArgumentAudit): Finding[] {
  return [
    ...audit.cycles.map((c): Finding => ({ kind: "cycle", ids: c.arguments })),
    ...(audit.noEnd ? [{ kind: "noEnd", ids: [] } as Finding] : []),
    ...audit.noPathToEnd.map((id): Finding => ({ kind: "noPathToEnd", ids: [id] })),
    ...audit.endWithOutEdge.map((id): Finding => ({ kind: "endWithOutEdge", ids: [id] })),
    ...audit.nativeWithInEdge.map((id): Finding => ({ kind: "nativeWithInEdge", ids: [id] })),
    ...audit.incomplete.map((i): Finding => ({ kind: "incomplete", ids: [i.id], missing: i.missing })),
  ];
}

/** The findings that name this argument (the panel lists these; a graph-level `noEnd` names none). */
export const findingsOf = (findings: readonly Finding[], id: string): Finding[] => findings.filter((f) => f.ids.some((x) => x === id));
