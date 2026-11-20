import { useEffect } from "react";
import App from "./App";
import { AppProvider } from "../shared/model/store";
import { initAutoLine } from "../shared/network/autoLine";

/** Account restore, line probes and content requests begin only after agreement. */
export default function AcceptedApp() {
  useEffect(() => { initAutoLine(); }, []);
  return <AppProvider><App /></AppProvider>;
}
