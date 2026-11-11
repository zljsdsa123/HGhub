#!/usr/bin/env python3
"""把 Tauri 生成的 "Build Rust Code" 脚本阶段换成直接的 cargo 构建。

Tauri 的 xcode-script 必须连上一个由 `tauri ios dev|build` 启动的 WebSocket
服务才能读到构建选项，CI 里裸跑 xcodebuild 拿不到，会直接 panic。这里绕开
它：自己 cargo build 出静态库，放到工程声明好的链接位置。

用法: python3 scripts/patch-ios-pbxproj.py [静态库名]
"""
import glob
import re
import sys

LIB_NAME = sys.argv[1] if len(sys.argv) > 1 else "libapp.a"
CRATE_LIB = "libhuangguo_client_lib.a"
TARGET = "aarch64-apple-ios"

projects = glob.glob("src-tauri/gen/apple/*.xcodeproj/project.pbxproj")
if not projects:
    sys.exit("没有找到 src-tauri/gen/apple/*.xcodeproj/project.pbxproj")
path = projects[0]

DQ = '\\"'
script = (
    "cd " + DQ + "$SRCROOT/../.." + DQ + " && "
    "cargo build --target " + TARGET + " --release --lib && "
    "mkdir -p " + DQ + "$SRCROOT/Externals/arm64/$CONFIGURATION" + DQ + " && "
    "cp target/" + TARGET + "/release/" + CRATE_LIB + " "
    + DQ + "$SRCROOT/Externals/arm64/$CONFIGURATION/" + LIB_NAME + DQ
)

src = open(path, encoding="utf-8").read()

# pbxproj 里的字符串用 \" 转义引号，不能简单用 [^"]* 匹配
pat = re.compile(r'shellScript = "((?:[^"\\]|\\.)*)";')
hits = []


def repl(m):
    body = m.group(1)
    if "xcode-script" not in body:
        return m.group(0)
    hits.append(body[:60])
    return 'shellScript = "' + script + '";'


new = pat.sub(repl, src)

if len(hits) != 1:
    for m in pat.finditer(src):
        print("现有脚本:", m.group(1)[:100])
    sys.exit("找到 %d 处 xcode-script，预期 1 处" % len(hits))

open(path, "w", encoding="utf-8").write(new)
print("已替换 Build Rust Code 脚本 ->", path)
print("原脚本开头:", hits[0])
print("新脚本:", script)