import { useContentPreferences } from "../contentPreferences";
import { Button } from "./ios/controls";

/** Remains available even when filtering removes the item that opened the menu. */
export function PreferenceStorageNotice({ className = "" }: { className?: string }) {
  const { storageError, blockTags } = useContentPreferences();
  if (!storageError) return null;
  return <div role="alert" className={`rounded-(--r-sm) bg-s3 p-3 text-left text-[13px] leading-relaxed ${className}`} data-preference-storage-notice>
    <p className="text-danger break-words">{storageError}</p>
    <Button className="mt-1 min-h-11 px-3 text-on" onClick={() => blockTags([])}>重试保存</Button>
  </div>;
}
