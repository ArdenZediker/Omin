import ReactDOM from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import App from "./App";
import { PromptDialogProvider } from "./components/PromptDialog";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PromptDialogProvider>
    <App />
  </PromptDialogProvider>,
);
