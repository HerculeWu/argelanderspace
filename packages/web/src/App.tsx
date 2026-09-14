import { Shell } from "./argelander/Shell";

// ArgelanderSpace workspace shell. The document reader lives inside it as the doc
// pane (see doc/DocPane.tsx); the literature manager is the library pane.
export function App() {
  return <Shell />;
}
