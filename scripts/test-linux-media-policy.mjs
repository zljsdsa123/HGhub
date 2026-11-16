// Real Chromium CSP checks. Requests to the Linux media origin are intercepted;
// this never contacts an upstream site or the user's running media proxy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const linux = JSON.parse(await readFile(join(root, "src-tauri/tauri.linux.conf.json"), "utf8"));
const mediaOrigin = "http://127.0.0.1:17650";
const directives = policy => new Map(policy.split(";").map(value => value.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
const effective = { ...config.app.security, ...linux.app.security };
for (const key of ["csp", "devCsp"]) {
  const policy = directives(effective[key]);
  for (const directive of ["img-src", "media-src", "connect-src"]) {
    assert(policy.get(directive).includes(mediaOrigin), `${key}/${directive} must allow the Linux media proxy`);
    assert(!policy.get(directive).some(source => ["http:", "https:", "*", "http://127.0.0.1:*"].includes(source)), `${key}/${directive} must not broaden network access`);
    assert(!directives(config.app.security[key]).get(directive).includes(mediaOrigin), `${key}/${directive} loopback exception must remain Linux-only`);
  }
}
assert(directives(linux.app.security.csp).get("connect-src").includes(mediaOrigin), "Linux production override must retain the exact media origin");
const previousPolicy = policy => policy.split(";").map(value => value.trim().split(/\s+/).filter(source => source !== mediaOrigin).join(" ")).join("; ");
const policies = [
  { name: "default-production", value: config.app.security.csp, allowsMedia: false },
  { name: "previous-linux-development", value: previousPolicy(effective.devCsp), allowsMedia: false },
  { name: "current-linux-production", value: effective.csp, allowsMedia: true },
  { name: "current-linux-development", value: effective.devCsp, allowsMedia: true },
];
const targets = [mediaOrigin, "http://127.0.0.1:17651", "http://localhost:17650", "https://outside.fixture.invalid"];
const output = join(root, "test-results", "linux-media-policy", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "hghubx-csp-media-"));
const report = {
  environment: "Chromium enforces the actual default Tauri CSP; local generated video; all target requests intercepted. Existing Linux production override already allowed this origin; installed-package policy is not inferred by this test.",
  passed: [], violations: [], errors: [], intercepted: [], unexpected: [],
};
let server, browser;
try {
  const videoPath = join(temporary, "fixture.webm");
  execFileSync(process.env.FFMPEG_EXECUTABLE || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=cyan:s=32x32:r=5", "-t", "1", "-an", "-c:v", "libvpx", "-pix_fmt", "yuv420p", "-y", videoPath], { timeout: 30000 });
  const video = await readFile(videoPath);
  server = createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").searchParams.get("policy");
    const policy = policies.find(policy => policy.name === name);
    if (!policy) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy.value });
    res.end("<!doctype html><html><head><meta charset='utf-8'><title>Linux media policy fixture</title></head><body></body></html>");
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const uiOrigin = `http://127.0.0.1:${server.address().port}`;
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const path of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(path).then(() => true, () => false)) { executablePath = path; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  for (const policy of policies) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === uiOrigin) return route.continue();
      if (url.origin !== mediaOrigin) { report.unexpected.push(url.href); return route.abort(); }
      report.intercepted.push({ policy: policy.name, path: url.pathname });
      const headers = { "Access-Control-Allow-Origin": "*" };
      if (url.pathname === "/manifest.m3u8") return route.fulfill({ headers, contentType: "application/vnd.apple.mpegurl", body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n" });
      if (url.pathname === "/cover.svg") return route.fulfill({ headers, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="cyan"/></svg>' });
      if (url.pathname === "/video.webm") return route.fulfill({ headers, contentType: "video/webm", body: video });
      throw new Error(`Unexpected fixture media request: ${url.href}`);
    });
    await page.goto(`${uiOrigin}/?policy=${policy.name}`);
    await page.evaluate(() => {
      window.mediaPolicyViolations = [];
      document.addEventListener("securitypolicyviolation", event => window.mediaPolicyViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    });
    for (const target of targets) {
      const result = await page.evaluate(async target => {
        const fetches = fetch(`${target}/manifest.m3u8`).then(async response => response.ok && (await response.text()).startsWith("#EXTM3U"), () => false);
        const image = new Image();
        const images = new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth === 16); };
          image.onerror = () => { clearTimeout(timer); resolve(false); };
          image.src = `${target}/cover.svg`; document.body.append(image);
        });
        const video = document.createElement("video"); video.muted = true; video.preload = "auto";
        const videos = new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          video.onloadeddata = () => { clearTimeout(timer); resolve(video.videoWidth === 32); };
          video.onerror = () => { clearTimeout(timer); resolve(false); };
          video.src = `${target}/video.webm`; document.body.append(video);
        });
        const [connect, img, media] = await Promise.all([fetches, images, videos]);
        image.remove(); video.pause(); video.removeAttribute("src"); video.load(); video.remove();
        return { connect, img, media };
      }, target);
      const expected = policy.allowsMedia && target === mediaOrigin;
      assert.deepEqual(result, { connect: expected, img: expected, media: expected }, `${policy.name} → ${target}`);
      report.passed.push({ policy: policy.name, target, expected: expected ? "allowed" : "blocked", ...result });
    }
    report.violations.push({ policy: policy.name, entries: await page.evaluate(() => window.mediaPolicyViolations) });
    await context.close();
  }
  assert.deepEqual(report.unexpected, [], "Other loopback ports/hosts and upstream sites must remain blocked before requests are sent");
  assert.deepEqual(report.errors, []);
  assert(report.intercepted.some(entry => entry.path === "/video.webm"), "Allowed native video must reach the media fixture");
  console.log(`PASS: ${report.passed.length * 3} real-browser CSP resource checks; Linux production/development allow the exact media origin; default policy and other hosts/ports remain blocked`);
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(temporary, { recursive: true, force: true });
  console.log(`Artifacts: ${output}`);
}
