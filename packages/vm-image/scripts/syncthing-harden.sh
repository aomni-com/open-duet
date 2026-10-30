#!/usr/bin/env bash
# Syncthing pre-listen hardening (spec file-attribution slice 19, MAP-SYNC V2).
# Runs as the duet-syncthing.service ExecStartPre, BEFORE Syncthing's first
# listen, so the L20 first-boot window (a fresh VM phoning discovery/relays/NAT
# before the gateway reconciles) never exists. Generates identity + config on a
# fresh home, then writes the full isolation set into config.xml. The gateway
# boot-reconciles the same options via REST as the semantic owner; this script
# only has to make the FIRST listen safe. Idempotent.
set -euo pipefail

HOME_DIR="${1:-/home/exedev/.duet/syncthing}"
mkdir -p "$HOME_DIR"

CONFIG="$HOME_DIR/config.xml"
if [ ! -f "$CONFIG" ]; then
  # `generate` creates the device key/cert + config.xml without starting a
  # listener (the gateway provisions the whole-drive mirror folder on demand).
  syncthing generate --home="$HOME_DIR" >/dev/null 2>&1
fi

# Patch config.xml to the hardened isolation set. python3 ships in the image;
# ElementTree edits the XML in place robustly (sed on XML is brittle).
python3 - "$CONFIG" <<'PY'
import sys
import xml.etree.ElementTree as ET

path = sys.argv[1]
tree = ET.parse(path)
root = tree.getroot()

options = root.find('options')
if options is None:
    options = ET.SubElement(root, 'options')

def set_option(name, value):
    el = options.find(name)
    if el is None:
        el = ET.SubElement(options, name)
    el.text = value

for name, value in [
    ('globalAnnounceEnabled', 'false'),
    ('localAnnounceEnabled', 'false'),
    ('relaysEnabled', 'false'),
    ('natEnabled', 'false'),
    ('crashReportingEnabled', 'false'),
    ('urAccepted', '-1'),
    ('autoUpgradeIntervalH', '0'),
]:
    set_option(name, value)

# Loopback-only listener: strip every listenAddress, then one loopback entry.
for el in options.findall('listenAddress'):
    options.remove(el)
ET.SubElement(options, 'listenAddress').text = 'tcp://127.0.0.1:22000'

gui = root.find('gui')
if gui is not None:
    address = gui.find('address')
    if address is None:
        address = ET.SubElement(gui, 'address')
    address.text = '127.0.0.1:8384'

tree.write(path, xml_declaration=True, encoding='UTF-8')
PY
