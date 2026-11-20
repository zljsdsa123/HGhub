import { markStartupReady } from "../legacyRuntime";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import StartupGate from "../app/startup/LaunchAnimation";
import { installPlaybackPageEvents, initPlaybackLog } from "../shared/diagnostics/playbackDiagnostics";
import { installRemoteController, registerStartupBack } from "./remote";
import { installTvDisplay } from "./display";
import { TvProvider } from "./TvProvider";
import TvPinGate from "./TvPinGate";
import TvApp from "./TvApp";
import "./tv.css";
installRemoteController();
installTvDisplay();
document.documentElement.classList.remove("theme-light");
installPlaybackPageEvents();
function TvStartup(){
  // Mounting the gate is startup success; agreement acceptance can take minutes.
  useEffect(()=>{
    markStartupReady();
    const frame=window.requestAnimationFrame(()=>{void initPlaybackLog();});
    return()=>window.cancelAnimationFrame(frame);
  },[]);
  return <StartupGate registerBack={registerStartupBack}><TvPinGate><TvProvider><TvApp/></TvProvider></TvPinGate></StartupGate>;
}
createRoot(document.getElementById("root")!).render(<TvStartup/>);
