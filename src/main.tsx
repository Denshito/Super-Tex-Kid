import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// React owns the UI below #root. StrictMode adds development-only checks and
// replays lifecycle effects to expose missing cleanup code.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
