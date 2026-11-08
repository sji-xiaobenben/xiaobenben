#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
# Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)
# ─────────────────────────────────────────────────────────────────────────────
# 本地应急发版—— 当 GitHub Actions 不可用（额度耗尽、上游故障、
# 紧急修一个已发出的坏版本）时的旁路。**这也是"push master 全自动"之外的唯一人工通道。**
#
# 它做的事与 CI 的 build+publish 完全一致：交叉编译四平台 → 组装旁路包 → 算清单 → 签名
# → 校验 → 上传 OSS。清单/签名/裁剪逻辑全部复用 tools/*.ts，不存在"本地一套、CI 一套"。
#
# 用法:
#   VERSION=0.4.99 ./tools/publish-local.sh                 # 只构建+签名+自检，不上传
#   VERSION=0.4.99 ./tools/publish-local.sh --upload --yes  # 真上传（生产写操作，需 --yes）
#
# 前置：
#   1) bun 在 PATH（交叉编译靠它）
#   2) 签名私钥：UPDATE_SIGNING_KEY 环境变量，或 ~/.xbb-keys/xbb-update-signing.pem
#   3) 上传时另需 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（临时凭据再加 OSS_SESSION_TOKEN）
#      —— 只从环境变量读，绝不写进本脚本、绝不进 git
#
# ⚠️ 与 CI 的一个已知差异：Windows 主机上 darwin 目录的符号链接已被解引用，
#    因此 darwin 旁路包会比 CI 产的大约 44MB（内容等价，只是多一份重复 dylib）。
#    应急场景可接受；要拿到"标准"产物请走 CI。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # → cli/

# ⚠️ 必须与 tools/assemble-manifest.ts 的 REQUIRED **逐项对齐**（那边缺一平台即 exit 1）：
#    本列表少一个平台 ⇒ 应急发版必然在「组装清单」那步红，而报错在最后、排查成本高。
ALL_ARTS="windows-x64 linux-x64 darwin-arm64 darwin-x64"
OSSUTIL_VERSION="2.2.1"
OSSUTIL_SHA_LINUX="fbf1026bd383a5d9bee051cd64a6226c730357ba569491f7c7b91af66560ef1d"
OSSUTIL_SHA_WIN="a7c22a0172fdca0e54cb8366f1ae8a869bc6bb64c1899352eb62d8eb9a1a9af0"
OSS_BUCKET="${OSS_BUCKET:-xiaobenben-dl-prod}"
OSS_REGION="${OSS_REGION:-cn-shenzhen}"
DIST_BASE="${DIST_BASE:-https://dl.xiaobenben.net}"

DO_UPLOAD=0
CONFIRMED=0
ALLOW_DIRTY=0
SKIP_CHECKS=0
for arg in "$@"; do
  case "$arg" in
    --upload) DO_UPLOAD=1 ;;
    --yes) CONFIRMED=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（见 --help）"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

target_of() { case "$1" in windows-x64) echo bun-windows-x64 ;; linux-x64) echo bun-linux-x64 ;; darwin-arm64) echo bun-darwin-arm64 ;; darwin-x64) echo bun-darwin-x64 ;; *) return 1 ;; esac; }
ext_of()    { case "$1" in windows-x64) echo .exe ;; *) echo "" ;; esac; }
osdir_of()  { case "$1" in windows-x64) echo win32 ;; linux-x64) echo linux ;; darwin-arm64) echo darwin ;; darwin-x64) echo darwin ;; esac; }
arch_of()   { case "$1" in *-x64) echo x64 ;; *-arm64) echo arm64 ;; esac; }

# ── 0) 前置检查 ──────────────────────────────────────────────────────────────
say "前置检查"
[ -n "${VERSION:-}" ] || die "必须显式指定 VERSION（本地发版没有 run_number 可依），例如 VERSION=0.4.99 $0"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION 形态应为 x.y.z，当前: $VERSION"
command -v bun >/dev/null || die "找不到 bun（交叉编译需要它）"
echo "bun $(bun --version) · VERSION=$VERSION"

PEM="${UPDATE_SIGNING_KEY:-}"
if [ -z "$PEM" ] && [ -f "$HOME/.xbb-keys/xbb-update-signing.pem" ]; then
  PEM="$(cat "$HOME/.xbb-keys/xbb-update-signing.pem")"
  echo "签名私钥: 来自 ~/.xbb-keys/xbb-update-signing.pem"
fi
[ -n "$PEM" ] || die "缺签名私钥：设 UPDATE_SIGNING_KEY，或放到 ~/.xbb-keys/xbb-update-signing.pem"
export UPDATE_SIGNING_KEY="$PEM"

DIRTY=""
if [ -n "$(git status --porcelain)" ]; then
  DIRTY="(工作区脏)"
fi
if [ -n "$DIRTY" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  echo "工作区有未提交改动——本地发版会把它们一起编译进 exe，产物将无法与任何 commit 对应："
  git status --short
  die "确认无误请加 --allow-dirty 重跑"
fi
echo "HEAD = $(git rev-parse --short HEAD) $DIRTY"

# ── 1) 编译前置自检（与 CI gate 对齐）─────────────────────────────────────────
say "自检：私钥必须与 exe 内置公钥配对"
bun run tools/check-signing-key.ts

if [ "$SKIP_CHECKS" != "1" ]; then
  say "自检：typecheck + 测试套件"
  bun install --backend copyfile
  bun run typecheck
  bun run test:ci
else
  bun install --backend copyfile
  echo "（--skip-checks：已跳过 typecheck/测试）"
fi

OUT="dist/publish/v$VERSION"
# 下面有 rm -rf "$OUT"：先断言前缀，任何情况下都不让它指向 dist/publish 之外的路径
case "$OUT" in dist/publish/v[0-9]*) ;; *) die "内部错误：输出目录异常（$OUT），拒绝继续";; esac
ROOT="$(pwd)"
ART="$OUT/artifacts"
WORK="$OUT/.work"
rm -rf "$OUT"
mkdir -p "$ART" "$WORK"

# 编译期注入：改的是受版本控制的源码，结束时必须还原（否则会把注入值提交进仓库）
ORIG_META="$WORK/build-meta.ts.orig"
cp src/build-meta.ts "$ORIG_META"
restore_meta() { cp "$ORIG_META" src/build-meta.ts; }
trap restore_meta EXIT

# ── 2) 编译四平台 ────────────────────────────────────────────────────────────
say "编译四平台（交叉编译，含 darwin arm64/x64）"
BT=$(date -u '+%Y-%m-%d %H:%M')
UU="${DIST_BASE}/channels/stable.json"
if sed --version >/dev/null 2>&1; then SEDINPLACE=(sed -i); else SEDINPLACE=(sed -i ''); fi   # GNU vs BSD/macOS
"${SEDINPLACE[@]}" "s#export const VERSION = \".*\";#export const VERSION = \"${VERSION}\";#" src/build-meta.ts
"${SEDINPLACE[@]}" "s#export const BUILD_TIME = \".*\";#export const BUILD_TIME = \"${BT}\";#" src/build-meta.ts
"${SEDINPLACE[@]}" "s#export const UPDATE_URL_DEFAULT = \".*\";#export const UPDATE_URL_DEFAULT = \"${UU}\";#" src/build-meta.ts
grep -E '^export const (VERSION|BUILD_TIME|UPDATE_URL_DEFAULT)' src/build-meta.ts

bun build --target=bun --format=cjs --external "*.node" \
  --outfile node_modules/onnxruntime-node/dist/ort-bundle.cjs src/ort-bundle-entry.ts

for art in $ALL_ARTS; do
  tgt=$(target_of "$art"); ext=$(ext_of "$art")
  # 仅 darwin-x64 需外部化 onnxruntime-node：上游**不发** darwin/x64 原生绑定，不外部化时
  # bun 展开 binding.js 里那句 `require('../bin/napi-v6/${platform}/${arch}/…node')` 会去解析
  # darwin/x64 而**编译期即失败**（`Could not resolve`）。判据与 CI 同源（release.yml 的
  # matrix.external 只对 darwin-x64 非空）。
  # ⚠️ 用 if 而不是 `[ … ] && EXTRA=…`：set -e 下后者在条件为假时整条语句返回 1、脚本当场中断。
  EXTRA=""
  if [ "$art" = "darwin-x64" ]; then EXTRA="--external onnxruntime-node"; fi
  printf '  · %-14s → %s\n' "$art" "$tgt"
  bun build --compile --target="$tgt" $EXTRA --outfile "$ART/xbb-$art$ext" src/index.ts
done

# ── 3) 冒烟 ──────────────────────────────────────────────────────────────────
say "冒烟"
for art in $ALL_ARTS; do
  ext=$(ext_of "$art"); tgt=$(target_of "$art"); f="$ART/xbb-$art$ext"
  case "$tgt" in
    bun-darwin-*)
      # ⚠️ 架构必须**分派验**，不能「任意 Mach-O 就算过」——那正好放行架构搞反的产物：
      #    Intel Mac 拿到 arm64 壳（或反之）都是装完启动不了。与 CI 的断言逐字同源。
      case "$art" in
        darwin-arm64) WANT="cffaedfe0c000001"; DESC="arm64" ;;
        darwin-x64)   WANT="cffaedfe07000001"; DESC="x86_64" ;;
        *) die "未登记的 darwin 产物段: $art（补登记时须同步更新本断言）" ;;
      esac
      MAGIC=$(od -An -tx1 -N8 "$f" | tr -d ' \n')
      [ "$MAGIC" = "$WANT" ] || die "xbb-$art 不是 darwin-$DESC Mach-O（magic=$MAGIC，期望 $WANT）"
      echo "  ✓ xbb-$art 是 darwin-$DESC Mach-O"
      ;;
    *)
      # 只有与宿主同平台的产物能真跑
      host=$(uname -s)
      if { [ "$tgt" = "bun-windows-x64" ] && [[ "$host" == MINGW* || "$host" == MSYS* || "$host" == CYGWIN* ]]; } \
      || { [ "$tgt" = "bun-linux-x64" ] && [ "$host" = "Linux" ]; }; then
        chmod +x "$f"; echo "  ▸ $("$f" version | head -1)"
      else
        echo "  · xbb-$art（非宿主平台，跳过执行）"
      fi
      ;;
  esac
done

# ── 4) 打包向量旁路（按平台裁剪）──────────────────────────────────────────────
say "打包向量旁路（只装本平台原生库）"
for art in $ALL_ARTS; do
  OSP=$(osdir_of "$art"); ARN=$(arch_of "$art")
  P=node_modules/onnxruntime-node
  # 上游 onnxruntime-node **不发全部「OS/arch」组合**：darwin/x64 就没有原生库。
  # 无库 ⇒ 该平台本不存在可用的向量旁路 ⇒ **跳过而非失败**。判据与 CI 的 Pack 步骤同源：
  # 看目录在不在（而不是硬编码平台名），上游哪天补发该组合，这里自动开始产出。
  # 运行时 loadOrt() 取不到模块即按 embedder.ts 的「双降级」红线退化为纯词法检索，其余功能完整。
  if [ ! -d "$P/bin/napi-v6/$OSP/$ARN" ]; then
    echo "  · $art 跳过向量旁路：$OSP/$ARN 无 onnxruntime 原生库（上游未发布该组合）"
    continue
  fi
  S="$WORK/ort-$art/onnxruntime-node"
  mkdir -p "$S/bin/napi-v6/$OSP"
  cp -R "$P/dist" "$S/dist"
  cp -R "$P/lib" "$S/lib"
  cp "$P/package.json" "$S/package.json"
  cp -R "$P/bin/napi-v6/$OSP/$ARN" "$S/bin/napi-v6/$OSP/$ARN"
  [ -f "$S/bin/napi-v6/$OSP/$ARN/onnxruntime_binding.node" ] || die "旁路包缺 onnxruntime_binding.node（$art）"

  # 绝对路径——打包时会把 cwd 切进 stage 目录，相对路径极易算错层级
  Z="$ROOT/$ART/xbb-ort-$art.zip"
  rm -f "$Z"
  if command -v zip >/dev/null 2>&1; then
    # -y：符号链接存成符号链接（darwin 包内 libonnxruntime.1.dylib 是软链，解引用会多出约 44MB）
    ( cd "$WORK/ort-$art" && zip -q -r -y "$Z" onnxruntime-node )
  else
    # Windows 无 zip；python zipfile 不保留符号链接，但 win32 目录本就没有软链
    ( cd "$WORK/ort-$art" && python -m zipfile -c "$Z" onnxruntime-node )
  fi
  printf '  · %-14s %s\n' "$art" "$(du -h "$Z" | cut -f1)"
done

# ── 5) 组装清单 + 签名 + 验签 ────────────────────────────────────────────────
say "组装清单 + ed25519 签名"
bun run tools/assemble-manifest.ts "$ART" "$VERSION" "${DIST_BASE}/releases/v${VERSION}" > "$OUT/manifest.json"
bun run tools/sign-manifest.ts "$OUT/manifest.json"
bun run tools/verify-manifest.ts "$OUT/manifest.json"

say "产物清单"
ls -lh "$ART" "$OUT/manifest.json" | sed 's/^/  /'
echo
echo "客户端将访问的地址："
echo "  清单   ${DIST_BASE}/channels/stable.json"
echo "  下载   ${DIST_BASE}/releases/v${VERSION}/xbb-<平台><ext>"

# ── 6) 上传（默认不传）──────────────────────────────────────────────────────
if [ "$DO_UPLOAD" != "1" ]; then
  say "未上传（dry-run）"
  echo "要真正发布，加 --upload --yes 重跑。产物已留在: $OUT"
  exit 0
fi

[ "$CONFIRMED" = "1" ] || die "上传是生产写操作，需显式 --yes 确认"
[ -n "${OSS_ACCESS_KEY_ID:-}" ] && [ -n "${OSS_ACCESS_KEY_SECRET:-}" ] \
  || die "缺 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（只从环境变量读）"

say "准备 ossutil"
OSSBIN=""
if command -v ossutil >/dev/null 2>&1; then
  OSSBIN="$(command -v ossutil)"
  echo "使用 PATH 上的 ossutil"
else
  host=$(uname -s)
  case "$host" in
    MINGW*|MSYS*|CYGWIN*) PLAT=windows-amd64; SHA="$OSSUTIL_SHA_WIN"; EXE=ossutil.exe ;;
    Linux)                 PLAT=linux-amd64;   SHA="$OSSUTIL_SHA_LINUX"; EXE=ossutil ;;
    *) die "本机（$host）没有 ossutil，且不自动下载 macOS 版（包名与 Windows/Linux 不同）——请先自行安装"
       ;;
  esac
  mkdir -p "$WORK/ossutil"
  curl -fsSL -o "$WORK/ossutil.zip" \
    "https://gosspublic.alicdn.com/ossutil/v2/${OSSUTIL_VERSION}/ossutil-${OSSUTIL_VERSION}-${PLAT}.zip"
  echo "${SHA}  $WORK/ossutil.zip" | sha256sum -c -
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$WORK/ossutil.zip" -d "$WORK/ossutil"
  else
    python -m zipfile -e "$WORK/ossutil.zip" "$WORK/ossutil"
  fi
  OSSBIN=$(find "$WORK/ossutil" -type f -name "$EXE" | head -1)
  [ -n "$OSSBIN" ] || die "解压后找不到 $EXE"
  chmod +x "$OSSBIN" 2>/dev/null || true
fi
"$OSSBIN" version

say "上传到 OSS（$OSS_BUCKET / $OSS_REGION）"
export OSS_ENDPOINT="https://oss-${OSS_REGION}.aliyuncs.com"
PREFIX="oss://${OSS_BUCKET}/releases/v${VERSION}"

# ⚠️ ossutil 2.x 用 --cache-control 设 HTTP 缓存头；1.x 的 --meta 在 2.x 已被移除，
#    传了会直接 "unknown flag: --meta" 而中断发布（与 release.yml 保持同一写法）。
"$OSSBIN" cp -r -f --region "$OSS_REGION" \
  --cache-control "public,max-age=31536000,immutable" "$ART/" "$PREFIX/"
"$OSSBIN" cp -f --region "$OSS_REGION" \
  --cache-control "no-cache" "$OUT/manifest.json" "oss://${OSS_BUCKET}/channels/stable.json"

say "回读校验（确认落地的字节就是签过的那份）"
"$OSSBIN" cp -f --region "$OSS_REGION" "oss://${OSS_BUCKET}/channels/stable.json" "$WORK/roundtrip.json"
bun run tools/verify-manifest.ts "$WORK/roundtrip.json"
cmp "$OUT/manifest.json" "$WORK/roundtrip.json"
echo "✓ 回读字节与本地完全一致"

# latest/ = 官网下载页 / 安装文档 / AI 指路的**唯一稳定地址**（不带版本号）。
# 应急发版若漏了这一步，官网就会继续把用户推向上一版——正是「手工快照与自动发布分叉」
# 那个坑的翻版。所以本地通道与 CI 必须刷同一个地址。
#
# ⚠️ 逐文件复制，不用 `ossutil cp -r`：递归复制要先 ListObjectsV2 列举源前缀，而 CI 的
#    OIDC 发布角色只授了 Put/Get → 403「The bucket you access does not belong to you.」
#    （2026-10-06 Release #20 实测踩到；报错信息极具误导性）。本机 AK 虽有 List 权限，
#    但两条通道必须同构，否则 CI 的路只有本机验证得出来。
# ⚠️ 校验同理，**不用 `ossutil stat`**：它要 GetObject + GetObjectAcl + GetBucketInfo 三个权限
#    （官方文档明列），CI 发布角色一个都没有多的 → stat 被拒、stdout 全空，而本机宽权限照样跑通。
#    2026-10-06 Release #21 就是栽在这条"本地能过、CI 必挂"上。下面两个探针只用 GetObject / 零鉴权。
say "刷新 latest/ 稳定别名"
LDIR="oss://${OSS_BUCKET}/latest"
bun run tools/gen-sha256sums.ts "$OUT/manifest.json" > "$WORK/SHA256SUMS.txt"
while read -r _sha f; do
  [ -z "$f" ] && continue
  printf '  · %s\n' "$f"
  "$OSSBIN" cp -f --region "$OSS_REGION" "${PREFIX}/${f}" "${LDIR}/${f}"
done < <(grep -v '^#' "$WORK/SHA256SUMS.txt")
"$OSSBIN" cp -f --region "$OSS_REGION" \
  --cache-control "no-cache" "$WORK/SHA256SUMS.txt" "${LDIR}/SHA256SUMS.txt"

# 探针 A（只用 GetObject）：latest/SHA256SUMS.txt 必须与本地生成的那份逐字节相同
"$OSSBIN" cp -f --region "$OSS_REGION" "${LDIR}/SHA256SUMS.txt" "$WORK/latest-SHA256SUMS.txt"
cmp -s "$WORK/SHA256SUMS.txt" "$WORK/latest-SHA256SUMS.txt" \
  || die "latest/SHA256SUMS.txt 与本地生成的不一致"
echo "  ✓ latest/SHA256SUMS.txt 与本地逐字节一致"

# 探针 B（零鉴权，走用户真实路径）：公网 CDN 上 releases 与 latest 的 ETag+长度必须一致
cdn_head() {  # $1 = 以 / 开头的路径 → "<etag> <content-length>"，取不到则空串
  { curl -fsS -I --max-time 30 "${DIST_BASE}$1?v=${VERSION}" 2>/dev/null || true; } \
    | tr -d '\r' \
    | awk 'tolower($1)=="etag:"{e=$2} tolower($1)=="content-length:"{l=$2} END{printf "%s %s", e, l}'
}
while read -r _sha f; do
  [ -z "$f" ] && continue
  a=$(cdn_head "/releases/v${VERSION}/${f}" || true); b=$(cdn_head "/latest/${f}" || true)
  if [ -z "$a" ] || [ -z "$b" ]; then
    sleep 2
    a=$(cdn_head "/releases/v${VERSION}/${f}" || true); b=$(cdn_head "/latest/${f}" || true)
  fi
  [ -n "$b" ] && [ "$a" = "$b" ] \
    || die "latest/${f} 与 releases/v${VERSION}/${f} 不同源（${a:-空} vs ${b:-空}）"
  echo "  ✓ ${f}  ${a}"
done < <(grep -v '^#' "$WORK/SHA256SUMS.txt")

# 探针 C（零下载）：证实「发出去的字节 == 构建出来的字节」——本地 md5 对线上 ETag
# （单段 PUT 对象的 ETag 即内容 MD5；分段上传会带 `-N` 后缀，那时明确跳过而不是假装通过）
while read -r _sha f; do
  [ -z "$f" ] && continue
  p="$ART/$f"
  [ -f "$p" ] || die "本地 $ART 里找不到 ${f}"
  lm=$(md5sum "$p" | cut -d' ' -f1 | tr 'a-f' 'A-F')
  rt=$(cdn_head "/latest/${f}" | awk '{print $1}' | tr -d '"')
  case "$rt" in
    ""|-*) echo "  ! ${f} 远端 ETag 不可作 MD5 比对（${rt:-空}），跳过"; continue ;;
  esac
  [ "$lm" = "$rt" ] || die "${f} 构建件 md5 ${lm} ≠ 线上 ETag ${rt}"
  echo "  ✓ ${f}  md5=${lm}"
done < <(grep -v '^#' "$WORK/SHA256SUMS.txt")
echo "✓ latest/ 已指向 v$VERSION"

say "完成"
echo "v$VERSION 已发布。"
echo "提醒：若 CDN 的 /channels/ 或 /latest/ 缓存规则不是「不缓存」，请到 CDN 控制台刷新，"
echo "      否则客户端可能仍取到旧清单、官网可能仍指向旧版（被缓存住 = 通道静默冻结）。"
