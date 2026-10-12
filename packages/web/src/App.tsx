import { useEffect } from "react";
import { Shell } from "./argelander/Shell";
import { startMergeNotices } from "./library/merge-notices";

// ArgelanderSpace workspace shell. The document reader lives inside it as the doc
// pane (see doc/DocPane.tsx); the literature manager is the library pane.
export function App() {
  // Background tasks' argument-graph notes are collected for the page's lifetime, whichever pane is open.
  useEffect(() => startMergeNotices(), []);
  return <Shell />;
}
