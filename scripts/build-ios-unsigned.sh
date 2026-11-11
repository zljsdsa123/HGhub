#!/usr/bin/env bash
# 照上游 Minireel/HGhub scripts/build-ios-unsigned.sh 重写（9ca6972）。
# 关键点：不再用 cargo 直出静态库 + -Wl,-undefined,dynamic_lookup，
# 而是让 tauri ios build 的 options server 活着，由 Xcode 自己跑 Build Rust Code，
# 并把 Swift 兼容库目录指到 Xcode toolchain 里（Xcode 26 挪了位置）。
set -euo pipefail

VERSION="${1:?Usage: build-ios-unsigned.sh VERSION}"
ROOT="$(pwd)"
LOG="$ROOT/ios-build-session.log"
ADDR_FILE="$(node -p "require('os').tmpdir() + '/' + require('./src-tauri/tauri.conf.json').identifier + '-server-addr'")"
mkdir -p artifacts
rm -f "$ADDR_FILE"

# Tauri 没有 ios --no-sign。让它的 release options server 一直活着，
# 否则 Xcode 的 Build Rust Code 阶段连不上它会直接 panic。
pnpm tauri ios build --open --ci --features custom-protocol >"$LOG" 2>&1 &
SESSION_PID=$!
cleanup() {
  kill "$SESSION_PID" 2>/dev/null || true
  cat "$LOG"
}
trap cleanup EXIT
for ((attempt = 0; attempt < 240; attempt++)); do
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then
    echo "Tauri build session exited before becoming ready" >&2
    exit 1
  fi
  if [[ -s "$ADDR_FILE" ]]; then
    break
  fi
  sleep 1
done
if [[ ! -s "$ADDR_FILE" ]]; then
  echo "Timed out waiting for the Tauri build options server" >&2
  exit 1
fi

# 工程名 / scheme 动态取（我们的 productName 是 HGhub，上游是 huangguo-client）
PROJECT="$(cd src-tauri/gen/apple && ls -d *.xcodeproj | head -1)"
SCHEME="$(cd src-tauri/gen/apple && xcodebuild -list -project "$PROJECT" 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{print $1;exit}')"
if [[ -z "$PROJECT" || -z "$SCHEME" ]]; then
  echo "Cannot resolve xcodeproj / scheme: '$PROJECT' / '$SCHEME'" >&2
  ls -la src-tauri/gen/apple >&2 || true
  exit 1
fi
echo "project=$PROJECT scheme=$SCHEME"

# Xcode 生成的配置是小写 release；Swift 兼容库要显式指到 toolchain 里
XCODE_TOOLCHAIN="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain"
test -d "$XCODE_TOOLCHAIN/usr/lib/swift/iphoneos"

xcodebuild build \
  -toolchain com.apple.dt.toolchain.XcodeDefault \
  -project "src-tauri/gen/apple/$PROJECT" \
  -scheme "$SCHEME" \
  -configuration release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/build_output" \
  TOOLCHAIN_DIR="$XCODE_TOOLCHAIN" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

APP_DIR="$ROOT/build_output/Build/Products/release-iphoneos"
APP="$(ls -d "$APP_DIR"/*.app 2>/dev/null | head -1)"
if [[ -z "$APP" ]]; then
  echo "No .app produced under $APP_DIR" >&2
  exit 1
fi
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")
test -s "$APP/$EXECUTABLE"
file "$APP/$EXECUTABLE" | grep "Mach-O.*arm64"

# 注意：Tauri 会把整份配置（含 devUrl）嵌进二进制，release 包里也能 grep 到
# localhost:1420，不能据此判定 dev build。真正的判据是上面 file 出的
# release 产物 + Xcode 用的是 release 配置。
strings "$APP/$EXECUTABLE" > "$ROOT/ios-binary-strings.txt"
if grep -F "localhost:1420" "$ROOT/ios-binary-strings.txt" >/dev/null; then
  echo "warn: binary embeds devUrl string (normal for Tauri release builds)"
fi

PACKAGE_DIR=$(mktemp -d)
mkdir -p "$PACKAGE_DIR/Payload"
cp -R "$APP" "$PACKAGE_DIR/Payload/"
IPA="$ROOT/artifacts/HGhub_${VERSION}_ios.ipa"
(cd "$PACKAGE_DIR" && zip -qr "$IPA" Payload)
unzip -tq "$IPA"
ls -lh "$IPA"
