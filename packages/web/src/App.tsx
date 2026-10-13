import { useEffect } from "react";
import { Shell } from "./argelander/Shell";
import { startMergeNotices } from "./library/merge-notices";
import { PageErrorBoundary } from "./PageErrorBoundary";

// ArgelanderSpace workspace shell. The document reader lives inside it as the doc
// pane (see doc/DocPane.tsx); the literature manager is the library pane.
export function App() {
  return (
    // A render error anywhere below shows a notice that can be recovered from, not a blank page.
    <PageErrorBoundary>
      <Workbench />
    </PageErrorBoundary>
  );
}

function Workbench() {
  // Background tasks' argument-graph notes are collected for the page's lifetime, whichever pane is open.
  useEffect(() => startMergeNotices(), []);
  return <Shell />;
}
