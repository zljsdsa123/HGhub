import type { Plugin } from "vite";
import postcss, { type Plugin as PostcssPlugin } from "postcss";
import presetEnv from "postcss-preset-env";
import { transform } from "lightningcss";
import { readFileSync } from "node:fs";

// Run after CSS collection: cascade-layer priorities must be computed against
// the entire stylesheet, including styles imported by lazy-loaded pages.
const fallbacks: PostcssPlugin = {
  postcssPlugin: "hghubx-legacy-values",
  Once(root) {
    root.walkDecls(declaration => {
      if (/dv[hw]\b/.test(declaration.value)) {
        declaration.cloneBefore({ value: declaration.value.replace(/dv([hw])\b/g, "v$1") });
      }
      // Dynamic colour mixing cannot be statically evaluated. Keep the source
      // colour as a readable fallback; supporting engines retain the mix.
      if (declaration.value.startsWith("color-mix(")) {
        const first = /^color-mix\(in [\w-]+,\s*(var\(--[\w-]+\)|currentColor)/.exec(declaration.value);
        const rule = declaration.parent;
        if (first && rule?.type === "rule") {
          // var() declarations can fail at computed-value time; an earlier
          // declaration alone is not a fallback. Override only on old engines.
          const support = postcss.atRule({ name: "supports", params: "not (color: color-mix(in srgb, red, blue))" });
          const fallback = postcss.rule({ selector: rule.selector });
          fallback.append(declaration.clone({ value: first[1] }));
          support.append(fallback);
          rule.after(support);
        }
      }
    });
  },
};

export function legacyCss(): Plugin {
  return {
    name: "hghubx-legacy-css",
    apply: "build",
    enforce: "post",
    async generateBundle(_, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
        const source = typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
        const compatibility = readFileSync(new URL("../src/styles/legacy-webview.css", import.meta.url), "utf8");
        const result = await postcss([
          fallbacks,
          presetEnv({
            browsers: ["Chrome >= 66", "Safari >= 13"],
            stage: 2,
            features: {
              "cascade-layers": true,
              "nesting-rules": true,
              "custom-properties": false,
              "focus-visible-pseudo-class": false,
              "focus-within-pseudo-class": false,
              "has-pseudo-class": false,
            },
          }),
        ]).process(`${source}\n${compatibility}`, { from: asset.fileName, map: false });
        for (const warning of result.warnings()) this.warn(warning.toString());
        asset.source = transform({
          filename: asset.fileName,
          code: Buffer.from(result.css),
          targets: { chrome: 66 << 16, safari: 13 << 16 },
          minify: true,
        }).code;
      }
    },
  };
}
