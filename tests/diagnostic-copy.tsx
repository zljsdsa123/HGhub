import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import Settings from "../src/features/settings/Settings";
import { ToastHost } from "../src/shared/ui/ui";
import { copyText } from "../src/shared/lib/clipboard";
import "../src/index.css";

Object.assign(window, { copyFixtureText: copyText });
createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Settings wide={false} onBack={() => {}} />
    <ToastHost />
  </AppProvider>,
);
