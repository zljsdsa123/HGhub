import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/store";
import Settings from "../src/pages/Settings";
import { ToastHost } from "../src/components/ui";
import { copyText } from "../src/clipboard";
import "../src/index.css";

Object.assign(window, { copyFixtureText: copyText });
createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Settings wide={false} onBack={() => {}} />
    <ToastHost />
  </AppProvider>,
);
