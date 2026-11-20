// 构建期按 edition 解析入口：标准版 src/main.tsx，TV 版 src/tv/bootstrap.tsx。
// 先同步装配旧版 WebView 垫片，再在同一入口 chunk 内直接装载对应版本，避免额外动态分包瀑布流。
import "./legacyRuntime";
import "@edition-bootstrap";
