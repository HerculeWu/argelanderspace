/**
 * Built-in writer templates (Stage 10). Single source of truth, shared by the
 * web UI (M1 mock data layer) and the server-side template loader (M2).
 * Users/agents override or extend these by dropping `<id>.json` files into
 * `<dataDir>/templates/` — the on-disk JSON file is the agent contract; these
 * constants are merely the shipped defaults (content mirrors the prototype).
 */

import { type WriterTemplate, WriterTemplateSchema } from "./writer.js";

export const BUILTIN_WRITER_TEMPLATES: WriterTemplate[] = [
  WriterTemplateSchema.parse({
    id: "aa",
    version: 1,
    label: "A&A",
    chip: "A&A manuscript",
    preamble:
      "\\documentclass{aa}\n\\usepackage{graphicx}\n\\usepackage{txfonts}\n\\usepackage{amsmath}\n\\usepackage{listings}\n% managed by template",
    types: ["latex", "abstract-aa", "figure", "table", "code", "ack", "appendix"],
    infoFields: [
      { key: "runningTitle", label: "Running title", input: "text" },
      { key: "keywords", label: "Keywords", input: "text" },
    ],
    // User-provided class/style: not redistributed without a license audit.
    // Missing files are reported explicitly; do not substitute plainnat for A&A.
    deps: ["aa.cls", "aa.bst"],
    bibliographyStyle: "aa",
    frontMatter:
      "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\institute{ {{affiliations}} }\n\\keywords{ {{info.keywords}} }\n\\maketitle",
  }),
  WriterTemplateSchema.parse({
    id: "report",
    version: 1,
    label: "Generic Report",
    chip: "Generic report",
    preamble:
      "\\documentclass[11pt]{report}\n\\usepackage{graphicx}\n\\usepackage{booktabs}\n\\usepackage{amsmath}\n\\usepackage{natbib}\n\\usepackage{listings}\n% managed by template",
    bibliographyStyle: "plainnat",
    types: ["latex", "figure", "table", "code"],
    infoFields: [{ key: "date", label: "Date", input: "text" }],
    frontMatter:
      "\\title{ {{title}} }\n\\author{ {{authors}} }\n\\date{ {{info.date}} }\n\\maketitle",
  }),
  WriterTemplateSchema.parse({
    id: "letter",
    version: 1,
    label: "Letter",
    chip: "Letter",
    preamble:
      "\\documentclass{letter}\n\\usepackage{graphicx}\n\\usepackage{amsmath}\n\\newenvironment{thebibliography}[1]{}{}\n\\providecommand{\\newblock}{}\n\\usepackage{natbib}\n\\renewcommand{\\bibsection}{\\par\\bigskip\\noindent\\textbf{References}\\par}\n\\usepackage{listings}\n\\usepackage{float}\n\\newfloat{figure}{htbp}{lof}\n\\floatname{figure}{Figure}\n\\newfloat{table}{htbp}{lot}\n\\floatname{table}{Table}\n% managed by template",
    bibliographyStyle: "plainnat",
    types: ["recipient", "latex", "figure", "table", "code"],
    infoFields: [{ key: "senderBlock", label: "Sender block", input: "textarea" }],
    frontMatter: "\\signature{ {{info.senderBlock}} }",
  }),
];
