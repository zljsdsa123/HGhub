import type { ReactNode } from "react";
import { IChevR } from "../icons";
import { Button, Surface } from "./ios/controls";

/** Keep the panel mounted so collapsing a group preserves drafts and async state. */
export default function SettingsSection({ title, summary, open, onToggle, children }: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const triggerId = `settings-title-${title}`;
  const panelId = `settings-panel-${title}`;
  return <section id={`settings-${title}`} aria-labelledby={triggerId} className="ios-settings-section">
    <Surface className="ios-setting-group ios-settings-frame" data-open={open}>
      <h2 aria-label={title}>
        <Button id={triggerId} aria-label={`${title}设置`} aria-expanded={open} aria-controls={panelId}
          onClick={onToggle} className="ios-settings-trigger">
          <span className="ios-settings-heading">
            <span className="ios-settings-title">{title}</span>
            <span className="ios-settings-summary">{summary}</span>
          </span>
          <IChevR size={18} aria-hidden="true" className="ios-settings-chevron" />
        </Button>
      </h2>
      <div id={panelId} hidden={!open} className="ios-settings-panel">
        <div className="ios-settings-fields">{children}</div>
      </div>
    </Surface>
  </section>;
}
