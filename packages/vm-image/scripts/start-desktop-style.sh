#!/usr/bin/env bash
set -euo pipefail

dock_settings='net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/'
gsettings set "$dock_settings" theme 'WhiteSur'
gsettings set "$dock_settings" icon-size 48
gsettings set "$dock_settings" position 'bottom'
gsettings set "$dock_settings" alignment 'center'
gsettings set "$dock_settings" hide-mode 'none'
gsettings set "$dock_settings" zoom-enabled true
gsettings set "$dock_settings" zoom-percent 120
gsettings set "$dock_settings" auto-pinning false
gsettings set "$dock_settings" dock-items "['catfish.dockitem', 'thunar.dockitem', 'xfce4-terminal.dockitem', 'duet-browser.dockitem', 'xfce-settings-manager.dockitem']"

/usr/bin/devilspie2 --folder /home/exedev/.config/devilspie2 &
exec /usr/bin/plank --name dock1
