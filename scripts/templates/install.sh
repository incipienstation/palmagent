#!/bin/sh
# Palmagent standalone CLI bootstrap. Service and ingress setup belong to the operator plugin.
set -eu
umask 077
origin='@RELEASE_ORIGIN@'
repository='@REPOSITORY_URL@'
trust='@RELEASE_TRUST@'
fail() { printf '%s\n' "Palmagent: $*" >&2; exit 1; }
channel=''; version=''; prefix=''; data_dir=''; print_path=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel|--to|--prefix|--data-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in --channel) channel=$2;; --to) version=$2;; --prefix) prefix=$2;; --data-dir) data_dir=$2;; esac
      shift 2;;
    --print-path) print_path=true; shift;;
    --help) printf '%s\n' 'Usage: install.sh [--channel stable|preview] [--to VERSION] [--prefix ABSOLUTE_DIR] [--data-dir ABSOLUTE_DIR] [--print-path]'; exit 0;;
    *) fail "unknown option: $1";;
  esac
done
[ "$(uname -s)" = Linux ] || fail 'standalone currently requires Linux'
case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail 'unsupported CPU architecture';; esac
for tool in curl tar jq openssl sha256sum base64 getconf mktemp readlink diff; do command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"; done
case "$(openssl version)" in 'OpenSSL 3.'*) ;; *) fail 'OpenSSL 3 is required for release signature verification';; esac
glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'glibc is required; musl is not supported'
case "$glibc" in 'glibc '*) glibc=${glibc#glibc };; *) fail 'could not identify glibc';; esac
target="linux-$arch-glibc"
config_home=${PALMAGENT_HOME:-"$HOME/.palmagent"}
case "$config_home" in /*) ;; *) fail 'PALMAGENT_HOME must be absolute';; esac
if [ -e "$config_home/config.json" ] || [ -L "$config_home/config.json" ]; then
  [ -f "$config_home/config.json" ] && [ ! -L "$config_home/config.json" ] || fail 'saved settings must be a regular file'
  saved_channel=$(jq -er 'select(.schemaVersion == 1) | .channel | select(. == "stable" or . == "preview")' "$config_home/config.json") || fail 'invalid saved channel settings'
  [ -n "$channel" ] || channel=$saved_channel
elif [ -n "$data_dir" ] && [ -f "$data_dir/install.env" ]; then
  # Only the old channel key is read; an env file is never executed as shell code.
  legacy_channel=$(sed -n 's/^RELEASE_CHANNEL=//p' "$data_dir/install.env")
  if [ -n "$legacy_channel" ]; then [ -n "$channel" ] || channel=$legacy_channel
  elif [ -z "$channel" ]; then fail 'existing installation has no saved channel; pass its verified channel explicitly'; fi
fi
channel=${channel:-stable}
case "$channel" in stable|preview) ;; *) fail 'channel must be stable or preview';; esac
if [ -n "$version" ]; then
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$' || fail 'invalid exact version'
fi
install_link=true
if [ -n "$prefix" ]; then install_link=false; else prefix="$config_home/cli"; fi
case "$prefix" in /*) ;; *) fail 'prefix must be absolute';; esac
[ ! -L "$prefix" ] || fail 'prefix cannot be a symbolic link'
[ ! -L "$prefix/releases" ] || fail 'release directory cannot be a symbolic link'
mkdir -p "$prefix/releases"
chmod 700 "$prefix" "$prefix/releases"
scratch=$(mktemp -d "$prefix/.download.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
printf '%s\n' "$trust" > "$scratch/trust.json"
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 600 --max-filesize "$3" --output "$2" --url "$1" || fail 'download failed'
  [ "$(wc -c < "$2")" -le "$3" ] || fail 'download exceeds the size limit'
}
verify_document() {
  file=$1; payload=$2
  jq -er 'select(.schemaVersion == 1 and (.signatures|type == "array") and (.signatures|length > 0 and length <= 8)) | .payload' "$file" | base64 -d > "$payload" || fail 'invalid signed document'
  verified=false
  for key_id in $(jq -r '.keys | keys[]' "$scratch/trust.json"); do
    jq -er --arg key "$key_id" '.keys[$key]' "$scratch/trust.json" > "$scratch/public.pem"
    signature=$(jq -r --arg key "$key_id" '[.signatures[] | select(.keyId == $key) | .signature][0] // empty' "$file")
    [ -n "$signature" ] || continue
    printf '%s' "$signature" | base64 -d > "$scratch/signature" || fail 'invalid signature encoding'
    if openssl pkeyutl -verify -pubin -inkey "$scratch/public.pem" -rawin -in "$payload" -sigfile "$scratch/signature" >/dev/null 2>&1; then verified=true; break; fi
  done
  [ "$verified" = true ] || fail 'release signature is not trusted'
}
manifest_hash=''
if [ -z "$version" ]; then
  download "$origin/channels/$channel.json" "$scratch/channel.json" 2097152
  verify_document "$scratch/channel.json" "$scratch/channel-payload.json"
  version=$(jq -er --arg channel "$channel" 'select(.schemaVersion == 1 and .channel == $channel and .revision > 0) | .version' "$scratch/channel-payload.json") || fail 'invalid channel identity'
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$' || fail 'invalid channel version'
  manifest_hash=$(jq -er '.releaseManifestSha256 | select(test("^[a-f0-9]{64}$"))' "$scratch/channel-payload.json") || fail 'invalid manifest checksum'
  [ "$(jq -r '.releaseManifestUrl' "$scratch/channel-payload.json")" = "$repository/releases/download/v$version/standalone.json" ] || fail 'channel points outside the official release'
fi
case "$channel:$version" in stable:*-*) fail 'Stable cannot install a prerelease';; esac
download "$repository/releases/download/v$version/standalone.json" "$scratch/manifest.json" 2097152
if [ -n "$manifest_hash" ]; then [ "$(sha256sum "$scratch/manifest.json" | cut -d' ' -f1)" = "$manifest_hash" ] || fail 'manifest checksum mismatch'; fi
verify_document "$scratch/manifest.json" "$scratch/manifest-payload.json"
jq -e --arg version "$version" 'select(.schemaVersion == 1 and .version == $version and .pluginTag == ("v" + $version))' "$scratch/manifest-payload.json" >/dev/null || fail 'release identity mismatch'
jq -e --arg target "$target" '[.artifacts[] | select(.target == $target)] | select(length == 1) | .[0]' "$scratch/manifest-payload.json" > "$scratch/artifact.json" || fail 'release does not support this platform'
filename="palmagent-$version-$target.tar.gz"
[ "$(jq -r '.filename' "$scratch/artifact.json")" = "$filename" ] || fail 'invalid artifact name'
[ "$(jq -r '.url' "$scratch/artifact.json")" = "$repository/releases/download/v$version/$filename" ] || fail 'artifact points outside the official release'
hash=$(jq -er '.sha256 | select(test("^[a-f0-9]{64}$"))' "$scratch/artifact.json") || fail 'invalid archive checksum'
size=$(jq -er '.size | select(type == "number" and floor == . and . > 0 and . <= 536870912)' "$scratch/artifact.json") || fail 'invalid archive size'
unpacked=$(jq -er '.unpackedSize | select(type == "number" and floor == . and . > 0 and . <= 2147483648)' "$scratch/artifact.json") || fail 'invalid unpacked size'
minimum=$(jq -er '.minGlibc | select(test("^[0-9]+\\.[0-9]+$"))' "$scratch/artifact.json") || fail 'invalid glibc requirement'
awk -v actual="$glibc" -v minimum="$minimum" 'BEGIN { split(actual,a,"."); split(minimum,b,"."); exit !(a[1]>b[1] || (a[1]==b[1] && a[2]>=b[2])) }' || fail "glibc $minimum or newer is required"
download "$repository/releases/download/v$version/$filename" "$scratch/archive.tar.gz" "$size"
[ "$(wc -c < "$scratch/archive.tar.gz")" -eq "$size" ] || fail 'archive size mismatch'
[ "$(sha256sum "$scratch/archive.tar.gz" | cut -d' ' -f1)" = "$hash" ] || fail 'archive checksum mismatch'
tar -tzf "$scratch/archive.tar.gz" > "$scratch/entries" || fail 'invalid archive'
awk 'BEGIN { ok=1 } { p=$0; sub(/\/$/,"",p); if (NR>100000 || p !~ /^palmagent(\/|$)/ || p ~ /(^|\/)\.\.?($|\/)/ || p ~ /\\/ || p ~ /[[:cntrl:]]/ || seen[p]++) ok=0 } END { exit !ok }' "$scratch/entries" || fail 'unsafe archive path'
tar -tvzf "$scratch/archive.tar.gz" --numeric-owner > "$scratch/types" || fail 'invalid archive metadata'
awk -v limit="$unpacked" 'BEGIN { ok=1 } { if ((substr($1,1,1)!="-" && substr($1,1,1)!="d") || $1 ~ /[sS]/) ok=0; total+=$3 } END { exit !(ok && total<=limit) }' "$scratch/types" || fail 'unsafe archive type or size'
mkdir "$scratch/extract"
tar -xzf "$scratch/archive.tar.gz" --no-same-owner --no-same-permissions -C "$scratch/extract"
bundle="$scratch/extract/palmagent"
jq -e --arg version "$version" --arg target "$target" 'select(.schemaVersion == 1 and .distribution == "standalone" and .version == $version and .target == $target)' "$bundle/bundle.json" >/dev/null || fail 'bundle identity mismatch'
for field in sourceCommit nodeVersion nodeAbi; do
  [ "$(jq -er --arg field "$field" '.[$field]' "$bundle/bundle.json")" = "$(jq -er --arg field "$field" '.[$field]' "$scratch/manifest-payload.json")" ] || fail "bundle $field mismatch"
done
[ "$(jq -er '.minGlibc' "$bundle/bundle.json")" = "$minimum" ] || fail 'bundle glibc requirement mismatch'
[ "$(PALMAGENT_CLI_FORWARDED=1 NODE_OPTIONS='' NODE_PATH='' "$bundle/runtime/bin/node" "$bundle/app/cli.js" --version)" = "$version" ] || fail 'candidate CLI failed to start'
NODE_OPTIONS='' NODE_PATH='' "$bundle/runtime/bin/node" --input-type=commonjs - "$bundle" <<'PROBE' || fail 'bundled runtime probe failed'
const { createRequire } = require('node:module');
const root = process.argv[2], req = createRequire(root + '/app/package.json');
const identity = req('../bundle.json'), info = req('./build-info.json');
if (process.versions.node !== identity.nodeVersion || process.versions.modules !== identity.nodeAbi ||
    info.version !== identity.version || info.sourceCommit !== identity.sourceCommit || info.dirty !== false) process.exit(1);
const db = new (req('better-sqlite3'))(':memory:'); db.prepare('select 1').get(); db.close();
const pty = req('node-pty').spawn('/bin/sh', ['-c', 'printf standalone-ready'], { env: process.env });
let output = ''; pty.onData(value => output += value);
const timeout = setTimeout(() => process.exit(1), 5000);
pty.onExit(({ exitCode }) => { clearTimeout(timeout); process.exit(exitCode || !output.includes('standalone-ready') ? 1 : 0); });
PROBE
release="$prefix/releases/$version-$target-$hash"
if [ -e "$release" ]; then
  [ ! -L "$release" ] && diff -qr "$bundle" "$release" >/dev/null || fail 'existing release differs'
else mv "$bundle" "$release"; fi
ln -s "$release" "$scratch/current"
mv -Tf "$scratch/current" "$prefix/current"
if [ "$install_link" = true ]; then
  mkdir -p "$HOME/.local/bin"
  cli="$HOME/.local/bin/palmagent"
  if [ -e "$cli" ] || [ -L "$cli" ]; then [ -L "$cli" ] && [ "$(readlink "$cli")" = "$prefix/current/bin/palmagent" ] || fail 'CLI path is already owned by another installation; use --prefix'; fi
  ln -s "$prefix/current/bin/palmagent" "$scratch/cli-link"
  mv -Tf "$scratch/cli-link" "$cli"
fi
if [ "$print_path" = true ]; then printf '%s\n' "$release/bin/palmagent"
else printf '%s\n' "Palmagent CLI $version installed: $release/bin/palmagent" 'Use the Palmagent operator plugin to install or update the application service.'; fi
