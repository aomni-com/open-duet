#!/usr/bin/env bash
# Roll a stuck staging VM's gateway forward to the deployed release so it can
# sync again and receive the four service-proxy skills + slice 05/06 wiring.
#
# WHY: the VM's gateway (0.0.0+253f9715) predates the `skills` sync field and
# its .strict() parser rejects the current sync response before it can act on
# the new gatewayRelease — a self-update catch-22 (landmine L1). The deployed
# api already announces a fixed gateway (0.0.0+222f45843508) that parses
# `skills`; this script installs it manually. Safe on staging (disposable);
# `previous` symlink is preserved for rollback.
#
# Run:  ssh service.example.invalid 'bash -s' < unblock-staging-vm.sh
# (or paste the body into an SSH session on the VM)
set -euo pipefail

VMTOKEN=$(cat ~/.duet/vm-token | tr -d '[:space:]')
API=https://service.example.invalid
VER=0.0.0+222f45843508
DIR=/opt/duet/releases/$VER
ISHA=222f45843508c910a2ff3a1c2964731c946a045594f387b5a049b34632b5be0f
HSHA=fbb0f0f148ad558b96fadf284cec92b459523d297c1ca61ca2b86a9b8b8e13ef

sudo mkdir -p "$DIR"
sudo curl -fsS -H "Authorization: Bearer $VMTOKEN" "$API/v1/vm/gateway-release" -o "$DIR/index.js"
sudo curl -fsS -H "Authorization: Bearer $VMTOKEN" "$API/v1/vm/gateway-release/helper" -o "$DIR/helper.js"

GOT_I=$(sha256sum "$DIR/index.js" | cut -d' ' -f1)
GOT_H=$(sha256sum "$DIR/helper.js" | cut -d' ' -f1)
[ "$GOT_I" = "$ISHA" ] || { echo "ABORT: index.js sha mismatch ($GOT_I)"; exit 1; }
[ "$GOT_H" = "$HSHA" ] || { echo "ABORT: helper.js sha mismatch ($GOT_H)"; exit 1; }

printf '{\n  "version": "%s",\n  "sha256": "%s",\n  "helperSha256": "%s"\n}\n' \
  "$VER" "$ISHA" "$HSHA" | sudo tee "$DIR/manifest.json" >/dev/null
sudo chmod +x "$DIR/index.js" "$DIR/helper.js"

sudo ln -sfn "$(readlink /opt/duet/current)" /opt/duet/previous
sudo ln -sfn "$DIR" /opt/duet/current
echo "current -> $(readlink /opt/duet/current)"
sudo systemctl restart duet-gateway.service
sleep 8
echo "=== recent sync status (expect success, no 'unrecognized_keys skills'):"
tail -n 5 ~/.duet/logs/*.log 2>/dev/null | grep -i vm_sync | tail -3
