import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore, useToasts } from "../src/shared/model/store";
import Profile from "../src/features/account/Profile";
import { ToastHost } from "../src/shared/ui/ui";
import "../src/index.css";

// 探针：把真实的 toast() 与当前 toast 列表暴露给回归脚本。
// toast 列表来自模块级外部 store（useToasts），与 ToastHost 渲染的是同一份数据。
function Probe() {
  const { toast } = useStore();
  const toasts = useToasts();
  useEffect(() => {
    Object.assign(window, { uiFeedbackProbe: { toast, toasts: () => toasts } });
  }, [toast, toasts]);
  return null;
}

// Profile 是真实的 .ios-page 消费者：
//   .ios-page > .ios-page-heading.shrink-0（标题头栏）
//   .ios-page > .ios-page-body.scroll-y（滚动体）
// 宽屏限宽居中契约直接量这两个直接子元素的几何。
createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Profile wide={true} />
    <ToastHost />
    <Probe />
  </AppProvider>,
);
