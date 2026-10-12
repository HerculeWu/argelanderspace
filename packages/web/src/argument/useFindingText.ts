/** The words for an audit finding, with the argument titles filled in (shared by the header list and the panel). */
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import type { Finding } from "./findings";

export type DescribeFinding = (finding: Finding) => string;

export function useFindingText(graph: Pick<ArgumentGraph, "arguments"> | null): DescribeFinding {
  const { t } = useTranslation();
  const title = (id: string | undefined) => graph?.arguments.find((a) => a.id === id)?.title || t("argument.view.panel.untitled");
  return (f) => {
    switch (f.kind) {
      case "cycle":
        return t("argument.view.audit.cycle", { list: f.ids.map(title).join(t("argument.view.audit.cycleArrow")) });
      case "noEnd":
        return t("argument.view.audit.noEnd");
      case "noPathToEnd":
        return t("argument.view.audit.noPathToEnd", { a: title(f.ids[0]) });
      case "endWithOutEdge":
        return t("argument.view.audit.endWithOutEdge", { a: title(f.ids[0]) });
      case "nativeWithInEdge":
        return t("argument.view.audit.nativeWithInEdge", { a: title(f.ids[0]) });
      case "incomplete":
        return t("argument.view.audit.incomplete", { a: title(f.ids[0]), m: f.missing.map((m) => m[0]?.toUpperCase() + m.slice(1)).join(t("argument.view.audit.joiner")) });
    }
  };
}
