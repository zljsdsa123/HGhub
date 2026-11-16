import { useEffect, useId, useState } from "react";
import { isMobile } from "../api";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, normalizeTag, useContentPreferences } from "../contentPreferences";
import { ICheck, IClose } from "../icons";
import { Button } from "./ios/controls";
import { Modal, Sheet } from "./ui";
import "../styles/content-preferences.css";

export function TagBlockMenu({ open, tags, onClose, onSettings }: {
  open: boolean; tags: readonly string[]; onClose: () => void; onSettings?: () => void;
}) {
  const { preferences, revision, storageError, blockTags, isTagBlocked } = useContentPreferences();
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const selectionId = useId();
  const optionsId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const names = tags.map(tag => typeof tag === "string" ? tag.trim().replace(/\s+/g, " ") : "");
  const options = names.filter((tag, index) => tag
    && names.findIndex(value => normalizeTag(value) === normalizeTag(tag)) === index);
  const identity = options.join("\u0000");
  useEffect(() => { setSelected([]); setSubmittedAt(null); setExpanded(false); }, [open, identity]);
  useEffect(() => {
    if (submittedAt === null || revision <= submittedAt) return;
    setSubmittedAt(null);
    if (!storageError) onClose();
  }, [submittedAt, revision, storageError, onClose]);
  const capacity = Math.max(0, MAX_BLOCKED_TAGS - preferences.blockedTags.length);
  const validSelected = selected.filter(tag => !isTagBlocked(tag) && tag.trim().length <= MAX_TAG_LENGTH).slice(0, capacity);
  const visibleOptions = expanded ? options : options.slice(0, 4);
  const content = <div className="content-tag-menu" data-expanded={expanded}>
    <header className="content-tag-menu-header">
      <div className="min-w-0">
        <h2 className="text-[18px] font-bold text-on">不感兴趣</h2>
        <p className="text-[12px] text-mut mt-1">选择不想看到的标签</p>
      </div>
      <Button aria-label="关闭不感兴趣" className="ios-icon-button" onClick={onClose}><IClose size={18} /></Button>
    </header>
    <div className="content-tag-menu-body" data-tag-menu-scroll>
      {preferences.paused && <p role="status" className="content-preference-note mb-2">屏蔽已暂停，保存后仍暂停，恢复后生效。</p>}
      {options.length ? <div id={optionsId} className="content-tag-options" role="group" aria-label="选择屏蔽标签">
        {visibleOptions.map(tag => {
          const blocked = isTagBlocked(tag), tooLong = tag.trim().length > MAX_TAG_LENGTH;
          const checked = selected.includes(tag), label = `${tag}${blocked ? " · 已屏蔽" : tooLong ? " · 标签过长" : ""}`;
          return <Button key={normalizeTag(tag)} aria-label={label} disabled={blocked || tooLong || (!checked && validSelected.length >= capacity)} aria-pressed={checked || blocked}
            className="content-tag-option" data-selected={checked} data-blocked={blocked}
            onClick={() => setSelected(previous => previous.includes(tag) ? previous.filter(value => value !== tag) : [...previous, tag])}>
            <span className="content-tag-option-mark" aria-hidden="true">{(checked || blocked) && <ICheck size={13} />}</span>
            <span>{label}</span>
          </Button>;
        })}
      </div> : <div className="content-preference-empty"><p className="font-semibold text-on">暂无可选标签</p><p className="mt-1">可在管理页添加标签。</p></div>}
      {options.length > 4 && <Button className="content-tag-menu-expand" aria-expanded={expanded} aria-controls={optionsId}
        onClick={() => setExpanded(value => !value)}>{expanded ? "收起标签" : `全部标签（${options.length}）`}</Button>}
      {capacity === 0 && <p role="status" className="content-preference-note mt-3">已达到 {MAX_BLOCKED_TAGS} 个屏蔽标签上限，请到设置中清理后再添加。</p>}
      {capacity > 0 && capacity < options.filter(tag => !isTagBlocked(tag)).length && <p role="status" className="mt-3 text-[13px] text-mut">还可添加 {capacity} 个标签。</p>}
      {storageError && <div role="alert" className="content-preference-note mt-3 text-danger"><p>{storageError}</p>
        <Button className="min-h-11 px-3 text-on" onClick={() => { setSubmittedAt(revision); blockTags([]); }}>重试保存</Button>
      </div>}
    </div>
    <footer className="content-tag-menu-footer">
      <p id={selectionId} role="status" aria-live="polite" className="sr-only">{validSelected.length ? `已选择 ${validSelected.length} 个标签` : "请选择要屏蔽的标签"}</p>
      <div className="content-tag-menu-actions">
        {onSettings && <Button className="content-tag-menu-manage text-mut" onClick={() => { onClose(); onSettings(); }}>管理屏蔽标签</Button>}
        {options.length > 0 && <Button variant="primary" aria-label="屏蔽所选标签" aria-describedby={selectionId} disabled={!validSelected.length} onClick={() => { setSubmittedAt(revision); blockTags(validSelected); }}>屏蔽 · {validSelected.length}</Button>}
      </div>
    </footer>
  </div>;
  return isMobile ? <Sheet open={open} onClose={onClose} label="不感兴趣" z="content-preference-overlay">{content}</Sheet>
    : <Modal open={open} onClose={onClose} label="不感兴趣" width={400}>{content}</Modal>;
}
