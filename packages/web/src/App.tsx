import { useEffect } from "react";
import { Shell } from "./argelander/Shell";
import { useHostAnswer } from "./host";
import { startMergeNotices } from "./library/merge-notices";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { WelcomeShell } from "./welcome/WelcomeShell";

// ArgelanderSpace workspace shell. The document reader lives inside it as the doc
// pane (see doc/DocPane.tsx); the literature manager is the library pane.
export function App() {
  return (
    // A render error anywhere below shows a notice that can be recovered from, not a blank page.
    <PageErrorBoundary>
      <Root />
    </PageErrorBoundary>
  );
}

/**
 * The workbench, or — in the desktop app with no project open — the welcome page (desktop-app ticket 18). Nothing is
 * shown until the server has said which: the workbench would ask a server with no project for its data. With no
 * usable answer the page is the workbench (the browser form).
 */
function Root() {
  const host = useHostAnswer();
  if (host === undefined) return null;
  if (host !== null && host.mode === "desktop" && host.project === "none") return <WelcomeShell />;
  return <Workbench />;
}

function Workbench() {
  // Background tasks' argument-graph notes are collected for the page's lifetime, whichever pane is open.
  useEffect(() => startMergeNotices(), []);
  return <Shell />;
}
