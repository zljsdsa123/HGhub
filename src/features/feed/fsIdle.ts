import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 播放器控件闲置自动隐藏（#146-3）。
 * 桌面：2.8s，键盘聚焦控件/菜单时不隐藏（原行为不变）。
 * 移动沉浸全屏：按设置秒数（0=不自动隐藏）；拖动进度条期间挂起隐藏计时。 */
export function useFsIdle(
  isDesktop: boolean,
  fs: boolean,
  paused: boolean,
  mobileSecs: number,
  boxRef: RefObject<HTMLDivElement | null>,
  suspended = false,
) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const delay = isDesktop ? 2800 : fs ? mobileSecs * 1000 : 0;
  const delayRef = useRef(delay);
  delayRef.current = delay;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  const arm = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!delayRef.current || suspendedRef.current) return;
    timer.current = window.setTimeout(() => {
      if (suspendedRef.current) return;
      // Keyboard users must keep seeing the focused control/menu.
      if (isDesktop && boxRef.current?.parentElement?.contains(document.activeElement) && document.activeElement?.closest(".desktop-controls")) return;
      setIdle(true);
    }, delayRef.current);
  }, [isDesktop, boxRef]);

  const wake = useCallback(() => { setIdle(false); arm(); }, [arm]);

  useEffect(() => {
    if (isDesktop || fs) wake();
    else { setIdle(false); window.clearTimeout(timer.current); }
    return () => window.clearTimeout(timer.current);
  }, [isDesktop, fs, wake]);

  useEffect(() => {
    if (paused || suspended) {
      setIdle(false);
      window.clearTimeout(timer.current);
    } else if (isDesktop || fs) {
      arm();
    }
  }, [paused, suspended, isDesktop, fs, arm]);

  return { idle, setIdle, wake, arm };
}
