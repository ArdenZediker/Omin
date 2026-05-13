import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PromptDialogProvider } from "./components/PromptDialog";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromptDialogProvider>
      <App />
    </PromptDialogProvider>
  </React.StrictMode>,
);
