#!/usr/bin/env python3
"""Exercise Linux's native WebKit media path without touching system settings.

Run with /usr/bin/python3 (PyGObject/WebKitGTK 4.1), under xvfb-run when headless.
Dependencies: ffmpeg, installed node_modules/hls.js. Only local generated video
and ephemeral WebKit storage are used. --mode all expects the deliberately
proxied baseline to fail, NoProxy to play, and a fresh baseline to fail again.
"""

import argparse
import functools
import http.server
import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]


def run_probe(mode):
    import gi

    for api, version in [("Gtk", "3.0"), ("WebKit2", "4.1"), ("Soup", "3.0")]:
        gi.require_version(api, version)
    from gi.repository import Gio, GLib, Gtk, Soup, WebKit2

    hits = {"proxy": 0, "media": 0}
    events = []
    outcome = {"played": False, "blocked": False, "frames": 0}
    with tempfile.TemporaryDirectory(prefix="hghubx-webkit-test-") as directory:
        fixture = pathlib.Path(directory)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "testsrc2=size=160x90:rate=24", "-t", "5", "-an",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             "-g", "24", "-sc_threshold", "0", "-f", "hls", "-hls_time", "1",
             "-hls_list_size", "0", str(fixture / "index.m3u8")],
            check=True,
        )

        class MediaHandler(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):
                hits["media"] += 1
                super().do_GET()

            def end_headers(self):
                self.send_header("Access-Control-Allow-Origin", "*")
                super().end_headers()

            def log_message(self, *_args):
                pass

        class ProxyHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits["proxy"] += 1
                self.send_response(502)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args):
                pass

        media = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(MediaHandler, directory=directory)
        )
        proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
        for server in (media, proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{media.server_port}"
        proxy_uri = f"http://127.0.0.1:{proxy.server_port}"
        csp = json.loads((ROOT / "src-tauri/tauri.linux.conf.json").read_text())["app"]["security"]["csp"]
        csp = csp.replace("http://127.0.0.1:17650", origin)
        script = r"""
const post = value => window.webkit.messageHandlers.probe.postMessage(JSON.stringify(value));
document.addEventListener('securitypolicyviolation', e => post({event:'csp', directive:e.effectiveDirective}));
(async () => {
  const video = document.querySelector('video');
  video.muted = true;
  try {
    const response = await fetch(TARGET);
    const body = await response.text();
    post({event:'fetch', status:response.status, hls:body.startsWith('#EXTM3U')});
  } catch (error) {
    post({event:'fetch_error'});
  }
  if (!Hls.isSupported()) {
    post({event:'unsupported'});
    return;
  }
  const hls = new Hls({enableWorker:false, maxBufferLength:6, manifestLoadingMaxRetry:0});
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) post({event:'fatal', detail:data.details});
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    post({event:'manifest'});
    video.play().catch(() => post({event:'play_rejected'}));
  });
  hls.loadSource(TARGET);
  hls.attachMedia(video);
  const timer = setInterval(() => {
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames || video.webkitDecodedFrameCount || 0;
    if (video.currentTime >= 1.5 && frames >= 24) {
      clearInterval(timer);
      post({event:'played', frames, ready:video.readyState});
    }
  }, 100);
})();
""".replace("TARGET", json.dumps(origin + "/index.m3u8"))
        assets = {
            "/": (b'<html><head><script src="tauri://localhost/hls.js"></script></head>'
                   b'<body><video playsinline muted></video><script src="tauri://localhost/probe.js"></script></body></html>', "text/html"),
            "/hls.js": ((ROOT / "node_modules/hls.js/dist/hls.min.js").read_bytes(), "application/javascript"),
            "/probe.js": (script.encode(), "application/javascript"),
        }
        context = WebKit2.WebContext.new_ephemeral()
        context.get_security_manager().register_uri_scheme_as_secure("tauri")
        data_manager = context.get_website_data_manager()
        # Model the system proxy using an isolated, deterministic failing proxy.
        # The product's fix must override this on the WebsiteDataManager only.
        settings = WebKit2.NetworkProxySettings.new(proxy_uri, [])
        data_manager.set_network_proxy_settings(WebKit2.NetworkProxyMode.CUSTOM, settings)
        if mode == "modified":
            data_manager.set_network_proxy_settings(WebKit2.NetworkProxyMode.NO_PROXY, None)

        def handle(request):
            path = urllib.parse.urlparse(request.get_uri()).path or "/"
            body, mime = assets.get(path, (b"not found", "text/plain"))
            response = WebKit2.URISchemeResponse.new(
                Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(body)), len(body)
            )
            response.set_content_type(mime)
            headers = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
            headers.append("Content-Security-Policy", csp)
            response.set_http_headers(headers)
            request.finish_with_response(response)

        context.register_uri_scheme("tauri", handle)
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("probe")

        def message(_manager, value):
            row = json.loads(value.get_js_value().to_string())
            events.append(row)
            if row["event"] == "played":
                outcome.update(played=True, frames=row["frames"])
                GLib.idle_add(Gtk.main_quit)
            elif row["event"] == "fatal":
                outcome["blocked"] = True
                GLib.idle_add(Gtk.main_quit)

        manager.connect("script-message-received::probe", message)
        view = WebKit2.WebView(web_context=context, user_content_manager=manager)
        window = Gtk.Window()
        window.set_default_size(240, 180)
        window.add(view)
        window.show_all()
        view.load_uri("tauri://localhost/")

        def timeout():
            events.append({"event": "timeout"})
            Gtk.main_quit()
            return False

        timeout_id = GLib.timeout_add_seconds(25, timeout)
        Gtk.main()
        if not any(row["event"] == "timeout" for row in events):
            GLib.source_remove(timeout_id)
        window.destroy()
        for server in (media, proxy):
            server.shutdown()
            server.server_close()

    passed = outcome["played"] and hits["proxy"] == 0 and hits["media"] >= 3
    blocked = (not outcome["played"] and outcome["blocked"]
               and hits["proxy"] > 0 and hits["media"] == 0)
    result = "played" if passed else "blocked" if blocked else "unexpected"
    print(json.dumps({"mode": mode, "result": result, "proxy_requests": hits["proxy"],
                      "media_requests": hits["media"], "frames": outcome["frames"], "events": events}), flush=True)
    return 0 if passed else 1 if blocked else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["all", "baseline", "modified"], default="all")
    args = parser.parse_args()
    if args.mode != "all":
        return run_probe(args.mode)
    for label, mode, expected in [("BASELINE", "baseline", 1),
                                  ("MODIFIED", "modified", 0),
                                  ("ROLLBACK", "baseline", 1)]:
        process = subprocess.run([sys.executable, __file__, "--mode", mode],
                                 capture_output=True, text=True)
        sys.stdout.write(process.stdout)
        if process.returncode != expected:
            sys.stderr.write(process.stderr)
            print(f"{label}: FAIL exit={process.returncode} expected={expected}", flush=True)
            return 1
        try:
            result = json.loads(process.stdout.strip().splitlines()[-1])["result"]
        except (json.JSONDecodeError, IndexError, KeyError):
            print(f"{label}: FAIL invalid probe output", flush=True)
            return 1
        print(f"{label}: {result} exit={process.returncode}", flush=True)
    print("PASS: native WebKit proxy regression; ephemeral rollback restored blocked behavior", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
