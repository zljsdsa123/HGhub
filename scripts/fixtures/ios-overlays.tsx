import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Modal, Sheet } from "../../src/components/ios/overlays";
import { registerOverlayBack, runBack, setBackHandler } from "../../src/back";

const events = { closed: [] as string[], escapedToPage: 0 };

function Fixture() {
  const initiallyNested = new URLSearchParams(location.search).has("nested");
  const [parent, setParent] = useState(initiallyNested);
  const [child, setChild] = useState(initiallyNested);
  const [empty, setEmpty] = useState(false);
  Object.assign(window, { iosOverlayFixture: { setParent, runBack, registerOverlayBack, setBackHandler, events } });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") events.escapedToPage++; };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <main id="background">
    <button id="opener" onClick={() => setParent(true)}>Open parent</button>
    <button id="empty-opener" onClick={() => setEmpty(true)}>Open empty</button>
    <Modal open={parent} onClose={() => { events.closed.push("parent"); setParent(false); }} label="Parent">
      {/* Native autoFocus runs before the frame's layout effect; its opener must survive. */}
      <button id="first" data-autofocus autoFocus={!initiallyNested} onClick={() => setChild(true)}>Open child</button>
      <button id="skip" tabIndex={-1}>Skip in tab order</button>
      <div id="custom" tabIndex={0}>Focusable custom control</div>
      <button id="last">Last</button>
      <Sheet open={child} onClose={() => { events.closed.push("child"); setChild(false); }} label="Child">
        <button id="child-first" data-autofocus>Child first</button>
        <button id="child-last">Child last</button>
      </Sheet>
    </Modal>
    <Modal open={empty} onClose={() => setEmpty(false)} label="Empty"><p>No interactive controls</p></Modal>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
