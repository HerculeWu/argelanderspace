import { Shell } from "./hubble/Shell";

// HubbleSpace workspace shell. The document reader lives inside it as the 文档
// pane (see doc/DocPane.tsx); the literature manager is the 文献 pane.
export function App() {
  return <Shell />;
}
