import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import "./argelander.css";
import "./styles.css";
import "./writer/writer.css";
import "./i18n";
import { App } from "./App";
import { installPageErrorReporting } from "./page-errors";

// Errors nothing handled are reported to the server's log: their kind, class name and script locations only.
installPageErrorReporting();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
