import { useState } from "react";
import type { TexDocIr } from "@argelanderspace/contracts";
import { useStore } from "../store";

// The paper's own author block (Stage 6, arXiv-HTML style): authors with
// superscript affiliation links and emails, recovered from the LaTeX source
// into meta.authorDetails/affiliations/email. Collapsed to the first author
// by default so the reading column keeps its first screen for the abstract.
export function AuthorBlock() {
  const store = useStore();
  const meta = (store.ir as TexDocIr).meta;
  const authors = meta?.authorDetails;
  const affiliations = meta?.affiliations ?? [];
  const [open, setOpen] = useState(false);
  if (authors === undefined || authors.length === 0) return null;
  const first = authors[0]!;
  return (
    <div className={"author-block" + (open ? " open" : "")}>
      <button
        type="button"
        className="author-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse author list" : "Show all authors, affiliations and emails"}
      >
        <span className="author-caret">{open ? "▾" : "▸"}</span>
        {authors.length === 1 ? first.name : `${first.name} et al. (${authors.length} authors)`}
      </button>
      {open && (
        <div className="author-full">
          <ul className="author-list">
            {authors.map((a, i) => (
              <li key={`${a.name}:${i}`}>
                <span className="author-name">{a.name}</span>
                {a.affiliations !== undefined && a.affiliations.length > 0 && (
                  <sup className="author-sup">{a.affiliations.join(",")}</sup>
                )}
                {a.email !== undefined && <span className="author-email">✉ {a.email}</span>}
              </li>
            ))}
          </ul>
          {affiliations.length > 0 && (
            <ol className="affil-list">
              {affiliations.map((af, i) => (
                <li key={`${i}:${af}`}>{af}</li>
              ))}
            </ol>
          )}
          {meta.email !== undefined && <div className="author-doc-email">✉ {meta.email}</div>}
        </div>
      )}
    </div>
  );
}
