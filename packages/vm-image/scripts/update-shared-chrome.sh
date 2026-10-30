#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo 'usage: update-shared-chrome VERSION SHA256' >&2
  exit 64
fi
version="${1:-}"
expected_sha256="${2:-}"
if [[ ! "$version" =~ ^([0-9]+\.){3}[0-9]+-[0-9]+$ ]]; then
  echo 'invalid Chrome version' >&2
  exit 64
fi
if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'invalid Chrome SHA-256' >&2
  exit 64
fi

deb="$(mktemp /tmp/duet-google-chrome-stable.XXXXXX.deb)"
# Google's package maintainer recreates its autonomous update rail and stock
# launchers on every install. Keep updates deliberate and preserve the one
# image-owned browser identity that Plank uses for pinned/running merging.
remove_google_generated_files() {
  rm -f \
    /etc/apt/sources.list.d/google-chrome.list \
    /etc/apt/sources.list.d/google-chrome.sources \
    /etc/cron.daily/google-chrome \
    /opt/google/chrome/cron/google-chrome \
    /usr/share/applications/com.google.Chrome.desktop \
    /usr/share/applications/google-chrome.desktop \
    /usr/share/applications/xfce4-web-browser.desktop
}
cleanup() {
  rm -f "$deb"
  remove_google_generated_files
  apt-mark hold google-chrome-stable >/dev/null 2>&1 || true
  rm -rf /var/lib/apt/lists/*
}
trap cleanup EXIT

url="https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb"
curl -fsSL -o "$deb" "$url"
echo "$expected_sha256  $deb" | sha256sum -c -

apt-mark unhold google-chrome-stable
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$deb"

installed_version="$(dpkg-query -W -f='${Version}' google-chrome-stable)"
if [[ "$installed_version" != "$version" ]]; then
  echo "installed Chrome $installed_version, expected $version" >&2
  exit 1
fi
apt-mark hold google-chrome-stable
