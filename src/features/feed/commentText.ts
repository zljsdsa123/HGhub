import DOMPurify from "dompurify";

const PARAGRAPHS = ["p", "div", "li", "blockquote", "pre"];

/** 评论只显示纯文本；使用惰性模板解析，不加载评论中的图片或链接。 */
export function commentText(raw: string): string {
  if (!raw || !DOMPurify.isSupported) return "";
  let text = raw;
  // 兼容被实体编码的标签；限制轮数，避免反复解析异常输入。
  for (let pass = 0; pass < 3; pass++) {
    const template = document.createElement("template");
    template.innerHTML = text;
    const fragment = DOMPurify.sanitize(template.content, {
      ALLOWED_TAGS: ["br", ...PARAGRAPHS],
      ALLOWED_ATTR: [],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ADD_FORBID_CONTENTS: ["object", "embed", "textarea"],
      RETURN_DOM_FRAGMENT: true,
    });
    fragment.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    fragment.querySelectorAll(PARAGRAPHS.join(",")).forEach((node) => {
      node.prepend("\n");
      node.append("\n");
    });
    const next = (fragment.textContent || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
    if (next === text) break;
    text = next;
    if (!/[<&]/.test(text)) break;
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
